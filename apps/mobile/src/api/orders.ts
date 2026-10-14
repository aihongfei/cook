import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 点单接口与查询（M3 / F3-01~F3-05，口径见 DECISIONS D-022）。
 *
 * 与家庭模块同一套路：
 * - 能力判定只读后端下发的 `myCapabilities`（见 `can`），前端不自己算权限；
 * - 状态机也**不硬编码**——每张卡带 `nextActions`（后端按我的角色算好的下一步），
 *   前端只管把它们渲染成按钮。这样改流转规则不用发前端版本。
 */

export type MealSlot = 'LUNCH' | 'DINNER'
export type OrderStatus = 'PENDING' | 'PLANNED' | 'COOKING' | 'DONE' | 'CANCELED'

export interface OrderNote {
  nickname: string
  text: string
}

/** 卡片里按菜合并后的一行（同一道菜多人点 → 份数 + 各自的备注） */
export interface DishLine {
  recipeId: string | null
  name: string
  image: string | null
  count: number
  notes: OrderNote[]
  /** 我点的那几份的 id（用来撤「我这份」） */
  mineItemIds: string[]
}

export interface OrderItemView {
  id: string
  recipeId: string | null
  name: string
  image: string | null
  userId: string
  nickname: string
  avatar: string
  isMe: boolean
  note: string | null
  createdAt: string
}

export interface NextAction {
  status: OrderStatus
  label: string
  /** 需要二次确认（取消整餐）——走 ConfirmDialog */
  needsConfirm: boolean
}

export interface MealCard {
  /** 稳定标识：`2026-10-13-DINNER`，流转用它 */
  mealKey: string
  date: string
  meal: MealSlot
  mealLabel: string
  status: OrderStatus
  statusLabel: string
  orderers: string[]
  ordererCount: number
  dishCount: number
  dishes: DishLine[]
  items: OrderItemView[]
  mineCount: number
  /** 掌勺人设定的就餐人数（M4 / F4-05）；null = 还没定 */
  dinerCount: number | null
  /**
   * 这一版菜单是谁定下来的（M4 / F4-05 的确认留痕）；null = 还在收集中，或这一版已被取消。
   * 取消、取消后重新加菜都会清空——上一版菜单不算数了，"谁定的"也就不成立。
   */
  confirmedBy: { nickname: string; avatar: string } | null
  confirmedAt: string | null
  /**
   * 谁把这一餐标成「做好了」（M10 / F10-02）；与 `confirmedBy` 是**两件事**：
   * 定菜单与做饭常常不是同一个人，详情页要能把两者分开说。
   */
  doneBy: { nickname: string; avatar: string } | null
  doneAt: string | null
  /** 这一餐的成品照张数（F9-08）；按可见范围算，看不到的不计入 */
  photoCount: number
  /**
   * 能不能拿这一餐去「再点一次」（F3-06）：做好了 / 已取消 / 日子已经过去。
   * 由后端算好（判据只有一份），前端不复刻状态与日期的判定——复刻就会分叉。
   */
  canRepeat: boolean
  nextActions: NextAction[]
  submittedAt: string
  /**
   * 这一笔点菜的**口味提醒**（F3-08）：有人过敏或忌口时后端才给（见 orders.service 的
   * `tasteWarningFor`）。**不拦，只提醒**——这是用户自己的选择，拦下来会让人以为菜谱库坏了。
   *
   * 只挂在「点这道」的返回上，不在列表/今日安排里：提醒属于**这一笔动作**，
   * 出现在用户没点菜的时刻只会变成噪音。
   */
  tasteWarning?: { verdict: 'warn' | 'block'; text: string }
}

export interface OrderBoard {
  cards: MealCard[]
  /** 各状态的数量（切筛选前就拿到，切换时不会互相清空） */
  counts: Record<string, number>
  scope: 'family' | 'mine'
}

/**
 * 一餐的进度（M4）：**今日安排（F4-01）与本周菜单（F4-02）共用同一个形状**——
 * 两份视图是同一件事的不同窗口，后端也是同一份数据（见 orders.rules 的 MealProgressRow）。
 */
