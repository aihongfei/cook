import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  /** 这一餐的成品照张数（F9-08）；按可见范围算，看不到的不计入 */
  photoCount: number
  nextActions: NextAction[]
  submittedAt: string
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

export function useOrderOptions() {
  return useQuery({
    queryKey: ['orders', 'options'],
    queryFn: fetchOrderOptions,
    staleTime: 60 * 60_000,
  })
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
      // 任何一处点单变化都可能影响别人的视图（同一家庭），让列表在后台重新校验一次
      void queryClient.invalidateQueries({ queryKey: ['orders'], refetchType: 'active' })
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
