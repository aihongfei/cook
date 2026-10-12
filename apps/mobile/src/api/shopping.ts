import { useQuery } from '@tanstack/react-query'
import { apiClient } from './client'

/**
 * 采购清单（M7 / F7-01）。口径见 D-039。
 *
 * `amount` 是**一句人话**而不是数字：菜谱里的用量是自由文本（"2朵"、"适量"、空），
 * 后端能加的加起来（`2朵 + 3朵 → 5朵`）、不能加的原样列（`2g、适量`），
 * `null` 表示"菜谱压根没写用量"。前端不再加工它——一加工就会出现两边算法不一致。
 */
export interface ShoppingItem {
  name: string
  /** `null` = 没写用量（不是"0"也不是"适量"）；显示成"用量没写" */
  amount: string | null
  /** 哪几道菜要用它 */
  from: string[]
}

export interface ShoppingMeal {
  mealKey: string
  date: string
  mealLabel: string
  dishCount: number
}

export interface ShoppingList {
  scope: 'family' | 'mine'
  days: number
  from: string
  to: string
  meals: ShoppingMeal[]
  items: ShoppingItem[]
  /** 没有配料表可算的菜（自己写的菜）：必须显示出来，否则用户会漏买 */
  missing: string[]
  dishCount: number
}

export async function fetchShoppingList(days?: number, signal?: AbortSignal): Promise<ShoppingList> {
  const { data } = await apiClient.get<ShoppingList>('/shopping-list', { params: { days }, signal })
  return data
}

/** `enabled` 由父级传：没加入家庭时没有"家里要做的菜"可算，接口会回 404（与 useFamilyPicks 同一处理） */
export function useShoppingList(options: { days?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['shopping', 'list', options.days ?? 'default'],
    queryFn: ({ signal }) => fetchShoppingList(options.days, signal),
    enabled: options.enabled !== false,
    staleTime: 30_000,
  })
}

/** 一行用量的显示：没写用量时**说"用量没写"**，不说"适量"（那是在替菜谱编话） */
export function amountLabel(item: ShoppingItem): string {
  return item.amount ?? '用量没写'
}

/** "葱（番茄炒蛋、蛋花汤）"：买菜的人要能回答"我为什么要买这个" */
export function fromLabel(item: ShoppingItem): string {
  return item.from.length > 0 ? `（${item.from.join('、')}）` : ''
}
