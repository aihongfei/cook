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

export async function importRecipes(client: PrismaClient, bundle: SeedBundle): Promise<{ imported: number; skipped: number }> {
  validateBundle(bundle)
  return client.$transaction(async tx => {
    let imported = 0
    let skipped = 0
    for (const recipe of bundle.recipes) {
      const data = seedData(recipe)
      const existing = await tx.recipe.findFirst({ where: { OR: [{ id: recipe.id }, { sourceKey: data.sourceKey }] } })
      // A conflicting user record is never reclassified or overwritten by the importer.
      if (existing && (existing.origin !== 'howtocook' || existing.sourceKey !== data.sourceKey)) { skipped++; continue }
      // Identical imports do not touch updatedAt, making reruns genuinely idempotent.
      if (existing && Object.entries(data).every(([key, value]) => JSON.stringify(existing[key as keyof typeof existing]) === JSON.stringify(value))) { imported++; continue }
      await tx.recipe.upsert({
        where: { id: existing?.id ?? recipe.id },
        create: { id: recipe.id, ...data }, update: data,
      })
      imported++
    }
    return { imported, skipped }
  }, { timeout: 30000 })
}
