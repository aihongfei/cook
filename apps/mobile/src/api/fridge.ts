import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
