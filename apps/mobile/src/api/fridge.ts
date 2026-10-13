import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 冰箱库存（M6 / F6-01~F6-05）。形态见 D-049：录入 = 手动 + 拍照（拍照那半待多模态模型）。
 *
 * 两个刻意的做法：
 * - **保质期那句话由后端算好**（`expiryLabel`）：前后端各算一遍必然有一边先改，
 *   而"今天到期"和"还有 1 天"这种话一旦不一致，用户会开始不信任它。
 * - **写操作用返回的整块板子刷新**（后端每个写接口都回 `board`）：冰箱内容少（几十条），
 *   返回整块比让前端自己往四区里插一条更简单也更不会插错位置——
 *   排序规则（临期优先）在后端，前端插出来的位置会是错的。
 */

/** 存放区。四档固定，与 3D 预览的摆位一致（F6-04 / F17-02） */
export type FridgeZone = '常温' | '保鲜' | '冷藏' | '冷冻'

export const FRIDGE_ZONES: FridgeZone[] = ['常温', '保鲜', '冷藏', '冷冻']

export interface FridgeItem {
  id: string
  name: string
  /** 数量，自由文本（「半盒」「约 500g」）。`null` = 没写多少（不是"0"） */
  amount: string | null
  zone: FridgeZone
  /** 保质期 `YYYY-MM-DD`。`null` = 没写（不是"不会坏"） */
  expiresOn: string | null
  /** 后端算好的那句话：「过期 2 天」「今天到期」「明天到期」「还有 5 天」；没写保质期是 null */
  expiryLabel: string | null
  /** 要不要提醒（已过期或三天内）——「今日先吃」按它筛 */
  attention: boolean
  note: string | null
  /** 谁放的（昵称） */
  addedBy: string
  addedAt: string
  /**
   * 「什么时候记的」那句话（F6-06）：「刚刚」「今天」「昨天」「3 天前」「更早」。
   *
   * **由后端算好**，前端不重算——与 `expiryLabel` 同一条规矩（两边各算一遍必然漂移，
   * 而"昨天记的"和"1 天前记的"不一致时，用户会开始怀疑这个功能）。
   */
  addedLabel: string
}

export interface FridgeZoneGroup {
  zone: FridgeZone
  items: FridgeItem[]
}

export interface FridgeBoard {
  scope: 'family' | 'mine'
  /** 四个存放区各一组，顺序与 `FRIDGE_ZONES` 一致（后端排好，前端不再分组） */
  zones: FridgeZoneGroup[]
  summary: {
    total: number
    /** 该提醒的样数（已过期 + 三天内） */
    attention: number
    expired: number
    /** 写了保质期的样数——没写的不算进"快过期"，那是不知道而不是不会坏 */
    withExpiry: number
  }
  /** 「今日先吃」：临期清单单独给一份，前端不必自己筛 */
  soon: FridgeItem[]
  /**
   * 最近记的几样（F6-06）：**按记的时间倒序**，最长 8 条。
   *
   * 与上面的排序（临期优先）**不是同一套**：这一块回答"家里最近新添了什么"，
   * 用临期那套排会让人以为"最近记的是那盒快过期的奶"。排序在后端做，前端不重排。
   */
  recent: FridgeItem[]
  /** 冰箱里一共几条（界面据此说"最近 8 样，共 N 样"） */
  recentTotal: number
}

export interface FridgeInput {
  name?: string
  amount?: string
  zone?: FridgeZone
  expiresOn?: string
  note?: string
}

export async function fetchFridge(): Promise<FridgeBoard> {
  const { data } = await apiClient.get<FridgeBoard>('/fridge')
  return data
}

export async function addFridgeItem(input: FridgeInput): Promise<FridgeBoard> {
  const { data } = await apiClient.post<FridgeBoard>('/fridge', input)
  return data
}

export async function updateFridgeItem(id: string, input: FridgeInput): Promise<FridgeBoard> {
  const { data } = await apiClient.patch<FridgeBoard>(`/fridge/${id}`, input)
  return data
}

export async function removeFridgeItem(id: string): Promise<FridgeBoard> {
  const { data } = await apiClient.delete<FridgeBoard>(`/fridge/${id}`)
  return data
}

/** `enabled` 由父级传：没加入家庭时没有"家里的冰箱"可看，接口会回 404 */
export function useFridge(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['fridge'],
    queryFn: fetchFridge,
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 30_000,
  })
}

/**
 * 手边食材能做的一道菜（F5-04 / F6-07）。
 *
 * `have` 与 `missing` 是这一行**最该看见的两句话**：
 * - `have` 是"用上了你冰箱里的什么"（按用户自己记的名字回显，他说"西红柿"就不回"番茄"）；
 * - `missing` 是**具体哪几样**（不是只给一个数字）——用户要拿它去决定买不买、顺不顺路。
 *   空数组才叫"不用买就能做"，那是这个功能唯一敢说的话（见 pantry.rules 文件头 ③）。
 */
export interface CookableDish {
  id: string
  name: string
  image: string | null
  category: string | null
  cuisine: string | null
  calories: number | null
  caloriesEstimated: boolean
  have: string[]
  missing: string[]
  missingCount: number
}

