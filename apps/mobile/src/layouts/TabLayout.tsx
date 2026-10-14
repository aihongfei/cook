import { useEffect, useRef } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LeafSprig } from '@/components/icons/TabIcons'
import AiAssistantBall from '@/components/ai/AiAssistantBall'
import AiAssistantSheet from '@/components/ai/AiAssistantSheet'
import { useNotifications, type NotificationBoard } from '@/api/notifications'
import { useAiAssistantSession } from '@/stores/ai-assistant-session'
import { tabs } from '@/config/tabs'
import { tabOf } from '@/pages/back-link'
import { targetOf } from '@/lib/local-notify'
import { useLocalNotifySync } from '@/lib/local-notify-sync'
import { usePageTurn } from './use-page-turn'
import './TabLayout.scss'

/**
 * 某个 Tab 上该亮几条（M10 / D-078）。
 *
 * **抽成纯函数是为了能单独测**：这里有三条容易写错的判断——
 * ① 「该备菜」归**订单** Tab（它点进去是备菜页，而备菜是从订单那一支进去的）；
 * ② 没加入家庭 / 没登录 / 数据还没回来时**一条都不亮**（不能默认亮着）；
 * ③ 数字上限：超过 9 条显示 `9+`（三位数会把底栏撑变形）。
 *
 * 各 Tab 的分工（用户 2026-10-15 选定"各 Tab 各亮各的"）：
 * - 订单 ← 菜单安排 + 饭已做好 + 该备菜（都是"吃"这件事）
 * - 冰箱 ← 快过期
 * - 其余三个 Tab 不亮（厨房/发现/我的没有对应的提醒类别）
 */
export function tabBadge(path: string, board: NotificationBoard | undefined): number {
  if (!board) return 0
  // 数字由后端按区域算好（`unreadByArea`）——前端不再"三加一"加一遍：
  // 那种算术写两处，迟早有一处漏改（表现是"订单的红点少了一个"）
  const { unreadByArea } = board
  if (path === '/order') return unreadByArea.order ?? 0
  if (path === '/fridge') return unreadByArea.fridge ?? 0
  return 0
}

/**
 * 应用外壳：内容区（滚动） + 底部 5 Tab 导航。
 * 页面本身的边距/留白由各页面自己负责（用 <Page> 组件统一）。
 */
