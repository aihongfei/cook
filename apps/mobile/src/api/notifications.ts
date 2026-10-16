import { useEffect, useRef } from 'react'
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

export type NotificationKind =
  | 'plan' | 'done' | 'expiry' | 'prep'
  | 'order' | 'fridge' | 'checkin' | 'comment' | 'family' | 'recipe'

/**
 * 一条提醒**属于哪个区域**——与后端 `areaOfKind` 同一套分法。
 *
 * **这是前端唯一知道 kind 语义的地方**，而且只有这一处：底栏两个红点与「我的」页
 * 里那几行的小红点都从 `unreadByArea` 里取数（后端算好的），这里只决定"哪一行看哪个区域"。
 * 之所以需要它：`unreadByArea` 是个字典，而每个界面元素要回答"我看哪一格"——
 * 那一格的名字在这里，不在各页面里散着写（散着写就会出现"家庭那行去看 fridge 的红点"）。
 */
export type NotificationArea = 'order' | 'fridge' | 'family'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  /** 这条提醒对应的时刻（ISO） */
  at: string
  /** 点进去看哪儿——**后端给**，前端不按 kind 硬编码跳转表（与"状态机不硬编码"同一条） */
  to: string
  /**
   * 这条提醒**属于哪一餐**（`2026-10-18-DINNER`）；不属于某一餐时为 `null`
   * （快过期、该备菜、打卡、家庭、菜谱）。点单列表拿它把"这张卡有事没看过"标出来
   * （用户 2026-10-14 要求）。
   *
   * **不在前端从 `id` 或 `to` 里切字符串**：那种切法迟早切错（`prep` 里没有 mealKey、
   * `expiry` 指向冰箱），而"这一条对应哪一餐"是个事实，该由知道它的一侧给出。
   */
  mealKey: string | null
  /** 标题旁边那个小标（"选好了""加菜""入库"…） */
  tag: string
  /**
   * 这一条是**现算的**还是**当时写下的**（后端 `origin`）：
   * - `derived`（状态型：菜单定了/做好了/快过期/该备菜）说的是"现在家里有这件事"——
   *   那一餐被取消它就消失；
   * - `event`（事件型：点菜/冰箱/打卡/评论/家庭/菜谱）说的是"发生过这件事"——
   *   发生了就一直在，撤掉的那道菜不会因为没有那道菜了就没发生过。
   *
   * 界面**不必按它分支**（文案与去处都由后端给全），它如实反映列表会长什么样；
   * 目前只有一个地方用它，而且是在测试里（断言"事件型那几条不会自己消失"）。
   */
  origin: 'derived' | 'event'
  unread: boolean
}

export interface NotificationPrefs {
  mealPlan: boolean
  mealDone: boolean
  expiry: boolean
  prep: boolean
  orderChange: boolean
  fridgeChange: boolean
  checkin: boolean
  family: boolean
  recipe: boolean
}

