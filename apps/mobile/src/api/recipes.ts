import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { randomIndex } from '@/pages/discover/random-sample'
import { apiClient } from './client'

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
  ingredients: { name: string; amount: string }[]
  steps: string[]
  notes: string[]
  videoUrl: string | null
  source: { name: string; url: string; license: string; commit: string }
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

export interface RecipeSearch {
  q?: string
  category?: string
  cuisine?: string
}

export async function fetchRecipes(
  search: RecipeSearch = {},
  page = 1,
  signal?: AbortSignal,
): Promise<RecipePage> {
  const { data } = await apiClient.get<RecipePage>('/recipes', {
    params: {
      q: search.q?.trim() || undefined,
      category: search.category || undefined,
      cuisine: search.cuisine || undefined,
      page,
      pageSize: 12,
    },
    signal,
  })
  return data
}

export async function fetchRecipeFilters(signal?: AbortSignal): Promise<RecipeFilters> {
  const { data } = await apiClient.get<RecipeFilters>('/recipes/filters', { signal })
  return data
}

export async function fetchRecipe(id: string, signal?: AbortSignal): Promise<Recipe> {
  const { data } = await apiClient.get<Recipe>(`/recipes/${encodeURIComponent(id)}`, { signal })
  return data
}

/**
 * 随机挑一道菜（F5-01 的最小形态：先问总数，再取其中一条）。
 *
 * 为什么不在后端加个 `/recipes/random`：那要为省一次请求多加一个接口与一套断言；
 * 列表接口本来就回 `total`，两次请求（总数 + 目标页）在家庭应用里够了。
 * 先取第一页是**顺手**的：命中第 1 页时连第二次请求都不用发。
 *
 * 返回 null = "库里一道菜都没有"。那是正常状态而不是异常，由界面去说。
 */
export async function fetchRandomRecipe(signal?: AbortSignal): Promise<RecipeSummary | null> {
  const first = await fetchRecipes({}, 1, signal)
  const index = randomIndex(first.total)
  if (index < 0) return null
  const page = Math.floor(index / first.pageSize) + 1
  const target = page === 1 ? first : await fetchRecipes({}, page, signal)
  return target.items[index - (page - 1) * first.pageSize] ?? null
}

export function useRecipeFilters() {
  return useQuery({
    queryKey: ['recipes', 'filters'],
    queryFn: ({ signal }) => fetchRecipeFilters(signal),
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export function useRecipes(search: RecipeSearch) {
  return useInfiniteQuery({
    queryKey: ['recipes', 'list', search.q || '', search.category || '', search.cuisine || ''],
    queryFn: ({ pageParam, signal }) => fetchRecipes(search, pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.items.length > 0 && lastPage.page * lastPage.pageSize < lastPage.total
        ? lastPage.page + 1
        : undefined,
    staleTime: 60_000,
    retry: 1,
  })
}

export function recipeErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    if (!error.response) return '暂时连不上厨房，请检查网络后重试。'
    if (error.response.status === 404) return '这道菜谱没有找到，去菜谱大全看看吧。'
    if (error.response.status === 401) return '当前请求未获授权，请稍后重试。'
  }
  return '菜谱暂时未能取回，请稍后重试。'
}

export function caloriesLabel(recipe: Pick<RecipeSummary, 'calories' | 'caloriesEstimated'>): string {
  if (recipe.calories === null) return '热量暂无'
  return `${recipe.caloriesEstimated ? '约 ' : ''}${recipe.calories} 千卡${recipe.caloriesEstimated ? '（估算）' : ''}`
}

export function recipeListUrl(search: RecipeSearch = {}): string {
  const params = new URLSearchParams()
  if (search.q?.trim()) params.set('q', search.q.trim())
  if (search.category) params.set('category', search.category)
  if (search.cuisine) params.set('cuisine', search.cuisine)
  const query = params.toString()
  return `/recipes${query ? `?${query}` : ''}`
}
