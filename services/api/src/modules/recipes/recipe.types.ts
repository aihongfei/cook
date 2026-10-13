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
  /**
   * 这道菜哪来的（F1-12，用户 2026-10-13：「自己上传的要和极速 api 的区分下」）。
   * `origin` 是机器判据（`user` = 自建，其余是导入源），`sourceLabel` 是给人看的话。
   */
  origin: string
  sourceLabel: string
  /** 是不是自己家的（= 能不能改）。前端据此决定画不画"编辑" */
  mine: boolean
}

export interface Recipe extends RecipeSummary {
  /** 谁上传的昵称（F1-12，自建才有；导入的菜谱为 null） */
  createdBy: string | null
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
  /** 只看自己家的（F1-12「我的菜谱」）；未登录时为 false */
  mine?: boolean
  /**
   * 当前登录者（可选）。列表要**既公开又私人**：匿名只看全局库，
   * 登录后额外带上自家自建的菜谱。由控制器从可选鉴权守卫里取来传下。
   */
  viewer?: { userId: string; familyId: string | null } | null
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
  findById(id: string, viewer?: { userId: string; familyId: string | null } | null): Promise<Recipe | null>
}

export const RECIPE_PROVIDER = Symbol('RECIPE_PROVIDER')

/**
 * 导入用的种子形状（HowToCook 解析产物）。
 *
 * 刻意 `Omit` 掉那几个**视图字段**（origin / sourceLabel / mine / createdBy）：
 * 它们回答的是"这条菜谱对当前这个人意味着什么"（哪来的、是不是他自己的、能不能改），
 * 而种子是数据本身，与"谁在看"无关。让种子直接继承一整套视图字段的话，
 * 解析器就得凭空填四个它根本不知道的值——本轮第一版就是这么红的。
 */
export interface SeedRecipe extends Omit<Recipe, 'origin' | 'sourceLabel' | 'mine' | 'createdBy'> {
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
