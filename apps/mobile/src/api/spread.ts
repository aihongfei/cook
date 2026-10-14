import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from './client'
import { invalidateAfterMenuChange, mergeCard, type MealCard, type MealSlot, type OrderBoard } from './orders'

/**
 * 「摇一桌」（F5-01，2026-10-15 由「摇一道」升级而来）。口径见 D-072。
 *
 * 与「帮我决定」的区别不是"随机不随机"，是**量**：那边只给一道、让用户看理由，
 * 这边给**一桌**、让用户当场就能定下来。所以：
 *
 * - 这是 `useMutation` 不是 `useQuery`：点一下摇一次，不是"取一份数据"；
 * - 抽多少道由**后端按人数与餐次**算（前端不自己算道数——那会让"几个人才算一桌"
 *   这件事有两份实现），人数优先取这一餐已存的；
 * - 一整桌**一次请求写进去**（`/orders/items/bulk`）：前端循环调加菜接口的话，
 *   中途失败会加进去一半，用户得到一桌残缺的菜还不知道为什么。
 */

export type SpreadRole = 'meat' | 'veg' | 'soup' | 'other'

/** 一桌里的一道（字段与后端 `spread()` 的返回一一对应） */
export interface SpreadDish {
  id: string
  name: string
  image: string | null
  category: string | null
  cuisine: string | null
  tags: string[]
  calories: number | null
  caloriesEstimated: boolean
  role: SpreadRole
  /** 荤菜 / 素菜 / 汤 / 另配——**后端拼好**，前端只渲染 */
  roleLabel: string
  /** 为什么是这道（后端拼的那句话），可能是空串（一句真事都没有时不编） */
  reason: string
  /** 用上了冰箱里的哪几样 */
  have: string[]
  /** 还差哪几样 */
  missing: string[]
  /** 用上的食材里该先吃的（快过期） */
  soon: string[]
  cooked: number
  lastCookedOn: string | null
}

export interface SpreadResult {
  scope: 'family' | 'mine'
  mealKey: string
  date: string
  meal: MealSlot
  mealLabel: string
  /** 按几个人配的 */
  diners: number
  /** 这个人数是这一餐存着的（true），还是按默认值算的（false）——界面话术不同 */
  dinersFromMeal: boolean
  /** 实际配了几道（可能少于按人数该给的：库里不够） */
  count: number
  /** 头部那句话（后端拼）："4 个人吃，配了 3 道" */
  reason: string
  /** 冰箱里一条都没记：界面要说清这次没照着冰箱挑 */
  fridgeEmpty: boolean
  /** 挑不出来时（空库）这里是原因，`items` 为空 */
  items: SpreadDish[]
}

export async function fetchSpread(mealKey: string, diners?: number, signal?: AbortSignal): Promise<SpreadResult> {
  const { data } = await apiClient.get<SpreadResult>('/discover/spread', {
    params: { mealKey, diners },
    signal,
  })
  return data
}

export function useSpread() {
  return useMutation({
    mutationFn: (input: { mealKey: string; diners?: number }) => fetchSpread(input.mealKey, input.diners),
  })
}

export interface BulkAddResult {
  /** 真加进去的那几道 */
  added: string[]
  /** 这一餐里本来就有、跳过的那几道（不叠加份数） */
  skipped: string[]
  /** 写完之后这一餐的样子；一道都没加且这一餐原本不存在时为 null */
  card: MealCard | null
}

/**
 * 整组加进某一餐。
 *
 * 不套 `useOrderMutation`：那个只认 `MealCard`，而这条回的是 `{added, skipped, card}`
 * ——跳过的那几道是**要说给用户听的**（"有 2 道本来就在这一餐里"），吞掉就变成了
 * "我点了五道怎么只加了三道"。并缓存那一步与 `useRepeatMeal` 同一套。
 */
export function useAddDishesToMeal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      recipeIds: string[]
      mealDate: string
      meal: MealSlot
    }): Promise<BulkAddResult> => {
      const { data } = await apiClient.post<BulkAddResult>('/orders/items/bulk', input)
      return data
    },
    onSuccess: (result) => {
      if (result.card) {
        for (const scope of ['family', 'mine'] as const) {
          queryClient.setQueriesData<OrderBoard>({ queryKey: ['orders', scope] }, (board) =>
            board ? mergeCard(board, result.card as MealCard) : board,
          )
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['orders'], refetchType: 'active' })
      invalidateAfterMenuChange(queryClient)
    },
  })
}
