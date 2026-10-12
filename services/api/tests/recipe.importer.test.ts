import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { importRecipes, seedData } from '../src/modules/recipes/recipe.importer'
import { SeedBundle } from '../src/modules/recipes/recipe.types'
import { BuiltinRecipeProvider } from '../src/modules/recipes/builtin-recipe.provider'
import { PrismaService } from '../src/modules/recipes/prisma.service'

// 测试使用独立的 MySQL 测试库（cook_test），不碰应用库（cook）。
// 前置：MySQL 容器已启动（`docker compose up -d mysql`）——见 RUNBOOK R-007。
// 换 MySQL 前这里是"临时 SQLite 文件 + 灌迁移 SQL"，迁移改为 MySQL 方言后那条路不再可行。
const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'cook_test'
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? `mysql://root:cook_root_dev@127.0.0.1:3306/${TEST_DB_NAME}`
const ADMIN_URL = process.env.TEST_DB_ADMIN_URL ?? 'mysql://root:cook_root_dev@127.0.0.1:3306/mysql'

let schemaReady: Promise<void> | null = null

/** 建测试库并把提交里的迁移应用上去（与应用库同一份迁移，避免方言漂移） */
function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const admin = new PrismaClient({ datasourceUrl: ADMIN_URL })
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${TEST_DB_NAME}\``)
    } finally {
      await admin.$disconnect()
    }
    execFileSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'ignore',
    })
  })()
  return schemaReady
}

async function database(): Promise<PrismaClient> {
  await ensureSchema()
  const client = new PrismaClient({ datasourceUrl: TEST_DB_URL })
  // 每个用例从空表开始（迁移记录保留，不影响后续 deploy）
  await client.recipe.deleteMany({})
  await client.appMeta.deleteMany({})
  return client
}

async function seed(): Promise<SeedBundle> {
  return JSON.parse(await readFile('seeds/howtocook.json', 'utf8')) as SeedBundle
}

test('seed reruns preserve records and timestamps, and protect conflicting user recipes', async () => {
  const client = await database()
  try {
    const bundle = await seed()
    const firstRecipe = bundle.recipes[0]
    // Even a user record occupying a seed ID must survive untouched.
    await client.recipe.create({ data: { id: firstRecipe.id, ...seedData(firstRecipe), name: '我的原创', origin: 'user', sourceKey: null } })
    assert.deepEqual(await importRecipes(client, bundle), { imported: 27, skipped: 1 })
    const before = await client.recipe.findMany({ orderBy: { id: 'asc' } })
    assert.deepEqual(await importRecipes(client, bundle), { imported: 27, skipped: 1 })
    const after = await client.recipe.findMany({ orderBy: { id: 'asc' } })
    assert.deepEqual(after, before)
    assert.equal(after.find(row => row.id === firstRecipe.id)?.name, '我的原创')
    assert.equal(await client.recipe.count(), 28)
    const original = bundle.recipes[1]
    await importRecipes(client, { ...bundle, recipes: [{ ...original, name: '源菜谱更新' }] })
    assert.equal((await client.recipe.findUnique({ where: { id: original.id } }))?.name, '源菜谱更新')
  } finally { await client.$disconnect() }
})

test('all pinned recipes reparse exactly with category coverage and searchable provider results', async () => {
  const bundle = await seed()
  assert.equal(bundle.recipes.length, 28)
  assert.deepEqual([...new Set(bundle.recipes.map(r => r.category))].sort(), ['主食', '汤', '素菜', '荤菜'].sort())
  const { parseHowToCook } = await import('../src/modules/recipes/howtocook.parser')
  for (const recipe of bundle.recipes) {
    assert.deepEqual(parseHowToCook(recipe.rawMarkdown, recipe.sourcePath, bundle.commit), recipe)
    assert.ok(recipe.ingredients.every(i => i.name && i.amount))
    assert.ok(recipe.steps.length > 0)
    assert.ok(recipe.notes.some(note => note.includes('【计算】')))
  }
  const rice = bundle.recipes.find(r => r.name === '电饭煲蒸米饭')!
  assert.ok(rice.tools.includes('电饭煲'))
  assert.ok(!rice.ingredients.some(i => i.name === '电饭煲'))
  const client = await database()
  try {
    await importRecipes(client, bundle)
    const provider = new BuiltinRecipeProvider(client as PrismaService)
    const first = await provider.list({ page: 1, pageSize: 12 })
    const second = await provider.list({ page: 2, pageSize: 12 })
    assert.equal(first.total, 28)
    assert.equal(first.items.length, 12)
    assert.equal(second.items.length, 12)
    assert.ok(!first.items.some(r => second.items.some(s => s.id === r.id)))
    const target = bundle.recipes.find(r => r.name === '西红柿炒鸡蛋')!
    for (const q of ['西红柿炒', '番茄炒鸡', '鸡蛋', '酸甜']) assert.ok((await provider.list({ q, page: 1, pageSize: 100 })).items.some(r => r.id === target.id), q)
    assert.equal((await provider.list({ category: '素菜', cuisine: '家常', page: 1, pageSize: 12 })).total, 7)
    assert.equal((await provider.list({ q: '不存在的菜', page: 1, pageSize: 12 })).total, 0)
    assert.equal(await provider.findById('missing'), null)
    assert.deepEqual((await provider.findById(target.id))?.ingredients, target.ingredients)
    assert.equal((await provider.filters()).categories.length, 4)
  } finally { await client.$disconnect() }
})
