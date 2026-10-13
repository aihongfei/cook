import { tabs } from '@/config/tabs'

/**
 * 换页往哪个方向滑（用户 2026-10-14：「前进后退没有那种左右翻页的效果」）。
 *
 * 原来的换页只有一条淡入上浮（`page-in`），**前进和后退播的是同一个动画**，
 * 于是"往回退"和"往里进"在观感上分不出来——用户说的"没有左右翻页的效果"就是这个。
 *
 * 三档：`forward`（从右边推进来）/ `back`（从左边回来）/ `fade`（那条中性的淡入上浮）。
 *
 * **不是从路由层级算出来的**：本应用的路由表是**平的**（`/recipes/:id` 与 `/order`
 * 是兄弟，没有父子嵌套），所以没有"深度"这个量可用。真正的判据是
 * **这一页是从哪儿来的**——每个子页面跳进来时都会在 state 里带上 `from`
 * （`readBackLink` 那一套本来就是做这个用的）。
 */
export type PageTurn = 'forward' | 'back' | 'fade'

export interface PageTurnInput {
  /** 上一个页面的路径（带查询串的按整串比） */
  from: string
  /** 新页面的路径 */
  to: string
  /** 上一个页面**自己的** state（它就是跳进来时收到的那个，里面可能有 `from`） */
  fromState: unknown
  /**
   * 这一次导航是不是浏览器级的"后退"。
   *
   * 传 `useNavigationType()` 的值：在 data router 下它是**当前这个 location 自己的
   * 动作**（`POP` / `PUSH` / `REPLACE`），也就是"我是怎么到这儿的"。
   * 安卓返回键与系统手势返回都走 POP——那条路上界面上没有「← 返回」可点，
   * 光看 `state.from` 认不出来（被退回去的那一页的 state 是它自己的旧 state）。
   */
  navigationType?: string
}

/** 底部五个岛之间互跳（`/kitchen`、`/order` …） */
function isTabPath(path: string): boolean {
  const bare = path.split('?', 1)[0]
  return tabs.some((tab) => tab.path === bare)
}

/** 取 state 里的 `from`（不可信输入，认不出来当 null） */
function fromOf(state: unknown): string | null {
  const raw = (state as { from?: unknown } | null)?.from
  return typeof raw === 'string' && raw !== '' ? raw : null
}

const bare = (path: string) => path.split('?', 1)[0]

export function pageTurn({ from, to, fromState, navigationType }: PageTurnInput): PageTurn {
  // 同一个地址（例如在详情页点自己的链接）不该动
  if (from === to) return 'fade'

  /*
   * 浏览器说这次是**后退**：直接按 back 播，不再看别的判据。
   *
   * 这一条必须排在 Tab 那条前面：从某个二级页按返回键退回底栏那个 Tab 时，
   * 两边确实"有一个是 Tab"，但那趟就是往回退（用户按的是返回键，
   * 播成"平级切换"的淡入会让他以为返回没生效）。
   */
  if (navigationType === 'POP') return 'back'

  /*
   * 往回退：**上一个页面记的"来处"正是我现在要去的地方**。
   *
   * 拿 `/recipes/abc`（从 `/recipes` 进来，state.from = '/recipes'）举例：
   * 点「← 返回菜谱」时 `to` 正是 `/recipes`，与 `fromState.from` 相等 → back。
   *
   * 比的是**去掉查询串的路径**：列表页带 `?category=汤` 时，详情页记下的
   * from 是带查询串的整串，而返回链接指向的也是那一串——但两者不必每次都完全一致
   * （用户可能在详情页里改了筛选又返回），按路径比更稳。
   */
  const cameFrom = fromOf(fromState)
  if (cameFrom !== null && bare(cameFrom) === bare(to)) return 'back'

  /*
   * 落在底栏五个岛上：**不进也不退**。
   *
   * 判据是"**目的地**是 Tab"（不是"两边都是 Tab"）——第一版写的是后者，实测漏了一种：
   * 从打卡墙（二级页）点底栏的「厨房」，两边不都是 Tab，于是被判成 forward、从右边滑进来，
   * 而那看起来像"厨房在打卡墙的下一层"。
   *
   * 道理是**到达顶层永远是"回家"，不是"往里进"**：底栏那五个是平级的五个岛，
   * 从哪儿点到它们都是横跳，不是越走越深。真正该滑的两条路（返回、进二级页）
   * 已经在上面两条判据里分完了，走到这里的一定不是它们。
   */
  if (isTabPath(to)) return 'fade'

  return 'forward'
}