export interface NotificationBoard {
  items: AppNotification[]
  /** 未读总数 */
  unread: number
  /**
   * 各区域的未读数——**红点直接用它**（用户 2026-10-15：「底部菜单，订单之类的
   * 也需要小红点」；2026-10-16 加了家事那一块）。不在前端把十类"三加一"再加一遍：
   * 那种算术写两处迟早有一处漏改（表现是"订单的红点少了一个"）。
   *
   * `family` 这一格**不亮底栏**（底栏五个 Tab 里没有打卡/家庭/菜谱的入口），
   * 它落在「我的」页对应的那几行上。
   */
  unreadByArea: Partial<Record<NotificationArea, number>>
  /** 各类提醒各自的未读数（通知中心里按类看） */
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

/**
 * 「到过那条提醒指向的地方」就算看过（用户 2026-10-14：「我点进去怎么还是菜单啊，
 * 没有去掉红点啊」）。
 *
 * 判据是**后端给的那个 `to`**，不是每个页面各写一条规则：提醒说"点这里看什么"，
 * 用户到了这里，这条提醒的使命就完成了。于是 `/order/<mealKey>`（菜单/做好了）、
 * `/prep`（该备菜）、`/fridge`（快过期）**一处生效、三处都对**，以后加新类别
 * 也不用回来改这段代码。
 *
 * 与 D-078 的「逐条已读」是同一条口径的延伸——那次是"点开通知中心里那一条"，
 * 这次是"点进了它指的地方"。**不是**"到过某个区域就全清"：别的餐、别的类别的
 * 未读一条都不动（所以仍然走"只标传过去的 id"这个接口）。
 *
 * 放在**外壳**（`TabLayout`）调用：所有页面都在它下面，判据只有这一份。
 */
export function useMarkArrived(pathname: string): void {
  /*
   * `mutate` 从 v5 起是**稳定引用**：不必把它包进 ref、也不必往依赖里塞整个 mutation
   * 对象（那会每次渲染都变，effect 就每次都跑）。
   */
  const { mutate: markRead } = useMarkAllRead()
  const { data } = useNotifications()
  /*
   * 发过一次的就别再发：`mutate` 到查询刷新之间会有几次重渲染，而这个 effect 每次
   * 都算一遍。一个 `Set` 记着"已经交出去的 id"，比在依赖数组里跟时间赛跑清楚。
   */
  const sent = useRef(new Set<string>())

  /*
   * 这一段**只读数据、不碰 ref**：`sent` 的读写全在下面的 effect 里——
   * 渲染期读 ref 是 React 明确不建议的（渲染必须能被重复执行而不产生副作用）。
   */
  const ids = (data?.items ?? [])
    .filter((item) => item.unread && item.to === pathname)
    .map((item) => item.id)
  const pendingKey = ids.join(';')

  useEffect(() => {
    if (!pendingKey) return
    const batch = pendingKey.split(';').filter((id) => !sent.current.has(id))
    if (batch.length === 0) return
    batch.forEach((id) => sent.current.add(id))
    markRead(batch)
  }, [pendingKey, markRead])
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

/**
 * 九个开关的说明文案（通知中心那一列要用；**只有一份**，不散在界面里）。
 *
 * 顺序就是界面上从上到下的顺序，**两类分开放**（先"家里的事"，后"我做的事"）：
 * 前四个是状态型（家里到了某个状态），后五个是事件型（谁做了什么）。
 * 用户 2026-10-16 说要的那四块（订单/冰箱/打卡/家庭/菜谱）就是下面这五个。
 *
 * `key` 直接是 `NotificationPrefs` 的键，所以与后端 `NOTIFICATION_PREF_KEYS` 一一对应；
 * 后端加一个开关时，这里的类型会报错（`Record` 少一项），不会静默漏掉。
 */
export const NOTIFICATION_KINDS: { key: keyof NotificationPrefs; title: string; desc: string }[] = [
  { key: 'mealPlan', title: '菜单安排', desc: '家里人把某一天的菜单定下来了' },
  { key: 'mealDone', title: '饭已做好', desc: '我点过菜的哪一餐做好了' },
  { key: 'expiry', title: '快过期', desc: '冰箱里有东西快到期，或者已经过期了' },
  { key: 'prep', title: '该备菜了', desc: '接下来几天还有餐次没安排' },
  { key: 'orderChange', title: '订单有变化', desc: '有人点了菜、退了菜、改人数、取消这一餐' },
  { key: 'fridgeChange', title: '冰箱有变化', desc: '有人往冰箱放了东西、改了或拿走了' },
  { key: 'checkin', title: '打卡墙', desc: '有人传了照片，或者在你的照片下说了话' },
  { key: 'family', title: '家庭有变化', desc: '有人加入或退出、角色变了、改了家庭设置' },
  { key: 'recipe', title: '菜谱有变化', desc: '家里自建的菜谱有人上传、改过或删掉了' },
]
