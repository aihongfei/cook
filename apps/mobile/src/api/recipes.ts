import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  /** 机器判据：`'user'` = 自家上传的，其余是导入来源（F1-12） */
  origin: string
  /** 给人看的来源名（后端翻好的中文/产品名），**界面直接显示它，不自己查表** */
  sourceLabel: string
  /** 是不是自己家的（= 能不能改） */
  mine: boolean
}

export interface Recipe extends RecipeSummary {
  /** 谁上传的昵称；导入的公共菜谱是 null */
  createdBy: string | null
  aliases: string[]
  spiciness: number
  ingredients: { name: string; amount: string }[]
  steps: string[]
  notes: string[]
  videoUrl: string | null
  source: { name: string; url: string; license: string; commit: string }
}

/**
 * 一份自建菜谱的可写字段（形状与 `POST /recipes` 的请求体逐字一致）。
 *
 * `aliases` 留在类型里但表单不编辑它：这两个字段由导入器/AI 写入，
 * 编辑时带上它反而会把别处写的别名覆盖掉（见 `updateRecipe` 的"只传传了的字段"）。
 */
export interface RecipeDraft {
  name: string
  category: string
  cuisine: string
  tags: string[]
  ingredients: { name: string; amount: string }[]
  steps: string[]
  notes: string[]
  calories: number | null
  aliases: string[]
  /**
   * 配图（dataURL，前端已经缩到最长边 1600px 再发）。
   *
   * **只在这次要换图时才带**：不带 = 保持原来那张不动。所以它是个"请求字段"、
   * 不是存储字段——后端收到后会上传到对象存储，把地址与 key 写进库
   * （见 `recipe-write.service` 的 `storeImage`）。
   */
  image?: string
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
  /** 只看自己家上传的（「我的菜谱」用）；未登录/没家庭时后端返回空列表 */
  mine?: boolean
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
      // 后端只认 '1'：传 false/0 会被当成"多了一个不认识的参数"而报 400，所以不筛时干脆不带
      mine: search.mine ? 1 : undefined,
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

/** 上传一道自己的菜谱（F1-12）。成功返回建好的那道（形状与详情接口一致） */
export async function createRecipe(draft: RecipeDraft): Promise<Recipe> {
  const { data } = await apiClient.post<Recipe>('/recipes', draft)
  return data
}

/**
 * 改一道自建菜谱。
 *
 * **只把真要改的字段放进 patch**：后端把 `undefined` 读作"没提，保持原样"，
 * 没改的字段跟着发一遍就等于把别处（AI 刚写的备注、别人补的配料）的内容覆盖回去。
 * 反过来说，`notes: []` 才是明确的"清空备注"——所以空列表要真的发出去，不能顺手过滤掉。
 */
export async function updateRecipe(id: string, patch: Partial<RecipeDraft>): Promise<Recipe> {
  const { data } = await apiClient.patch<Recipe>(`/recipes/${encodeURIComponent(id)}`, patch)
  return data
}

/** 删一道自建菜谱。后端回 `{id, name}`，名字用来在提示里说清删掉的是哪一道 */
export async function deleteRecipe(id: string): Promise<{ id: string; name: string }> {
  const { data } = await apiClient.delete<{ id: string; name: string }>(
    `/recipes/${encodeURIComponent(id)}`,
  )
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
    // `mine` 要进 key：不然「我的菜谱」与菜谱小书共用同一份缓存，两边会互相看见对方的条目
    queryKey: [
      'recipes',
      'list',
      search.q || '',
      search.category || '',
      search.cuisine || '',
      search.mine ? 'mine' : '',
    ],
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

/**
 * 写完一道菜要作废哪些缓存，**三处写操作共用**（少写一处就会出现"改了但翻回去还是旧的"）：
 * - `['recipes']` 前缀：列表（含「我的菜谱」那份带 mine 的）、详情、筛选分类、厨房推荐；
 * - `['favorites', 'list']` 与 `['combos']`：收藏页与常用组合里存的是菜名/图片的拷贝，
 *   删一道菜之后它们可能已经失效——这两处正是"删掉一道菜影响到的别的列表"。
 *
 * 收藏只作废**列表**，不动 `['favorites','status']`：那是列表页那一屏的心的开关状态，
 * 与"有哪些菜谱"无关，一起作废只会白掉一次请求（口径见 favorites.ts 里那段说明）。
 */
function invalidateRecipeViews(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['recipes'] })
  void queryClient.invalidateQueries({ queryKey: ['favorites', 'list'] })
  void queryClient.invalidateQueries({ queryKey: ['combos'] })
}

export function useCreateRecipe() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createRecipe,
    onSuccess: () => invalidateRecipeViews(queryClient),
  })
}

export function useUpdateRecipe() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<RecipeDraft> }) =>
      updateRecipe(id, patch),
    onSuccess: () => invalidateRecipeViews(queryClient),
  })
}

export function useDeleteRecipe() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteRecipe,
    onSuccess: () => invalidateRecipeViews(queryClient),
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
  if (search.mine) params.set('mine', '1')
  const query = params.toString()
  return `/recipes${query ? `?${query}` : ''}`
}