export interface MealProgressRow {
  meal: MealSlot
  label: string
  /** none=还没人点/还没安排；open=收集中/已安排/准备中；settled=已做好/已取消 */
  state: 'none' | 'open' | 'settled'
  status: OrderStatus | null
  statusLabel: string
  dishes: string[]
  dishCount: number
  ordererCount: number
  dinerCount: number | null
  mealKey: string
  photoCount: number
  /** 这一餐还收不收新菜（备菜计划的「加菜」按它决定出不出现）。由后端按状态机算，前端不复刻 */
  canAdd: boolean
}

export interface TodayBoard {
  date: string
  rows: MealProgressRow[]
}

/** 本周菜单里的一天（M4 / F4-02）：午晚两餐固定两行，没安排的也占位 */
export interface PlanDay {
  date: string
  /** 今天/明天/后天；更远的日子是星期（备菜计划看满 7 天） */
  label: string
  weekday: string
  meals: MealProgressRow[]
}

export interface PlanBoard {
  /** 共享关闭时吃货看到的是收窄后的空行，前端据此说明原因（scope=mine） */
  scope: 'family' | 'mine'
  days: PlanDay[]
}

/**
 * 点单历史（F3-09）：按**日期区间**给一页，每天午晚两行（没安排的那餐也要占位）。
 * 与 `PlanDay` 同一形状——"看得见的每一格都能点进去"，回看时也一样。
 */
export interface HistoryDay {
  date: string
  weekday: string
  meals: MealProgressRow[]
}

export interface OrderHistory {
  /** 共享关闭时吃货看到的是收窄后的空行，前端据此说明原因 */
  scope: 'family' | 'mine'
  /** 这一页覆盖的区间（含两端），页头用来说清"看的是哪一段" */
  from: string
  to: string
  pageSize: number
  /** 还能不能往前翻（库里有更早的餐次才算有） */
  hasMore: boolean
  /** 新的在前 */
  days: HistoryDay[]
}

export interface OrderOptions {
  meals: { value: MealSlot; label: string }[]
  statuses: { value: OrderStatus; label: string }[]
  /** 点菜能选的日子：今天起 7 天（由后端下发，前端不硬编码） */
  dayOptions: { value: string; label: string }[]
}

export async function fetchOrders(options: {
  family: boolean
  status?: string
}): Promise<OrderBoard> {
  const { data } = await apiClient.get<OrderBoard>('/orders', {
    params: {
      family: String(options.family),
      ...(options.status && options.status !== 'ALL' ? { status: options.status } : {}),
    },
  })
  return data
}

/**
 * 某一餐的详情（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
 *
 * 按 `mealKey` 取——它与列表、流转接口、通知去处用的是同一个标识，
 * 所以详情页刷新、从通知点进来、把地址发给别人都成立。
 */
export async function fetchMeal(mealKey: string): Promise<MealCard> {
  const { data } = await apiClient.get<MealCard>(`/orders/${mealKey}`)
  return data
}

export async function fetchToday(): Promise<TodayBoard> {
  const { data } = await apiClient.get<TodayBoard>('/orders/today')
  return data
}

export async function fetchPlan(days?: number): Promise<PlanBoard> {
  const { data } = await apiClient.get<PlanBoard>('/orders/plan', {
    params: days ? { days } : undefined,
  })
  return data
}

export async function setDinerCount(mealKey: string, dinerCount: number | null): Promise<MealCard> {
  const { data } = await apiClient.post<MealCard>(
    `/orders/meals/${encodeURIComponent(mealKey)}/diners`,
    { dinerCount },
  )
  return data
}

export async function fetchHistory(input: { to?: string; pageSize?: number } = {}): Promise<OrderHistory> {
  const { data } = await apiClient.get<OrderHistory>('/orders/history', {
    params: {
      ...(input.to ? { to: input.to } : {}),
      ...(input.pageSize ? { pageSize: input.pageSize } : {}),
    },
  })
  return data
}

export async function fetchOrderOptions(): Promise<OrderOptions> {
  const { data } = await apiClient.get<OrderOptions>('/orders/options')
  return data
}

export async function addOrderItem(input: {
  /** 点菜谱里的菜（与 dishName 二选一） */
  recipeId?: string
  /** 自己写一道（F3-10，与 recipeId 二选一）；名字与库里某道菜完全同名时会挂到那道菜上 */
  dishName?: string
  mealDate: string
  meal: MealSlot
  note?: string
}): Promise<MealCard> {
  const { data } = await apiClient.post<MealCard>('/orders/items', input)
  return data
}

