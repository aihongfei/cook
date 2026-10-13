import { useQuery } from '@tanstack/react-query'
import { apiClient } from './client'

/**
 * 首页「菜谱推荐」（D-071，用户 2026-10-14：「现在固定那几样了，能不能随机一些呢，
 * 根据个人习惯、口味等进行推荐」）。
 *
 * 这里**不调 `/recipes`**：那一支是公共菜谱库的分页读接口，按 `name ASC` 取第 1 页，
 * 于是每次进首页都是同样六道（就是用户看到的毛病）。个性化要的是"这家人"的信号
 * （口味档案、收藏、做过几次、冰箱里临期的），那些都在服务端且与家庭绑定，
 * 所以走 `/discover/recommend`——与「家人最爱」「帮我决定」同一处，
 * 共用同一套权重（`COOKED_WEIGHT` / `FAVORITE_WEIGHT`）。
 */

/**
 * 一张推荐卡。
 *
 * ⚠️ **字段与 `RecipeSummary`（`api/recipes.ts`）同形，外加 `cooked`/`favorites`**——
 * 不是巧合，是刻意的：首页那一列用的还是同一张 `DishCard`，它要 `origin`/`sourceLabel`
 * 画来源角标、要 `mine` 决定画不画"能改"。两处各写一个形状，界面上迟早一边多一个角标。
 * 后端也是照这个形状拼的（见 `DiscoverService.recommend` 里那段注释）。
 */
export interface RecommendedDish {
  id: string
  name: string
  image: string | null
  category: string
  cuisine: string
  tags: string[]
  calories: number | null
  caloriesEstimated: boolean
  /** 机器判据：`'user'` = 自家上传的 */
  origin: string
  /** 给人看的来源名（后端翻好，界面直接显示） */
  sourceLabel: string
  /** 是不是自己家的（= 能不能改） */
  mine: boolean
  /** 做过几次（不同的餐）。界面据此说"你们家做过 3 次"，让这份推荐不显得凭空 */
  cooked: number
  /** 家里几个人收着（共享关掉时只算自己） */
  favorites: number
}

export interface RecommendResult {
  scope: 'family' | 'mine'
  items: RecommendedDish[]
  /** 参与挑选的菜一共几道 */
  total: number
  /** 冰箱里一条都没记：界面要说"记了冰箱，推荐会跟着变" */
  fridgeEmpty: boolean
  /** 空库时的原因（后端拼好，前端只照搬） */
  reason?: string
}

/**
 * 每次进入首页都要**新的一份**（`staleTime: 0`）。
 *
 * 与「帮我决定」用 mutation 不同：那个是"点一下要一个主意"，
 * 这个是"进页面看一眼推荐"，是**读**不是动作。但两者都不能留太久——
 * 留久了用户来回切两次标签页，看到的是同一屏，又回到"固定那几样"的观感。
 */
export function useRecommendations(count = 6) {
  return useQuery({
    queryKey: ['discover', 'recommend', count],
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.get<RecommendResult>('/discover/recommend', {
        params: { count },
        signal,
      })
      return data
    },
    staleTime: 0,
    retry: 1,
  })
}
