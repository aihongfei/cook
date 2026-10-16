import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 发现页三块 + 抽屉里那行胶囊的接口（2026-10-16 定稿，见 D-110）。
 *
 * 与 `discover.ts`（家人最爱）、`decide.ts`（帮我决定）分开一个文件：
 * 那两份是早就有的榜单与决策，这一份是**这次新加的东西**，
 * 它们的共同点是"给发现页看的"而不是"给某一件事用的"。
 *
 * 「翻牌子」原本也在这一份里（候选池 / 翻一张收一道），**2026-10-16 用户定「不要翻牌子」**，
 * 接口与组件都已删掉；那个决定与它的来龙去脉记在 DECISIONS.md 的 D-110 与
 * `previews/discover-content.html` 里。
 */

/** 一块菜图 + 名字 + 品类（时令精选那一行用） */
export interface DishTile {
  id: string
  name: string
  image: string | null
  category: string
  cuisine: string
}

export interface SeasonalBoard {
  /** 后端按月份算的那一季（春/夏/秋/冬）——前端不自己算，两边各算必然在月初月末分叉 */
  season: string
  title: string
  note: string
  /** 这一季一共几道（与 `items` 同一次筛选的结果，所以与点进去的数字一致） */
  count: number
  /** 点进菜谱小书要用的查询串（`tag=秋季,秋季菜谱`）；**前端不自己拼标签名** */
  tagQuery: string
  /** 只给一屏（后端 `SEASONAL_PREVIEW`），不是全部 */
  items: DishTile[]
}

export async function fetchSeasonal(signal?: AbortSignal): Promise<SeasonalBoard> {
  const { data } = await apiClient.get<SeasonalBoard>('/discover/seasonal', { signal })
  return data
}

export function useSeasonal(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['discover', 'seasonal'],
    queryFn: ({ signal }) => fetchSeasonal(signal),
    // 季节一个月才变一次，缓存久一点：这一块每次回发现页都重取没有意义
    staleTime: 10 * 60_000,
    enabled: Boolean(token) && options.enabled !== false,
    retry: 1,
  })
}

/** 一个场合词与它后面真有多少道（数字要印在胶囊旁边） */
export interface Occasion {
  /** 界面上那三个字（"不想费劲"） */
  label: string
  /** 接口用的标签名（"快手菜"）——`/discover/decide?occasion=` 收它 */
  tag: string
  count: number
}

export async function fetchOccasions(signal?: AbortSignal): Promise<{ items: Occasion[] }> {
  const { data } = await apiClient.get<{ items: Occasion[] }>('/discover/occasions', { signal })
  return data
}

/**
 * 场合词走接口而不是前端常量表：**每个词后面的道数是真的**，而那个数字要显示出来。
 * 写死的话，库里进了一批菜之后界面还在说 74 道。
 */
export function useOccasions(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['discover', 'occasions'],
    queryFn: ({ signal }) => fetchOccasions(signal),
    staleTime: 10 * 60_000,
    enabled: options.enabled !== false,
    retry: 1,
  })
}

export interface MonthlyReport {
  /** 本月安排了几餐（含还没做的） */
  meals: number
  /** 其中真的做好的几顿 */
  done: number
  /** 本月试过几种菜（按已做好的餐去重） */
  kinds: number
  /** 本月打卡几张 */
  photos: number
  /** 最常做的那道（没有高下就不给，见后端 `topDishOf`） */
  topDish: string | null
  topDishOn: string | null
  /** 后端拼好的那句脚注——前端只照搬（与 `stockLabel` 同一条规矩） */
  line: string
}

export interface ReportBoard {
  scope: 'family' | 'mine'
  /** `YYYY-MM` */
  month: string
  /** `null` = 这个月还不够 3 顿，**整块不画**（不是错误） */
  report: MonthlyReport | null
}

export async function fetchMonthlyReport(signal?: AbortSignal): Promise<ReportBoard> {
  const { data } = await apiClient.get<ReportBoard>('/discover/report', { signal })
  return data
}

export function useMonthlyReport(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['discover', 'report'],
    queryFn: ({ signal }) => fetchMonthlyReport(signal),
    /* 短缓存：这个数字会因为"某一餐被标成做好了"而变，而那个动作就在别的页面上发生。
       60s 与家人最爱同一档——两块都要"回到发现页时是新的"。 */
    staleTime: 60_000,
    enabled: Boolean(token) && options.enabled !== false,
    retry: 1,
  })
}
