import { ConfigModule } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import { importSourceRecipes } from '../modules/recipes/recipe.importer'
import { RecipeSourceAdapter, toIngestRow } from '../modules/recipes/sources/recipe-source'
import { uapisSource } from '../modules/recipes/sources/uapis.source'
import { jumdataSource } from '../modules/recipes/sources/jumdata.source'
import { jisuSource } from '../modules/recipes/sources/jisu.source'

/** 已接入的外部数据源（新增源时在此登记） */
const SOURCES: Record<string, RecipeSourceAdapter> = {
  [uapisSource.key]: uapisSource,
  [jumdataSource.key]: jumdataSource,
  [jisuSource.key]: jisuSource,
}

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function args(name: string): string[] {
  const value = arg(name)
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : []
}

async function main() {
  await ConfigModule.forRoot({ envFilePath: ['.env'] })

  const sourceKey = arg('source', 'uapis')!
  const adapter = SOURCES[sourceKey]
  if (!adapter) throw new Error(`未知数据源 "${sourceKey}"，可用：${Object.keys(SOURCES).join(', ')}`)

  if (adapter.apiKeyEnv && !process.env[adapter.apiKeyEnv]) {
    throw new Error(`数据源 ${adapter.name} 需要 ${adapter.apiKeyEnv}，请写进 services/api/.env（不要提交、不要贴进对话）`)
  }

  const keywords = args('keywords')
  const categories = args('categories')
  if (!keywords.length && !categories.length) {
    throw new Error(
      '用法：pnpm run import:recipes -- --keywords=番茄炒蛋,红烧排骨 [--limit=5] [--source=uapis]\n' +
        '      或按分类批量建库：pnpm run import:recipes -- --source=jisu --categories=all [--limit=50]',
    )
  }
  const limit = Number(arg('limit', '5'))
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit 必须是正整数')

  console.log(`数据源：${adapter.name}\n许可：${adapter.license}`)

  const client = new PrismaClient()
  let imported = 0
  let skipped = 0
  try {
    if (keywords.length) {
      console.log(`关键词：${keywords.join('、')}（每词最多 ${limit} 条）\n`)
      for (const keyword of keywords) {
        const recipes = await adapter.search(keyword, limit)
        const result = await importSourceRecipes(client, recipes.map(recipe => toIngestRow(adapter, recipe)))
        imported += result.imported
        skipped += result.skipped
        console.log(`  ${keyword}：取回 ${recipes.length} 条 → 入库 ${result.imported}，跳过 ${result.skipped}`)
      }
    }

    if (categories.length) {
      if (!adapter.listCategories || !adapter.enumerate) {
        throw new Error(`数据源 ${adapter.name} 不支持按分类枚举，请改用 --keywords`)
      }
      const tree = await adapter.listCategories()
      const wanted =
        categories[0] === 'all'
          ? tree.flatMap(node => [{ id: node.id, name: node.name }, ...node.children.map(child => ({ id: child.id, name: `${node.name}/${child.name}` }))])
          : categories.map(id => {
              const hit = tree.find(node => node.id === id) ?? tree.flatMap(node => node.children).find(child => child.id === id)
              if (!hit) throw new Error(`分类 ${id} 不在 ${adapter.name} 的分类树中`)
              return { id: hit.id, name: hit.name }
            })
      console.log(`分类：共 ${wanted.length} 个（每类最多 ${limit} 条）\n`)
      for (const category of wanted) {
        const recipes = await adapter.enumerate(category.id, limit)
        const result = await importSourceRecipes(client, recipes.map(recipe => toIngestRow(adapter, recipe)))
        imported += result.imported
        skipped += result.skipped
        console.log(`  ${category.name}（${category.id}）：取回 ${recipes.length} 条 → 入库 ${result.imported}，跳过 ${result.skipped}`)
      }
    }

    const total = await client.recipe.count()
    const byOrigin = await client.recipe.groupBy({ by: ['origin'], _count: { _all: true } })
    const withImage = await client.recipe.count({ where: { NOT: { image: null } } })
    console.log(`\n合计：入库 ${imported}，跳过 ${skipped}；库内共 ${total} 道（有图 ${withImage} 道）`)
    console.log(`按来源：${byOrigin.map(row => `${row.origin}=${row._count._all}`).join('，')}`)
  } finally {
    await client.$disconnect()
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
