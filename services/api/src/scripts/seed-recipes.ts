import { ConfigModule } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import { readFile } from 'node:fs/promises'
import { importRecipes } from '../modules/recipes/recipe.importer'
import { SeedBundle } from '../modules/recipes/recipe.types'

async function main() {
  await ConfigModule.forRoot({ envFilePath: ['.env'] })
  const client = new PrismaClient()
  try {
    const bundle = JSON.parse(await readFile('seeds/howtocook.json', 'utf8')) as SeedBundle
    const result = await importRecipes(client, bundle)
    console.log(JSON.stringify({ ...result, total: await client.recipe.count(), commit: bundle.commit }))
  } finally { await client.$disconnect() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
