import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
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
