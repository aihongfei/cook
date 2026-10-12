import { Prisma, PrismaClient } from '@prisma/client'
import { SeedBundle, SeedRecipe } from './recipe.types'

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue }

export function seedData(recipe: SeedRecipe) {
  return {
    name: recipe.name, image: recipe.image, category: recipe.category, cuisine: recipe.cuisine,
    aliases: json(recipe.aliases), tags: json(recipe.tags), calories: recipe.calories,
    caloriesEstimated: recipe.caloriesEstimated, spiciness: recipe.spiciness,
    ingredients: json(recipe.ingredients), steps: json(recipe.steps), notes: json(recipe.notes),
    tools: json(recipe.tools), videoUrl: recipe.videoUrl, source: json(recipe.source),
    origin: 'howtocook', sourceKey: `howtocook:${recipe.sourcePath}`,
    sourcePath: recipe.sourcePath, rawMarkdown: recipe.rawMarkdown,
    searchText: [recipe.name, ...recipe.aliases, ...recipe.tags, ...recipe.ingredients.map(i => i.name)].join('\n').toLowerCase(),
  }
}

export function validateBundle(bundle: SeedBundle): void {
  if (bundle.version !== 1 || bundle.license !== 'Unlicense' || !/^[a-f0-9]{40}$/.test(bundle.commit)) throw new Error('Invalid seed provenance')
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const recipe of bundle.recipes) {
    if (!recipe.id.startsWith('htc-') || ids.has(recipe.id) || paths.has(recipe.sourcePath) || !recipe.name || !recipe.ingredients.length || !recipe.steps.length || !recipe.rawMarkdown || recipe.source.commit !== bundle.commit || recipe.source.license !== bundle.license) throw new Error(`Invalid seed recipe: ${recipe.id}`)
    ids.add(recipe.id)
    paths.add(recipe.sourcePath)
  }
}

/**
 * 规范化 JSON：递归排序对象键后再序列化。
 *
 * 为什么不能直接用 JSON.stringify：**MySQL 的 JSON 列不保留对象键的插入顺序**（按键名重排），
 * 从库里读回来的对象与种子数据里的对象键序不同，字符串比较会误判为"内容有变"，
 * 于是重跑导入会走 upsert 分支、把 updatedAt 改掉，破坏"重复导入不改动记录"的幂等保证。
 * （SQLite 以文本存 JSON，键序原样保留，所以换库前不会暴露这个问题。）
 * 数组顺序在 MySQL 里是保留的，故数组按原序比较。
 */
export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** 一条待入库的菜谱：id + 归属（origin/sourceKey）+ 完整字段负载 */
export interface IngestRow {
  id: string
  origin: string
  sourceKey: string
  data: Record<string, unknown>
}

/**
 * 共用写入逻辑：HowToCook 种子与外部 API 数据源都走这里，保证幂等与冲突保护口径一致。
 * - 已存在但 origin/sourceKey 不同（用户自建或来自别的源）→ 跳过，绝不覆盖
 * - 内容完全一致 → 跳过，不触碰 updatedAt（幂等）
 */
async function upsertAll(tx: Prisma.TransactionClient, rows: IngestRow[]): Promise<{ imported: number; skipped: number }> {
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const existing = await tx.recipe.findFirst({ where: { OR: [{ id: row.id }, { sourceKey: row.sourceKey }] } })
    if (existing && (existing.origin !== row.origin || existing.sourceKey !== row.sourceKey)) { skipped++; continue }
    const identical = existing && Object.entries(row.data).every(([key, value]) => canonicalJson(existing[key as keyof typeof existing]) === canonicalJson(value))
    if (identical) { imported++; continue }
    await tx.recipe.upsert({
      where: { id: existing?.id ?? row.id },
      create: { id: row.id, ...row.data } as never,
      update: (existing ? { ...row.data, updatedAt: existing.updatedAt } : row.data) as never,
    })
    imported++
  }
  return { imported, skipped }
}

export async function importRecipes(client: PrismaClient, bundle: SeedBundle): Promise<{ imported: number; skipped: number }> {
  validateBundle(bundle)
  const rows: IngestRow[] = bundle.recipes.map(recipe => ({
    id: recipe.id,
    origin: 'howtocook',
    sourceKey: `howtocook:${recipe.sourcePath}`,
    data: seedData(recipe) as unknown as Record<string, unknown>,
  }))
  return client.$transaction(tx => upsertAll(tx, rows), { timeout: 30000 })
}

/** 导入外部数据源（聚合数据 / uapis 等）的菜谱 */
export async function importSourceRecipes(client: PrismaClient, rows: IngestRow[]): Promise<{ imported: number; skipped: number }> {
  if (!rows.length) return { imported: 0, skipped: 0 }
  return client.$transaction(tx => upsertAll(tx, rows), { timeout: 120000 })
}
