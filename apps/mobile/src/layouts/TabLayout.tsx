import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LeafSprig } from '@/components/icons/TabIcons'
import AiAssistantBall from '@/components/ai/AiAssistantBall'
import AiAssistantSheet from '@/components/ai/AiAssistantSheet'
import { useNotifications, useMarkArrived, type NotificationBoard } from '@/api/notifications'
import { useAiAssistantSession } from '@/stores/ai-assistant-session'
import { tabs } from '@/config/tabs'
import { tabOf } from '@/pages/back-link'
import { targetOf } from '@/lib/local-notify'
import { emitTabRetap } from '@/lib/tab-retap'
import { pageKeyOf, createScrollMemory } from '@/lib/scroll-memory'
import { setScrollReader } from '@/lib/back-transition'
import { syncBackGesture } from '@/lib/back-gesture'
import KeepAlivePages from './KeepAlivePages'
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
 * - 订单 ← 菜单安排 + 饭已做好 + 该备菜 + 点单变动（都是"吃"这件事）
 * - 冰箱 ← 快过期 + 冰箱变动
 * - 其余三个 Tab 不亮（厨房/发现/我的没有对应的提醒类别）
 *
 * 2026-10-16 扩了六类提醒（用户：「家庭相关修改的都需要通知」），其中打卡/评论/家庭/菜谱
 * 归 `family` 区域、**不亮底栏**——底栏五个 Tab 里没有它们的入口，
 * 红点落在「我的」页对应的那几行上（见 `MinePage`）。所以这个函数**不需要改**：
 * 它只认那两个有入口的 Tab，多出来的区域自然落在 `return 0` 上。
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
  /*
   * 「哪一页」= 路径 + 查询串：`/recipes?category=主食` 与 `/recipes` 是两页，
   * 各自记各自的位置（用户从某个分类进去、返回，该回到那个分类的那一处）。
   */
  const pageKey = pageKeyOf(location)
  const bodyRef = useRef<HTMLElement>(null)
  const assistantOpen = useAiAssistantSession((state) => state.open)
  /*
   * 滚动位置的记忆（见下面两个 effect）。
   *
   * 它同时**借给返回动画**（`lib/back-transition` 的 `setScrollReader`）：
   * 返回那一趟要把下层摆回它上次停的地方，而"上次停在哪儿"只有这张表知道
   * （表活在 ref 里、没有第二个出口，所以这里主动接上去；卸载时拔掉）。
   */
  const memoryRef = useRef(createScrollMemory())

  useEffect(() => {
    setScrollReader(memoryRef.current.read)
    return () => setScrollReader(null)
  }, [])

  /*
   * 换页时把滚动位置摆回**这一页上次停的地方**。
   *
   * 页面本身由 `KeepAlivePages` 缓存着（不卸载），但**滚动容器是共用的**（下面那个
   * `main`），所以位置得单独记——缓存能保住页面里的状态，保不住"滚到哪儿了"。
   *
   * 两个 effect 都用 `useLayoutEffect` 而不是 `useEffect`，这是**刻意的**：
   * 换页那一瞬间浏览器会把 `scrollTop` 夹一下（上一页被藏起来、容器变矮），
   * 于是会冒出一趟**带着假值**的滚动事件。布局阶段跑在浏览器处理那趟夹取之前，
   * 所以"卸掉旧监听 → 摆好新位置 → 挂上新监听"这一串能在假事件冒出来之前做完。
   * 换成 `useEffect`（画完之后才跑）就晚了：那一趟假值会被当成"用户滚到了 0"记下来。
   */
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const restored = memoryRef.current.read(pageKey)
    // jsdom 里 `scrollTo` 不存在（真实浏览器有），退回直接赋值
    if (typeof body.scrollTo === 'function') body.scrollTo({ top: restored })
    else body.scrollTop = restored
  }, [pageKey])

  /*
   * 滚动过程中随时记（按帧节流）：这是位置**唯一的来源**。
   *
   * 挂的是**当前这一页**的键，而卸载发生在布局阶段的清理里（早于浏览器的夹取），
   * 所以那趟假事件落不到这个监听上——不必再自己比对"现在还是不是我这一页"。
   */
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const key = pageKeyOf(location)
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        memoryRef.current.save(key, body.scrollTop)
      })
    }
    body.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      body.removeEventListener('scroll', onScroll)
    }
  }, [location])

  /*
   * 到了某条提醒指向的地方就算看过（用户 2026-10-14：「我点进去怎么还是菜单啊，
   * 没有去掉红点啊」）。判据是后端给的 `to`——一处生效、`/order/<mealKey>`、`/prep`、
   * `/fridge` 三处都对（见 `useMarkArrived` 的注释）。
   */
  useMarkArrived(pageKey)

  /*
   * 「这次返回归不归我们管」要跟着位置走（D-109）：子页归我们（要跟手、要播两层），
   * 厨房根页不归我们（那一下要让**系统**自己播"窗口缩回桌面"的退出预览）。
   *
   * 地址变化**不能**靠 `popstate` 监听：路由的编程式跳转不发那个事件。
   * 而"人在哪一页"是这一层每次渲染都知道的事实——所以挂在 `pathname` 上，
   * 换页就重算一次（`syncBackGesture` 内部对同值去重，不会反复跨桥调原生）。
   */
  useEffect(() => {
    syncBackGesture()
  }, [pathname])

  /*
   * 手机弹窗提醒的**排程**不在这里（M10 交付二）：它挂在 `main.tsx` 的根层上，
   * 因为**退出登录时也要清掉已排的提醒**——挂在布局里的话登录态组件一卸载，
   * 清理代码就永远不会跑（实测踩过：退出登录后 9 条闹钟还在）。见 lib/local-notify-sync 文件头。
   *
   * 这里只留"**点开手机上的那条提醒后跳到哪**"：那个要用 `navigate`，必须在路由里。
   */

  /*
   * 用户点了手机上的那条提醒：跳到它指的地方。
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

  /*
   * 菜谱列表/详情不在底部 Tab 里，要借一个 Tab 表示"人在哪一块"：
   * - **从哪个 Tab 进来的就亮哪个**（读 `state.from`，与返回按钮同一份来源）；
   * - 来源认不出（地址栏直接敲、或菜谱小书内部自己跳）才退回「厨房」——菜谱库本来就归厨房。
   * 原先一律亮厨房：从发现页「摇一道」过去后，用户点那个亮着的 Tab 会落到厨房菜单页，
   * 而他明明是从发现页过来的（实测踩过）。
   */
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
          页面**缓存**着（用户 2026-10-14：「你是不是使用类似vue keepalive那种就行了…
          相当于是有缓存的，不是重新加载页面」）：离开的页不卸载、只藏起来，回来时
          筛选、翻到第几页、输入框里的字、滚动位置都还在。

          原先这里是 `key={pathname}` 的强制重挂载（为了重播入场动画）——**那正是
          "返回就回到最上面"的根源**：页面整个重挂载，状态与位置一起没了。
          动画改挂到当前这一页的类名上（`activeTurnClass`），重挂载不再是它的前提。
        */}
        <KeepAlivePages activeTurnClass={turnClass} />
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
              /*
               * **replace**：底栏点多少次都不在历史里堆记录（2026-10-16 / D-105）。
               *
               * 用户报的：「连续点击菜单，然后返回都能一直返」——原来每点一个 Tab 压一条历史，
               * 返回键就一条条退回去。五个 Tab 是**平级的五个岛**，点它们是"换岛"不是"往下走"，
               * 不该留下可以退回去的脚印（与本项目页内 tab 用 replace 是同一条规矩，D-076）。
               *
               * 于是"从详情直接点去别的 Tab"也不再让那条详情留在历史里——
               * 用户报的第二件事正是它（「点击进入详情再点击其他菜单还能返回去详情」）。
               */
              replace
              aria-current={active ? 'page' : undefined}
              className={`tab-bar__item${active ? ' is-active' : ''}`}
              /*
                再点一次**当前**这个 Tab：喊一声，让页面自己决定"要不要带我去看什么"
                （用户 2026-10-14：「重复点击订单tab时自动滚到通知的那个卡片位置」）。
                外壳不算这件事——"哪一餐有事"的判据只有页面握着（见 lib/tab-retap 的说明）。
                从别的页点过来不算"再点"：那是一次正常跳转，页面本来就从头渲染。
              */
              onClick={() => {
                if (pathname === path) emitTabRetap(path)
              }}
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