export interface CookableBoard {
  /** 这份手边清单是**从冰箱来的**还是**用户自己挑的**——界面上要如实说 */
  source: 'fridge' | 'picked'
  scope: 'family' | 'mine'
  /** 参与比对的那几样（调料已经摘掉了） */
  pantry: string[]
  /** 手边有几样能拿来做菜的东西（= pantry.length；调料不算） */
  usable: number
  /** 冰箱里被摘掉的调料数（调料不进比对，但要说出来，不然用户以为漏了） */
  skipSeasonings: number
  maxMissing: number
  /** 能做的菜一共几道（不是返回了几道） */
  total: number
  /** 这一页从第几道开始（0 基）——翻页用 */
  offset: number
  /** 因为有人过敏被排掉的道数（F5-03）：只数"本来会出现在这份结果里"的 */
  filteredOut: number
  items: CookableDish[]
}

export interface CookableQuery {
  /** 手边食材；**不传就用整个冰箱**（F6-07）。传了空串也当没传（后端同一口径） */
  ingredients?: string[]
  limit?: number
  /** 从第几道开始（0 基）；不传 = 0。「看全部」那一页翻页用 */
  offset?: number
  /** 最多容忍差几样：0 = 只看不用买的 */
  maxMissing?: number
}

export async function fetchCookable(query: CookableQuery = {}): Promise<CookableBoard> {
  const params = new URLSearchParams()
  if (query.ingredients?.length) params.set('ingredients', query.ingredients.join(','))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined && query.offset > 0) params.set('offset', String(query.offset))
  if (query.maxMissing !== undefined) params.set('maxMissing', String(query.maxMissing))
  const suffix = params.toString()
  const { data } = await apiClient.get<CookableBoard>(`/fridge/cookable${suffix ? `?${suffix}` : ''}`)
  return data
}

/**
 * 能做点什么。**跟着参数进缓存键**（手边清单、`maxMissing`、翻页起点都算）：
 * 不分开的话，用户切到"只看不用买的"会看到上一次那份列表一闪而过再变。
 *
 * 手边清单排序后进 key：勾选顺序不影响结果，但会影响 key → 同一组食材被当成两份缓存、
 * 白请求一次（用户来回点两下就会出现）。
 *
 * `undefined`（用整个冰箱）与 `[]`（一样都没挑）**必须落在不同的键上**：
 * 它们不是同一个请求，共用缓存会让后者拿到前者那份数据
 * （组件那边已经用 `nothingPicked` 挡了绘制，但键这一层也不该留这个坑）。
 */
export function useCookable(query: CookableQuery, options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  const key = query.ingredients === undefined ? 'all' : [...query.ingredients].sort().join(',')
  return useQuery({
    queryKey: ['fridge', 'cookable', key, query.maxMissing ?? 1, query.limit ?? 0, query.offset ?? 0],
    queryFn: () => fetchCookable(query),
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 30_000,
  })
}

/**
 * 「看全部」那一页用的翻页版（F6-07 的完整列表）。
 *
 * 为什么不复用 `useCookable` 一页页自己管：那样得在页面里手写"攒过的几页 + 加载下一页"，
 * 而这一页要的就是这份累积——`useInfiniteQuery` 正是干这个的（菜谱小书与点单历史同一用法）。
 * 键多一个 `'page'`：它与冰箱页那份"只取前几道"的缓存**不是同一个东西**，
 * 混用会让冰箱页拿回一长串、或者这一页只拿到 5 道。
 *
 * `offset` 用**累计条数**推（`pages.length * pageSize`），不存数组长度：
 * 后端返回的道数恒等于请求的 limit（除最后一页），照着它推不会因为"某一页凑巧少一道"而错位。
 */
export function useCookablePages(query: Omit<CookableQuery, 'offset'>, options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  const pageSize = query.limit ?? 12
  const key = query.ingredients === undefined ? 'all' : [...query.ingredients].sort().join(',')
  return useInfiniteQuery({
    queryKey: ['fridge', 'cookable', 'page', key, query.maxMissing ?? 1, pageSize],
    queryFn: ({ pageParam }) => fetchCookable({ ...query, limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 30_000,
  })
}

/**
 * 三个写操作共用一套收尾：把返回的整块板子**直接写进缓存**。
 *
 * 不用 `invalidateQueries` 重取：写接口已经把新板子给回来了，再取一次是白跑一趟，
 * 而且中间那一小段会显示旧内容（用户刚点完保存、看到的还是旧的）。
 */
function useFridgeWriter<TInput>(request: (input: TInput) => Promise<FridgeBoard>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: (board) => queryClient.setQueryData(['fridge'], board),
  })
}

export function useAddFridgeItem() {
  return useFridgeWriter(addFridgeItem)
}

export function useUpdateFridgeItem() {
  return useFridgeWriter((input: { id: string; patch: FridgeInput }) => updateFridgeItem(input.id, input.patch))
}

export function useRemoveFridgeItem() {
  return useFridgeWriter((id: string) => removeFridgeItem(id))
}
