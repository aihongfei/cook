import { Injectable } from '@nestjs/common'
import { Prisma, Recipe as RecipeRow } from '@prisma/client'
import { Ingredient, Recipe, RecipeFilters, RecipePage, RecipeProvider, RecipeQuery, RecipeSource, RecipeSummary } from './recipe.types'
import { PrismaService } from './prisma.service'

function summary(row: RecipeRow): RecipeSummary {
  return { id: row.id, name: row.name, image: row.image, category: row.category, cuisine: row.cuisine,
    tags: row.tags as string[], calories: row.calories, caloriesEstimated: row.caloriesEstimated }
}

@Injectable()
export class BuiltinRecipeProvider implements RecipeProvider {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: RecipeQuery): Promise<RecipePage> {
    const where: Prisma.RecipeWhereInput = {
      ...(query.category ? { category: query.category } : {}),
      ...(query.cuisine ? { cuisine: query.cuisine } : {}),
      ...(query.q ? { AND: query.q.toLowerCase().split(/\s+/).map(term => ({ searchText: { contains: term } })) } : {}),
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recipe.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.recipe.count({ where }),
    ])
    return { items: rows.map(summary), total, page: query.page, pageSize: query.pageSize }
  }

  async filters(): Promise<RecipeFilters> {
    const rows = await this.prisma.recipe.findMany({ select: { category: true, cuisine: true } })
    return { categories: [...new Set(rows.map(row => row.category))].sort(), cuisines: [...new Set(rows.map(row => row.cuisine))].sort() }
  }

  async findById(id: string): Promise<Recipe | null> {
    const row = await this.prisma.recipe.findUnique({ where: { id } })
    if (!row) return null
    return { ...summary(row), aliases: row.aliases as string[], spiciness: row.spiciness,
      ingredients: row.ingredients as unknown as Ingredient[], steps: row.steps as string[], notes: row.notes as string[],
      videoUrl: row.videoUrl, source: row.source as unknown as RecipeSource }
  }
}
