import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { importRecipes, seedData } from '../src/modules/recipes/recipe.importer'
import { SeedBundle } from '../src/modules/recipes/recipe.types'
import { BuiltinRecipeProvider } from '../src/modules/recipes/builtin-recipe.provider'
import { PrismaService } from '../src/modules/recipes/prisma.service'

// Tests create independent temporary databases; the application's database is never used.
async function database(): Promise<PrismaClient> {
  const directory = await mkdtemp(join(tmpdir(), 'yushan-recipes-test-'))
  const client = new PrismaClient({ datasourceUrl: `file:${join(directory, 'test.db').replace(/\\/g, '/')}` })
  const sql = await readFile('prisma/migrations/20261011151646_recipes/migration.sql', 'utf8')
  for (const statement of sql.split(';').filter(s => s.trim())) await client.$executeRawUnsafe(statement)
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
