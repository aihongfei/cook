import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 发现页的家人榜单（M5 / F5-02）。口径见 D-038。
 *
 * `scope` 是**后端告诉我们的可见范围**：共享关着时吃货只看到自己的份
 * （收藏与参与过的餐），前端据此在页面上说明原因——不复刻判定（与点单/打卡同一口径）。
 */
export interface FamilyPick {
  id: string
  name: string
  image: string | null
  category: string
  cuisine: string
  calories: number | null
  caloriesEstimated: boolean
  /** 做过几次（按"餐"去重：同一餐里两人各点一份只算一次） */
  cooked: number
  /** 喜欢数：family 口径 = 家里几个人收着；mine 口径 = 我收着（0 或 1） */
  favorites: number
  score: number
  lastCookedOn: string | null
}

export interface FamilyPicks {
  scope: 'family' | 'mine'
  limit: number
  /** 有信号的菜一共多少道（不是返回了多少道） */
  total: number
  items: FamilyPick[]
}

export async function fetchFamilyPicks(limit?: number, signal?: AbortSignal): Promise<FamilyPicks> {
  const { data } = await apiClient.get<FamilyPicks>('/discover/family-picks', {
    params: { limit },
    signal,
  })
  return data
}

/**
 * `enabled` 由父级传：没加入家庭时这块没有"家"可算，接口会回 404——
 * 与其发一个注定失败的请求再展示错误，不如一开始就不问（与 `usePlanBoard` 同一处理）。
 */
export function useFamilyPicks(options: { limit?: number; enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['discover', 'family-picks', options.limit ?? 'default'],
    queryFn: ({ signal }) => fetchFamilyPicks(options.limit, signal),
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 60_000,
  })
}

/**
 * 一句话说清"为什么它排在前面"（F5-07 的雏形，只讲这条信号，不编别的理由）。
 *
 * 只提**真实存在的信号**：没做过就不提做过，没人收藏就不提收藏——
 * 与"不造数"同一条线（热量缺失写"热量暂无"、没安排写"还没安排"）。
 *
 * 收藏那句**分口径**：家里几个人收着说"3 人收着"；共享关着时算的只是自己那一份，
 * 说"我收着"才对（说"1 人收着"会让人以为是别人）。
 */
export function pickReason(
  pick: Pick<FamilyPick, 'cooked' | 'favorites'>,
  scope: FamilyPicks['scope'],
): string {
  const parts: string[] = []
  if (pick.cooked > 0) parts.push(`做过 ${pick.cooked} 次`)
  if (pick.favorites > 0) {
    parts.push(scope === 'family' ? `${pick.favorites} 人收着` : '我收着')
  }
  // 榜单只收有信号的菜，所以这里一定至少有一个；真出现空串说明上游放进了 0 分的菜
  return parts.join(' · ')
}
