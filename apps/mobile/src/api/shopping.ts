import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { FridgeItem } from './fridge'
import { apiClient } from './client'

/**
 * 采购清单（M7 / F7-01、F7-02、F7-03、F7-05）。口径见 D-039、D-059 与 D-064。
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
  /**
   * 这一条是**用户自己加的**（F7-03），不是菜单推出来的。
   *
   * 界面据此给一个"删掉"的入口：菜单推出来的条目不能删（删了下次请求又回来），
   * 自加的得能收回。
   */
  extra?: boolean
  /** 自加条目的 id（**只有自加的才有**；删它要用它。菜单推出来的没有稳定身份） */
  extraId?: string
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

/** 货架分组（F7-03）：按"在超市里怎么走"分（生鲜在前、调料垫底）；空组不返回 */
export interface ShoppingAisleGroup {
  aisle: string
  items: ShoppingItem[]
}

export interface ShoppingList {
  scope: 'family' | 'mine'
  days: number
  from: string
  to: string
  meals: ShoppingMeal[]
  /** 全部条目（每条带 `stock`；界面按 `needsBuy` 分两组、组内再按货架分） */
  items: ShoppingItem[]
  /** 还要买的净数（库存已经扣掉）——"共 N 样"用的是它 */
  toBuyCount: number
  /** 家里已有、不用买的样数 */
  coveredCount: number
  /** 其中"量算不清、够不够自己看"的样数 */
  unsureCount: number
  /** 冰箱里一条都没记（界面要说"记了冰箱才能替你扣掉"，而不是让用户以为功能没用） */
  stockEmpty: boolean
  /** 按货架分好组的条目（F7-03；空组不在里面） */
  aisles: ShoppingAisleGroup[]
  /** 已经勾掉的条目名（F7-03 持久化：刷新、换台设备都还在） */
  checkedNames: string[]
  /** 已经勾掉几样（"买到 N/M" 的 N）——**只算要买的**那几样 */
  checkedCount: number
  /** 没有配料表可算的菜（自己写的菜）：必须显示出来，否则用户会漏买 */
  missing: string[]
  dishCount: number
}

/** 一键补货的结果（F7-05）：真的写进去了哪几条 + 哪些因为库里已有而跳过 */
export interface RestockResult {
  added: FridgeItem[]
  skipped: { name: string; why: string }[]
  /** 补完之后的清单（勾选状态与条目都在里面，界面直接换掉旧的那份） */
  board: ShoppingList
}

export async function fetchShoppingList(days?: number, signal?: AbortSignal): Promise<ShoppingList> {
  const { data } = await apiClient.get<ShoppingList>('/shopping-list', { params: { days }, signal })
  return data
}

/**
 * 清单缓存的键。**读与写必须落在同一处**（勾选是乐观更新，写错键就会出现
 * "点了没反应、重进又对了"这种最难查的错），所以读写都走这个函数，不各写一遍字面量。
 */
export function shoppingKey(days?: number) {
  return ['shopping', 'list', days ?? 'default'] as const
}

/** `enabled` 由父级传：没加入家庭时没有"家里要做的菜"可算，接口会回 404（与 useFamilyPicks 同一处理） */
export function useShoppingList(options: { days?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: shoppingKey(options.days),
    queryFn: ({ signal }) => fetchShoppingList(options.days, signal),
    enabled: options.enabled !== false,
    staleTime: 30_000,
  })
}

/**
 * 只改**一样东西**的勾，别的一律不动。
 *
 * 服务端回的是一整块清单，但**不能拿它整体替换缓存**：用户会连着点好几样，
 * 先发出的那次的响应后到，就会把刚点的那几样盖回旧的样子（"我点了它怎么又没勾上"）。
 * 只合并这一样的勾之后，别人的状态永远来自各自那一次响应，谁先到都不影响。
 *
 * 同理，失败时也**只翻这一样**回去——恢复整块快照会把别人的勾一起翻回去（如果那期间他点过）。
 */
function applyCheck(client: QueryClient, days: number | undefined, name: string, checked: boolean) {
  const key = shoppingKey(days)
  const previous = client.getQueryData<ShoppingList>(key)
  if (!previous) return
  const names = new Set(previous.checkedNames)
  if (checked) names.add(name)
  else names.delete(name)
  const checkedNames = [...names]
  // `checkedCount` 只数"要买的"里勾了几样（服务端同一口径）——本地改了这一样，这个数也要跟着对
  const toBuy = new Set(previous.items.filter((item) => item.needsBuy).map((item) => item.name))
  client.setQueryData<ShoppingList>(key, {
    ...previous,
    checkedNames,
    checkedCount: checkedNames.filter((entry) => toBuy.has(entry)).length,
  })
}

export interface CheckInput {
  name: string
  /** 目标是勾上还是取消（服务端按这个值落库，不是"翻一下"——重放同一个请求结果一样） */
  checked: boolean
  days?: number
}

/**
 * 勾选 / 取消勾选（F7-03 持久化）。**乐观更新**：在超市里点一下就要立刻划掉，
 * 等一个来回再划会让人以为没点到（然后去点第二下，正好取消掉）。
 */
export function useCheckShoppingItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CheckInput) => {
      const { data } = await apiClient.post<ShoppingList>('/shopping-list/check', {
        name: input.name,
        checked: input.checked,
      })
      return data
    },
    onMutate: (input) => applyCheck(queryClient, input.days, input.name, input.checked),
    onSuccess: (board, input) => applyCheck(queryClient, input.days, input.name, board.checkedNames.includes(input.name)),
    onError: (_error, input) => applyCheck(queryClient, input.days, input.name, !input.checked),
  })
}

/** 自己往清单上加一条（F7-03）：垃圾袋、洗洁精这些没有菜谱的东西 */
export function useAddShoppingExtra() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; amount?: string; days?: number }) => {
      const { data } = await apiClient.post<ShoppingList>('/shopping-list/extras', {
        name: input.name,
        amount: input.amount,
      })
      return { board: data, days: input.days }
    },
    onSuccess: ({ board, days }) => queryClient.setQueryData(shoppingKey(days), board),
  })
}

/**
 * 删掉自己加的那一条。**只有自加的能删**（`extraId` 只有它有）——
 * 菜单推出来的那条删了下次请求还会回来，它该不该在由菜单决定。
 */
export function useRemoveShoppingExtra() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { extraId: string; days?: number }) => {
      const { data } = await apiClient.delete<ShoppingList>(`/shopping-list/extras/${input.extraId}`)
      return { board: data, days: input.days }
    },
    onSuccess: ({ board, days }) => queryClient.setQueryData(shoppingKey(days), board),
  })
}

/**
 * 一键补货（F7-05）：把勾掉的那几样写进冰箱。
 *
 * 写完之后**清单**直接被换成服务端给的那份（有几条被取消了勾），
 * 冰箱那边**让它自己重取一次**：补货接口回的是"加进去的那几条"，不是整块冰箱板
 * （冰箱的排序规则在后端，前端拼不出来；见 `api/fridge.ts` 的同一说法）。
 */
export function useRestockShopping() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { names: string[]; days?: number }) => {
      const { data } = await apiClient.post<RestockResult>('/shopping-list/restock', { names: input.names })
      return { result: data, days: input.days }
    },
    onSuccess: ({ result, days }) => {
      queryClient.setQueryData(shoppingKey(days), result.board)
      void queryClient.invalidateQueries({ queryKey: ['fridge'] })
    },
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
