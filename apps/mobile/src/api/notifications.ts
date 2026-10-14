import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 消息提醒（M10 / F10-01~04）。口径见 D-078。
 *
 * **它是什么**：四条提醒——菜单安排、饭已做好、快过期、该备菜了。
 * 它们**都不是"推来的消息"，而是从家里已有的事实现算出来的**：
 * 菜单定下来是那一餐的 `confirmedAt`、饭做好了是 `doneAt`、快过期是冰箱的保质期、
 * 该备菜了是接下来几天还空着的餐次。所以后端**没有通知表**，这里也没有"消息列表"的持久化话术——
 * 红点亮着就代表"现在事实上有事"。
 *
 * **一条必须说清的边界**（用户 2026-10-15 选的方案）：这一版**没有推送通道**，
 * 所以红点与通知中心**只在应用里看得到**。「饭已做好」这类**别人触发**的提醒
 * 不会在应用关闭时弹出来；手机自己能算出来的那些（快过期、该备菜、到点该做饭）
 * 由**本机通知**负责，见 `lib/local-notify`。
 *
 * **历史**：这批提醒不只是"现在算出来的看板"——每一条都会被记进事件日志
 * （`NotificationEvent`），所以**同一个账号换设备登录，过去的记录都还在**，
 * 且已读是逐条记在账号上的（用户 2026-10-15：「同一个账号换设备了也需要都留存」）。
 */

export type NotificationKind = 'plan' | 'done' | 'expiry' | 'prep'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  /** 这条提醒对应的时刻（ISO） */
  at: string
  /** 点进去看哪儿——**后端给**，前端不按 kind 硬编码跳转表（与"状态机不硬编码"同一条） */
  to: string
  /** 标题旁边那个小标（"菜单""做好了""快过期""备菜"） */
  tag: string
  unread: boolean
}

export interface NotificationPrefs {
  mealPlan: boolean
  mealDone: boolean
  expiry: boolean
  prep: boolean
}

export interface NotificationBoard {
  items: AppNotification[]
  /** 未读总数 */
  unread: number
  /**
   * 底栏两个 Tab 各自的未读数——**红点直接用它**（用户 2026-10-15：「底部菜单，
   * 订单之类的也需要小红点」）。不在前端把四类"三加一"再加一遍：那种算术写两处
   * 迟早有一处漏改（表现是"订单的红点少了一个"）。
   */
  unreadByArea: Partial<Record<'order' | 'fridge', number>>
  /** 四条提醒各自的未读数（通知中心里按类看） */
  unreadByKind: Partial<Record<NotificationKind, number>>
  prefs: NotificationPrefs
}

export async function fetchNotifications(): Promise<NotificationBoard> {
  const { data } = await apiClient.get<NotificationBoard>('/notifications')
  return data
}

/**
 * 提醒（红点与通知中心共用这一份查询）。
 *
 * `staleTime` 给 60 秒：它要跟着点单、冰箱、菜单变，但**不必秒级**——
 * 红点晚一分钟亮没有代价，而每次进页面都重拉一轮会让 Tab 切换带上一串请求。
 * 写库之后由各处的 `invalidateAfterAiWrite` / 订单作废一并刷（见 `orders-invalidate.test`）。
 */
export function useNotifications() {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
    enabled: Boolean(token),
    staleTime: 60_000,
  })
}

/**
 * 读过**一条**（点开它、跳走之前调用）。
 *
 * 用户 2026-10-15 的原话：「需要**真的已读**时才清」「通知那边点进去才清除通知」——
 * 所以清的不是"整个区域"，是**这一条**。红点跟着重算（由后端算，前端不自己减 1：
 * 自己减的话"同一件事在多台设备上"这类边界会错）。
 */
export function useMarkRead() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<{ read: number }>('/notifications/read', { id })
      return data
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['notifications'] }) },
  })
}

/**
 * 一键已读：只标**当前列表里**那些（`ids` 由调用方从列表取）。
 *
 * 不写成"把这个账号所有未读都标掉"：那会把他在别的页面上还没看到过的东西一起吞掉
 * （"我明明没看过那条，它怎么就没了"）。后端也只认传过去的那些 id。
 */
export function useMarkAllRead() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await apiClient.post<{ read: number }>('/notifications/read-all', { ids })
      return data
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['notifications'] }) },
  })
}

export function useUpdateNotificationPrefs() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<NotificationPrefs>) => {
      const { data } = await apiClient.post<NotificationPrefs>('/notifications/prefs', patch)
      return data
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['notifications'] }) },
  })
}

/** 四条提醒的说明文案（开关那一页要用；**只有一份**，不散在界面里） */
export const NOTIFICATION_KINDS: { key: keyof NotificationPrefs; title: string; desc: string }[] = [
  { key: 'mealPlan', title: '菜单安排', desc: '家里人把某一天的菜单定下来了' },
  { key: 'mealDone', title: '饭已做好', desc: '我点过菜的哪一餐做好了' },
  { key: 'expiry', title: '快过期', desc: '冰箱里有东西快到期，或者已经过期了' },
  { key: 'prep', title: '该备菜了', desc: '接下来几天还有餐次没安排' },
]