export async function removeOrderItem(itemId: string): Promise<MealCard> {
  const { data } = await apiClient.delete<MealCard>(`/orders/items/${encodeURIComponent(itemId)}`)
  return data
}

export async function updateMealStatus(mealKey: string, status: OrderStatus): Promise<MealCard> {
  const { data } = await apiClient.post<MealCard>(
    `/orders/meals/${encodeURIComponent(mealKey)}/status`,
    { status },
  )
  return data
}

/** 「再点一次」的结果（F3-06）：加了哪些、哪些本来就有，以及受影响的那张卡 */
export interface RepeatResult {
  added: string[]
  skipped: string[]
  card: MealCard
  /** 全都被跳过时后端给的一句话（前端直接念它，不自己拼） */
  message?: string
}

export async function repeatMeal(input: {
  /** 照哪一餐（来源，用它的 mealKey） */
  mealKey: string
  /** 照到哪一天哪一餐（目标） */
  mealDate: string
  meal: MealSlot
}): Promise<RepeatResult> {
  const { data } = await apiClient.post<RepeatResult>(
    `/orders/meals/${encodeURIComponent(input.mealKey)}/repeat`,
    { mealDate: input.mealDate, meal: input.meal },
  )
  return data
}

export function useOrders(
  scope: 'family' | 'mine',
  status = 'ALL',
  options: { enabled?: boolean } = {},
) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['orders', scope, status],
    queryFn: () => fetchOrders({ family: scope === 'family', status }),
    // 没加入家庭时后端会 404（点单是家庭内的），所以调用方要先确认有家庭再请求
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 15_000,
  })
}

/**
 * 某一餐的详情。
 *
 * 缓存键放在 `['orders', 'meal', mealKey]` 下面（前缀与列表同一棵树）：
 * 任何改变点单的动作都会作废 `['orders']`，于是详情页也跟着刷新——
 * 用户在这里改了状态，退回去列表不会还是旧的。
 */
export function useMeal(mealKey: string | undefined) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['orders', 'meal', mealKey],
    queryFn: () => fetchMeal(mealKey as string),
    enabled: Boolean(token) && Boolean(mealKey),
    staleTime: 15_000,
  })
}

export function useOrderOptions() {
  return useQuery({
    queryKey: ['orders', 'options'],
    queryFn: fetchOrderOptions,
    staleTime: 60 * 60_000,
  })
}

/**
 * 改菜单之后要作废的那些域。
 *
 * **采购清单（`shopping`）是用户 2026-10-14 报上来的漏网之鱼**，原话：
 * 「我加入订单后…采购清单那边就出现了，但是实际是我点击开始做之后才出现的」。
 * 根因就在这里——它只作废了 `orders`，而清单是**按菜单配料算出来的**：
 * 加一道菜、撤一道菜、把这一餐定下来（PENDING → PLANNED），清单都跟着变。
 * 清单页那份缓存 `staleTime` 是 30 秒，所以用户切过去看到的还是加菜之前的旧清单，
 * 等几十秒再回来（或碰上一次重挂载）才对——表现就是"要点开始做才出现"。
 *
 * 备菜计划（`prep` 页）不必单列：它读的是 `['orders', 'plan', days]`，已经在 `orders` 里。
 *
 * 与 `invalidateAfterAiWrite`（`api/ai.ts`）同一条规矩：**多作废一个没动过的域没关系**
 * （没取过就不会发请求），漏一个就是"页面上看不见刚发生的事"，而用户只会认为功能没生效。
 */
const MENU_DERIVED_KEYS = ['orders', 'shopping'] as const

/** 菜单变过 → 把按它算出来的那几份缓存一起作废 */
export function invalidateAfterMenuChange(queryClient: QueryClient): void {
  for (const key of MENU_DERIVED_KEYS) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/**
 * 会改变点单的接口都返回**受影响的整张卡**：把它并回列表缓存，
 * 省一次往返，也保证徽标计数跟着动（不能只替换一张卡而不管计数）。
 */
function useOrderMutation<TInput>(mutationFn: (input: TInput) => Promise<MealCard>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (card) => {
      for (const scope of ['family', 'mine'] as const) {
        queryClient.setQueriesData<OrderBoard>({ queryKey: ['orders', scope] }, (board) =>
          board ? mergeCard(board, card) : board,
        )
      }
      /*
       * 任何一处点单变化都可能影响别人的视图（同一家庭），让列表在后台重新校验一次；
       * 同时作废清单与备菜计划（见 `MENU_DERIVED_KEYS`）。
       *
       * 这里**不按动作区分**（加菜/撤菜/改状态/改人数全走同一支）：人数只影响备菜量、
       * 不影响清单，区分开能少作废一份，但四种动作各自判一次必然有人漏——
       * 而漏掉的表现是"页面没更新"，比多发一次请求糟得多。
       */
      void queryClient.invalidateQueries({ queryKey: ['orders'], refetchType: 'active' })
      invalidateAfterMenuChange(queryClient)
    },
  })
}

