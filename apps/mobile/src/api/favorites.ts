import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 收藏（M1 / F1-09）。口径见 D-037。
 *
 * 三件事刻意的：
 * - **按人存**：收藏是"我爱吃/我想做"的个人偏好，与家庭共享开关（F2-07）无关。
 *   所以这里不看 `family`，只要有登录就能用——没加入家庭的人也能收藏菜。
 * - **一颗心的开与关走同一个接口**（`POST /favorites/toggle`）：后端返回切换后的状态，
 *   前端不自己推——自己推就要先知道当前值、再多一条分支，而它手里本来就有。
 * - **列表页的收藏状态一次问清一屏**（`POST /favorites/status`）：一屏十几张卡逐个问
 *   会变成十几个请求（还会撞限流）。
 */

export interface FavoriteItem {
  id: string
  name: string
  image: string | null
  category: string
  cuisine: string
  tags: string[]
  calories: number | null
  caloriesEstimated: boolean
  /** 什么时候收藏的（列表按它倒序，最近收藏的在前） */
  favoritedAt: string
}

export interface FavoriteBoard {
  items: FavoriteItem[]
  total: number
  /** 最多能收藏多少（后端下发，前端据此把话说清楚） */
  limit: number
}

export async function fetchFavorites(): Promise<FavoriteBoard> {
  const { data } = await apiClient.get<FavoriteBoard>('/favorites')
  return data
}

export async function toggleFavorite(recipeId: string): Promise<{ favorited: boolean; total: number }> {
  const { data } = await apiClient.post<{ favorited: boolean; total: number }>('/favorites/toggle', { recipeId })
  return data
}

export async function fetchFavoriteStatus(recipeIds: string[]): Promise<Record<string, boolean>> {
  const { data } = await apiClient.post<{ favorited: Record<string, boolean> }>('/favorites/status', { recipeIds })
  return data.favorited ?? {}
}

export function useFavorites() {
  const token = useAuth((state) => state.token)
  return useQuery({
    // 列表与状态分成两个命名空间：`invalidateQueries({queryKey:['favorites']})` 是**前缀匹配**，
    // 用同一个前缀的话，"刷新列表"会连带把刚就地更新过的那一屏状态也作废重取（白一次请求、还可能闪一下）
    queryKey: ['favorites', 'list'],
    queryFn: fetchFavorites,
    enabled: Boolean(token),
    staleTime: 30_000,
  })
}

/**
 * 一屏菜的收藏状态：**没登录就不请求**（后端会 401）。
 * `ids` 变了才重查——它是一屏内容，滚动加载新的一屏时会跟着换。
 */
export function useFavoriteStatus(ids: string[]) {
  const token = useAuth((state) => state.token)
  // 排序后拼成 key：同一批菜以不同顺序传进来不该触发两次请求
  const key = [...ids].sort().join(',')
  const query = useQuery({
    queryKey: ['favorites', 'status', key],
    queryFn: () => fetchFavoriteStatus(ids),
    enabled: Boolean(token) && ids.length > 0,
    staleTime: 60_000,
  })
  /*
   * `signedIn` 单独给出来：父级要用它决定"画不画那颗心"。
   * 不拿 `status.isSuccess / isError` 去猜——那两个是**请求状态**，不是"能不能收藏"：
   * 登录了但这一屏还没查完时，心就已经该在那儿了（只是还没亮）。
   */
  return { ...query, signedIn: Boolean(token) }
}

/**
 * 切换收藏。成功后同时更新两处缓存：
 * - **收藏页列表**：直接失效让它重取（新增/移除一条会改顺序，本地插入容易插错位置）；
 * - **一屏状态**：就地改那一道的布尔值（列表页只关心那颗心，不必为它重取一屏）。
 */
export function useToggleFavorite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: toggleFavorite,
    onSuccess: (result, recipeId) => {
      queryClient.setQueriesData<Record<string, boolean>>({ queryKey: ['favorites', 'status'] }, (map) => {
        if (!map) return map
        return { ...map, [recipeId]: result.favorited }
      })
      void queryClient.invalidateQueries({ queryKey: ['favorites', 'list'] })
    },
  })
}