export default function TabLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { pathname } = location
  const bodyRef = useRef<HTMLElement>(null)
  const assistantOpen = useAiAssistantSession((state) => state.open)
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }) }, [pathname])

  /*
   * 手机弹窗提醒的排程与"点开跳到哪"都挂在这一层（M10 交付二）：
   * 它要**任意页都在**（数据变了就要重排），放在某一页里迟早漏。
   * 浏览器里这一整套是空转的：插件调用直接返回、一条都不排（见 lib/local-notify）。
   */
  useLocalNotifySync()

  /*
   * 菜谱列表/详情不在 Tab 里，要借一个 Tab 表示"人在哪一块"：
   * - **从哪个 Tab 进来的就亮哪个**（读 `state.from`，与返回按钮同一份来源）；
   * - 来源认不出（地址栏直接敲、或菜谱小书内部自己跳）才退回「厨房」——菜谱库本来就归厨房。
   * 原先一律亮厨房：从发现页「摇一道」过去后，用户点那个亮着的 Tab 会落到厨房菜单页，
   * 而他明明是从发现页过来的（实测踩过）。
   */
  /*
   * 用户点了手机上的那条提醒（M10 交付二）：跳到它指的地方。
   *
   * 这里的去处来自通知自己带的 `extra.to`（排的时候写进去的），不按"现在有什么提醒"重算——
   * 用户点的是**那条具体的提醒**，哪怕那件事已经变了（比如那一餐刚被取消），
   * 也应该带他去看那一餐现在什么样，而不是"因为已经不存在了就什么都不做"。
   */
  useEffect(() => {
    let handle: { remove: () => void } | null = null
    void (async () => {
      const { Capacitor } = await import('@capacitor/core')
      if (!Capacitor.isNativePlatform()) return
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      handle = await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
        const to = targetOf(event.notification.extra)
        if (to) navigate(to, { state: { from: '/notifications' } })
      })
    })()
    return () => handle?.remove()
  }, [navigate])

  const recipeOwner = tabOf((location.state as { from?: unknown } | null)?.from)
  const isRecipePage = pathname === '/recipes' || pathname.startsWith('/recipes/')
  const borrowedTab = isRecipePage ? recipeOwner ?? '/kitchen' : null

  /*
   * 换页方向（用户 2026-10-14：「前进后退没有那种左右翻页的效果」）。
   *
   * 原来只有一条淡入上浮，**进和退播的是同一个**，于是"往里进"和"往回退"分不出来。
   * 方向由 `usePageTurn` 在渲染期间算好（不能在 effect 里算：那时第一帧已经画完了），
   * 它返回的是**要挂的类名修饰**（`--forward` / `--back` / `--fade`），
   * 动画放完会自己返回空串——那种"动画压根不跑就永远 opacity:0"的情况因此不会发生
   * （见 `use-page-turn` 里那段说明）。
   */
  const turnClass = usePageTurn()

  // 未读红点（M10）：在**外壳**这一层问一次，五个 Tab 共用这一份（不在每个 Tab 里各问一次）
  const notifications = useNotifications()

  return (
    <div className="tab-layout">
      <main ref={bodyRef} className="tab-layout__body">
        {/*
          key=pathname：换页时把这一层重挂载一次，让入场动画重新播。不这么做的话新页面只是
          "啪"地替换掉旧页面（用户 2026-10-12：「整个系统都是不要生硬的」）——CSS 动画只在
          元素挂载时播一次，同一个 DOM 节点换了内容不会重播。
        */}
        <div className={['tab-layout__page', turnClass].filter(Boolean).join(' ')} key={pathname}>
          <Outlet />
        </div>
      </main>

      <nav className="tab-bar">
        {tabs.map(({ path, label, Icon }) => {
          /*
           * 这里用 Link 不用 NavLink：NavLink 自己算 active 并在最后覆盖 aria-current，
           * 而"借来的 Tab"恰恰是路由看不出来的状态——NavLink 表达不了它（传了也会被丢掉，
           * 于是样式亮着、无障碍状态却是空的，自己写的测试当场抓出来的）。
           * 改成自己算，两个高亮（class 与 aria-current）就同源于一个判断，不会再分叉。
           */
          const active = path === borrowedTab || pathname === path || pathname.startsWith(`${path}/`)
          const badge = tabBadge(path, notifications.data)
          return (
            <Link
              key={path}
              to={path}
              aria-current={active ? 'page' : undefined}
              className={`tab-bar__item${active ? ' is-active' : ''}`}
            >
              <Icon width={23} height={23} />
              <span>{label}</span>
              {/*
                未读红点（M10 / F10-04，D-078）：**各 Tab 各亮各的**（用户 2026-10-15 选定）——
                「菜单/饭好了」亮订单、「快过期」亮冰箱、「该备菜」也亮订单（它点进去是备菜页，
                而备菜是从订单那一支进去的）。放在文字**右上角**而不是图标上：图标是线稿，
                盖上去会糊；而且这个位置与"角标"的通用直觉一致。
                `aria-label` 里说清有几条——读屏用户看不到那个圆点。
              */}
              {badge > 0 && (
                <i className="tab-bar__dot" aria-hidden="true">
                  {badge > 9 ? '9+' : badge}
                  {/*
                    数量要让读屏也能听到：`<i>` 上的 aria-label 在多数读屏里不被朗读
                    （它是装饰元素），所以数量以一段视觉隐藏的文字另说一遍。
                  */}
                </i>
              )}
              {badge > 0 && <span className="tab-bar__sr">{`${label}有 ${badge} 条未读`}</span>}
              <i className="tab-bar__bar" />
            </Link>
          )
        })}
        <LeafSprig className="tab-bar__deco tab-bar__deco--left" />
        <LeafSprig className="tab-bar__deco tab-bar__deco--right" />
      </nav>

      {/*
        全局 AI 助手（F16-10 / D-052）：入口与抽屉都放在外壳这一层——
        它要**任意页都在**，写在页面里迟早漏一个，而新页面会忘。
        对话状态在 store 里、且落盘（见 stores/ai-assistant-session），所以收起抽屉、换页、
        甚至刷新页面都不丢；抽屉本身按开合挂载（与发现页那两个抽屉同一做法）。
      */}
      <AiAssistantBall />
      {assistantOpen && <AiAssistantSheet />}
    </div>
  )
}