/** 把一张卡并回看板：已有就替换，撤回成空卡（dishCount=0）就移除，新的就插到前面 */
export function mergeCard(board: OrderBoard, card: MealCard): OrderBoard {
  const without = board.cards.filter((existing) => existing.mealKey !== card.mealKey)
  if (card.dishCount === 0) {
    return { ...board, cards: without, counts: recount(without) }
  }
  const next = [card, ...without].sort((a, b) =>
    a.date === b.date
      ? a.meal === b.meal
        ? 0
        : a.meal === 'DINNER'
          ? -1
          : 1
      : a.date < b.date
        ? 1
        : -1,
  )
  return { ...board, cards: next, counts: recount(next) }
}

function recount(cards: MealCard[]): Record<string, number> {
  const counts: Record<string, number> = { ALL: cards.length }
  for (const status of ['PENDING', 'PLANNED', 'COOKING', 'DONE', 'CANCELED'] as OrderStatus[]) {
    counts[status] = cards.filter((card) => card.status === status).length
  }
  return counts
}

/** 今日安排（厨房页）：没加入家庭时不请求（后端会 404） */
export function useTodayBoard(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['orders', 'today'],
    queryFn: fetchToday,
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 15_000,
  })
}

/**
 * 点单历史（F3-09）：无限往前翻。
 *
 * 翻页用**日期**当前进的游标（`pageParam` = 这一页的结束日），不用页码：
 * 历史是"往前看"，页码会随着新的一天到来而整体错位（昨天看第 2 页和今天看第 2 页
 * 是不同的日子），而"接着这一页的第一天再往前数"永远稳定。
 * 取下一页时把上一页的 `from` 往前挪一天当新的 `to`，否则那一页会与上一页重叠一天。
 */
export function useOrderHistory(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useInfiniteQuery({
    queryKey: ['orders', 'history'],
    queryFn: ({ pageParam }) => fetchHistory({ to: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? shiftDay(lastPage.from, -1) : undefined,
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 60_000,
    retry: 1,
  })
}

/** `YYYY-MM-DD` 加 n 天（本地日历，跨月跨年都对） */
export function shiftDay(key: string, n: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day + n)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本周菜单（发现页，F4-02）：与今日安排同一份数据的不同窗口 */
export function usePlanBoard(options: { days?: number; enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['orders', 'plan', options.days ?? 3],
    queryFn: () => fetchPlan(options.days),
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 15_000,
  })
}

export function useSetDinerCount() {
  return useOrderMutation((input: { mealKey: string; dinerCount: number | null }) =>
    setDinerCount(input.mealKey, input.dinerCount),
  )
}

export const useAddOrderItem = () => useOrderMutation(addOrderItem)
export const useRemoveOrderItem = () => useOrderMutation(removeOrderItem)
export const useUpdateMealStatus = () =>
  useOrderMutation((input: { mealKey: string; status: OrderStatus }) =>
    updateMealStatus(input.mealKey, input.status),
  )

/**
 * 再点一次（F3-06）：返回的不是一张卡而是 `{added, skipped, card}`，
 * 所以不能套 `useOrderMutation`（那个只认 MealCard）——并缓存那一步照抄过来。
 */
export function useRepeatMeal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: repeatMeal,
    onSuccess: (result) => {
      if (result.card) {
        for (const scope of ['family', 'mine'] as const) {
          queryClient.setQueriesData<OrderBoard>({ queryKey: ['orders', scope] }, (board) =>
            board ? mergeCard(board, result.card) : board,
          )
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['orders'], refetchType: 'active' })
      invalidateAfterMenuChange(queryClient)
    },
  })
}
