import { ConfigModule } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import { cleanDishName } from '../modules/recipes/sources/recipe-source'

/**
 * 把“入库时才生效”的菜名清理规则补用到历史行上（不调用任何外部接口，可反复执行）。
 *
 * 用途：`cleanDishName()` 是后来才加的，之前导入的行仍带着 `[原创首发]`、`【儿童美食】` 这类前缀；
 * 重跑一次导入虽然也能修正，但要再花一遍第三方接口调用次数，所以单独留这个脚本。
 * 只改 name 与 searchText，不动其它字段。
 */
async function main() {
  await ConfigModule.forRoot({ envFilePath: ['.env'] })
  const client = new PrismaClient()
  let changed = 0
  try {
    const rows = await client.recipe.findMany({ select: { id: true, name: true, searchText: true } })
    for (const row of rows) {
      const name = cleanDishName(row.name)
      if (name === row.name) continue
      // searchText 以菜名开头，同步替换同一段前缀，避免搜索与展示不一致
      const searchText = row.searchText.startsWith(row.name.toLowerCase())
        ? name.toLowerCase() + row.searchText.slice(row.name.length)
        : row.searchText
      await client.recipe.update({ where: { id: row.id }, data: { name, searchText } })
      console.log(`  ${row.name} → ${name}`)
      changed++
    }
    console.log(`\n共检查 ${rows.length} 道，修正 ${changed} 道`)
  } finally {
    await client.$disconnect()
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
