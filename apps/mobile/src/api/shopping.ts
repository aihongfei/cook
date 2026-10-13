import { useQuery } from '@tanstack/react-query'
import { apiClient } from './client'

/**
 * 采购清单（M7 / F7-01、F7-02）。口径见 D-039 与 D-059。
 *
 * `amount` 是**一句人话**而不是数字：菜谱里的用量是自由文本（"2朵"、"适量"、空），
 * 后端能加的加起来（`2朵 + 3朵 → 5朵`）、不能加的原样列（`2g、适量`），
 * `null` 表示"菜谱压根没写用量"。前端不再加工它——一加工就会出现两边算法不一致。
 *
 * `stock` 是**与冰箱比对的结论**（F7-02）。四档不是两档，因为有两件事我们真的不知道
 * （菜谱要多少、家里有多少）——只要有一件不知道就不能算减法。那句说给用户听的话
 * 由后端拼好（`stockLabel`），前端只照搬。
 */
export interface ShoppingStock {
  /** `missing` 照买 / `enough` 家里够 / `notEnough` 家里不够 / `unknown` 量算不清 */
  verdict: 'missing' | 'enough' | 'notEnough' | 'unknown'
  /** 家里那一样**按用户自己记的名字**回显 */
  stockName: string | null
  /** 家里记的量（原样，可能是几条用顿号连起来）；null = 没记量 */
  stockAmount: string | null
  /** 扣掉家里已有的之后还要买多少（**只有算得清时才有**） */
  remaining: string | null
}

export interface ShoppingItem {
  name: string
  /** `null` = 没写用量（不是"0"也不是"适量"）；显示成"用量没写" */
  amount: string | null
  /** 哪几道菜要用它 */
  from: string[]
  /** 与冰箱比对的结论（F7-02，结构化，界面按 `verdict` 标色） */
  stock: ShoppingStock
  /** 还要不要买（`missing` 与"家里不够"要；`enough` 与 `unknown` 不要） */
  needsBuy: boolean
  /**
   * 那句话（「家里有 6个，够了」/「家里有 3个，还要买 2个」/「家里有 半盒，够不够看一眼」）
   * ——**后端拼好的**（与冰箱的 `expiryLabel` 同一条规矩）。家里没有时为 `null`。
   */
  stockLabel: string | null
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
  /** 全部条目（每条带 `stock`，前端按 `needsBuy` 分两组渲染） */
  items: ShoppingItem[]
  /** 还要买的净数（库存已经扣掉）——"共 N 样"用的是它 */
  toBuyCount: number
  /** 家里已有、不用买的样数 */
  coveredCount: number
  /** 其中"量算不清、够不够自己看"的样数 */
  unsureCount: number
  /** 冰箱里一条都没记（界面要说"记了冰箱才能替你扣掉"，而不是让用户以为功能没用） */
  stockEmpty: boolean
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

/**
 * 与库存比对那句话（F7-02）**直接来自后端**（`stockLabel` 字段）。
 *
 * 前端不做判断、也不重拼——与冰箱的 `expiryLabel` 同一条规矩：两边各拼一次必然有一边先改，
 * 而"家里有 / 还要买"这种话一旦不一致，用户就不信它了。这里保留一个取字段的小函数，
 * 只是为了在页面里读起来像一句人话（`stockLine(item)` 比 `item.stockLabel` 好读一点）。
 */
export function stockLine(item: ShoppingItem): string | null {
  return item.stockLabel
}
