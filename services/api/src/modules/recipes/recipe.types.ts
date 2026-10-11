export interface RecipeSource {
  name: string
  url: string
  license: string
  commit: string
}

export interface Ingredient {
  name: string
  amount: string
}

export interface RecipeSummary {
  id: string
  name: string
  image: string | null
  category: string
  cuisine: string
  tags: string[]
  calories: number | null
  caloriesEstimated: boolean
}

export interface Recipe extends RecipeSummary {
  aliases: string[]
  spiciness: number
  ingredients: Ingredient[]
  steps: string[]
  notes: string[]
  videoUrl: string | null
  source: RecipeSource
}

export interface RecipeQuery {
  q?: string
  category?: string
  cuisine?: string
  page: number
  pageSize: number
}

export interface RecipePage {
  items: RecipeSummary[]
  total: number
  page: number
  pageSize: number
}

export interface RecipeFilters {
  categories: string[]
  cuisines: string[]
}

// New providers can implement this contract and replace the module token binding.
// Only the built-in database provider is configured at present.
export interface RecipeProvider {
  list(query: RecipeQuery): Promise<RecipePage>
  filters(): Promise<RecipeFilters>
  findById(id: string): Promise<Recipe | null>
}

export const RECIPE_PROVIDER = Symbol('RECIPE_PROVIDER')

export interface SeedRecipe extends Recipe {
  sourcePath: string
  rawMarkdown: string
  tools: string[]
}

export interface SeedBundle {
  version: 1
  repository: string
  commit: string
  license: string
  licenseUrl: string
  licenseText: string
  recipes: SeedRecipe[]
}
