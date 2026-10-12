import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MealCard } from './orders'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 常用组合（M4 / F4-04）。
 *
 * 三件事值得先知道：
 * - **列表是家庭共用的**：谁组的都能用（`canEdit` 只决定改/删按钮出不出现，
 *   后端仍会再校验一次——前端藏按钮从来不算权限）；
 * - **一键加入返回"加了哪些、跳过哪些"**：跳过的是"这一餐里本来就有"的菜。
 *   界面要**明说**这件事，否则用户看到菜数没变会以为按钮坏了；
 * - 返回里带**受影响的整张卡**，与手点走同一条缓存合并路径（`mergeCard`），
 *   所以点完不用等列表刷新就能看到这一餐的菜。
 */

export interface ComboDish {
  recipeId: string
  name: string
  image: string | null
}

export interface Combo {
  id: string
  name: string
  note: string | null
  createdBy: string
  /** 我能不能改/删它（组它的人或掌勺人/帮厨）；只是显示用，后端仍会校验 */
  canEdit: boolean
  dishes: ComboDish[]
  dishCount: number
}

export interface ComboBoard {
  combos: Combo[]
}

export interface ComboAddResult {
  /** 真的加进去的菜名 */
  added: string[]
  /** 这一餐里本来就有、所以跳过的菜名 */
  skipped: string[]
  card: MealCard | null
  message?: string
}

export async function fetchCombos(): Promise<ComboBoard> {
  const { data } = await apiClient.get<ComboBoard>('/combos')
  return data
}

export function useCombos(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['combos'],
    queryFn: fetchCombos,
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 30_000,
  })
}

export function useCreateCombo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; note?: string; recipeIds: string[] }) => {
      const { data } = await apiClient.post<ComboBoard>('/combos', input)
      return data
    },
    onSuccess: (board) => queryClient.setQueryData(['combos'], board),
  })
}

export function useDeleteCombo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (comboId: string) => {
      const { data } = await apiClient.delete<ComboBoard>(`/combos/${encodeURIComponent(comboId)}`)
      return data
    },
    onSuccess: (board) => queryClient.setQueryData(['combos'], board),
  })
}

/**
 * 一键加入：把整组加到某一天某一餐。
 *
 * 成功后**两处缓存都要动**：组合列表没变（不改它），但点单看板与今日/安排视图都受影响了，
 * 所以按 orders 的键前缀失效一次（与 `useOrderMutation` 同一做法）。
 */
export function useAddCombo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { comboId: string; mealDate: string; meal: 'LUNCH' | 'DINNER' }) => {
      const { data } = await apiClient.post<ComboAddResult>(
        `/combos/${encodeURIComponent(input.comboId)}/add`,
        { mealDate: input.mealDate, meal: input.meal },
      )
      return data
    },
    onSuccess: (result) => {
      if (result.card) {
        for (const scope of ['family', 'mine'] as const) {
          queryClient.setQueriesData<{ cards: MealCard[]; counts: Record<string, number>; scope: string }>(
            { queryKey: ['orders', scope] },
            (board) => (board ? mergeIntoBoard(board, result.card as MealCard) : board),
          )
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['orders'], refetchType: 'active' })
    },
  })
}

/**
 * 把一张卡并回看板。与 `orders.ts` 的 `mergeCard` 是同一件事，但那边没有导出
 * （它是 orders 模块的内部细节）。这里**只做最小的替换**：找到同 mealKey 的卡就替换。
 * 不重复实现排序与重算计数——那些交给紧接着的那次 `invalidateQueries` 拉回权威数据。
 */
function mergeIntoBoard<T extends { cards: MealCard[] }>(board: T, card: MealCard): T {
  const index = board.cards.findIndex((existing) => existing.mealKey === card.mealKey)
  if (index < 0) return { ...board, cards: [card, ...board.cards] }
  const cards = [...board.cards]
  cards[index] = card
  return { ...board, cards }
}
