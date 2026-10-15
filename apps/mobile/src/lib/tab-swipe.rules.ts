/*
 * 「跟手左右翻页」的判定（用户 2026-10-15 两轮要求：先是「这种 tab 页需要能左右滑动切换」，
 * 看完之后又提「左右滚动要有切页动画啊，好像 el-tab 和原生那样的，要跟随手指拖动，
 * 滑到中间时，两个页是都能看见的」）。
 *
 * 与上一版（抬手即切）的区别：现在是**跟手**的——按下、判方向、跟着手指一路移，抬手才决定去留。
 * 所以这个文件里全是"位移/速度 → 怎么办"的纯函数。难点不在动画，而在**什么时候算"在翻页"、
 * 什么时候算"在滚页面"、什么时候根本不该接**；那些时机在组件里没法单独验（与
 * `long-press.ts`、`scroll-memory.ts` 同一条理由：判定拿出来才钉得住）。
 *
 * ## 为什么还是不用 antd-mobile 的 `Swiper`（同一个问题第二遍，重新查了一遍类型声明）
 *
 * - `Swiper` **确实能做到"滑到中间两页都在"**（它有 `trackOffset` 跟手拖动），这是这一轮新查到的；
 *   仍然不用的原因是**滚动模型**：它是定高轮播，每一页自己的内容要在那个定高盒子里滚。
 *   而本项目整页只有**一个**滚动容器（`.tab-layout__body`）：滚动位置记忆（D-083）、
 *   换页不卸载的页面缓存、列表的无限滚动哨兵**都挂在它上面**。让每一页各自滚 = 这三件事
 *   全都要重做一遍（每页一个滚动容器、位置记忆按页存、哨兵换 root、页头条区变成固定不滚）。
 *   为一个切页动画付这个代价不划算，所以：**tab 条继续用组件，滑动这一层用自己的纯规则**。
 * - 判定的量都写在下面这几个常量里，改手感只改这里。
 */

/** 横向"接过来"的门槛（px）：在这之前不动手，纵向滚动时的手指抖动不该带偏页面 */
export const SWIPE_LOCK_DX = 8

/** 横向意图：横向位移要明显压过纵向（列表里几乎人人都是斜着划的） */
export const SWIPE_DIRECTION_RATIO = 1.6

/**
 * 屏幕左右边缘这条带**不接**：安卓/WebView 的边缘手势（返回上一页）从边缘起划，
 * 跟它抢没有好下场——用户想返回，结果只是换了个 tab。
 */
export const SWIPE_EDGE_GUARD = 24

/** 抬手时"翻过去"的门槛：走过这一页宽度的 22%（不看速度也能过） */
export const SWIPE_SETTLE_RATIO = 0.22

/**
 * 「甩」：够快就翻，不必走够 22%。
 *
 * 0.35 px/ms ≈ 350 px/s——比这更快的划动在日常里几乎一定是"想翻页"，
 * 而慢速的那一段则要求走够距离（否则"轻轻带一下"就换页，列表上会频繁误触）。
 */
export const SWIPE_FLICK_VX = 0.35

/** 但再快也得真的动过（px）：原地抖一下不算甩 */
export const SWIPE_FLICK_MIN_DX = 16

/** 手指停在半路超过这么久（ms）= 在犹豫，抬手就当没甩 */
export const SWIPE_FLICK_IDLE_MS = 100

/**
 * 算速度用的那一段至少要这么长（ms）。
 *
 * 不是为了手感，是为了**别被同一帧里的两个点骗了**：两次 move 之间只差零点几毫秒时，
 * 位移除以那个极小的 dt 会得到一个大得离谱的"速度"（60px / 0.5ms = 120 px/ms），
 * 于是"慢慢挪一下"也会被当成甩、直接翻页。真手指按不出这种数，但合并事件、节流、
 * 自动化派发都能造出来——那正是"为什么我轻轻一划就翻过去了"这类说不清的问题。
 */
export const SWIPE_VELOCITY_MIN_MS = 4

/** 到头那一侧继续拖的行进比例（橡皮筋：拉得动，但拉不远） */
export const SWIPE_RESISTANCE = 0.35

/** 落位动画时长（ms）：与 CSS 那边写的是同一个数（`ui.scss` 的 `.swipe-pager__track`） */
export const SWIPE_SETTLE_MS = 260

/** 手指位置与时刻（判"甩"用最近这一小段）。时刻取 `performance.now()`，与事件对象无关。 */
export interface SwipeSample {
  x: number
  t: number
}

/** 按下那一刻的事实（这一次手势期间不变） */
export interface SwipeStartFacts {
  /** 按下的横坐标 */
  startX: number
  /** 视口宽度（算右边那条边缘带） */
  viewportWidth: number
  /** 一共几页（只有一页就没什么可翻的） */
  total: number
  /**
   * 手势起点落在"自己要横着滚 / 明确不参与"的东西上。
   *
   * 最典型的是**筛选胶囊那一行**（`.chips`）与 tab 条本身：它们自己就能横着滚，
   * 在它们上面划动的意思是"看看后面还有什么选项"，不是"翻一页"。
   * 由 `SwipePager` 按 `data-no-swipe` 标出来（标在共享组件里，页面不用记）。
   */
  blocked: boolean
}

/**
 * 这一下划动算不算"在翻页"？
 * - `blocked`：根本不该接（见 `blocked` 与边缘带）；
 * - `pending`：还看不出意图（手指还没走够），什么都不做；
 * - `vertical`：那是想滚页面，这一下不再接（页面会照常滚）；
 * - `horizontal`：接过来，进入跟手拖动。
 */
export type SwipeIntent = 'blocked' | 'pending' | 'vertical' | 'horizontal'

export function swipeIntent(facts: SwipeStartFacts & { dx: number; dy: number }): SwipeIntent {
  const { dx, dy, startX, viewportWidth, total, blocked } = facts
  if (blocked) return 'blocked'
  if (total < 2) return 'blocked'
  if (startX < SWIPE_EDGE_GUARD || startX > viewportWidth - SWIPE_EDGE_GUARD) return 'blocked'
  return intentFromMove(dx, dy)
}

/** 上面那段里"看一眼位移"的部分：单独拆出来，好把边缘带/blocked 那两条与它分开测 */
function intentFromMove(dx: number, dy: number): SwipeIntent {
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  if (absX >= SWIPE_LOCK_DX && absX >= absY * SWIPE_DIRECTION_RATIO) return 'horizontal'
  // 纵向先走起来的：这一下交给页面滚（浏览器也会把它判成滚动），我们不再接
  if (absY > SWIPE_LOCK_DX && absY > absX) return 'vertical'
  return 'pending'
}

/**
 * 手指带着页面走：返回**实际画在屏幕上的**横向位移（右正左负）。
 *
 * 两处打折（橡皮筋），都是"到头了"的同一句话：
 * - **到头那一侧**（第一页再往右、最后一页再往左）——一寸都不给的话像卡住，1:1 跟手又像前面还有；
 * - **拖过一整页之后**——邻页已经整个进来了，再拉只会露白，所以超出那一页的部分打折。
 */
export function dragOffset(facts: {
  dx: number
  width: number
  index: number
  total: number
}): number {
  const { dx, width, index, total } = facts
  const towardNext = dx < 0
  const atEnd = towardNext ? index >= total - 1 : index <= 0
  if (atEnd) return dx * SWIPE_RESISTANCE
  const absX = Math.abs(dx)
  if (width > 0 && absX > width) {
    return Math.sign(dx) * (width + (absX - width) * SWIPE_RESISTANCE)
  }
  return dx
}

/**
 * 抬手速度（px/ms，右正左负）。
 *
 * 用**最近这一小段**（≈40ms）而不是整段：整段会被起步那一下拖平，而"最后猛地一甩"
 * 恰恰是用户想翻页最明确的表达。手指停在半路超过 `SWIPE_FLICK_IDLE_MS` 就当没甩——
 * 拖到一半停下来看看，不该因为他抬手时手指歪了一下就翻过去。
 */
export function releaseVelocity(samples: readonly SwipeSample[], now: number): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  if (now - last.t > SWIPE_FLICK_IDLE_MS) return 0
  let from = samples[0]
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    from = samples[i]
    if (last.t - samples[i].t >= 40) break
  }
  const dt = last.t - from.t
  if (dt < SWIPE_VELOCITY_MIN_MS) return 0
  return (last.x - from.x) / dt
}

/**
 * 抬手了：翻到第几页？回弹给 `null`。
 *
 * 两个门槛满足其一即可（距离够、或者甩得够快且方向一致）；到头那一侧一律 `null`
 * ——不循环：这是"翻页"，不是转盘。
 */
export function settleIndex(facts: {
  dx: number
  vx: number
  width: number
  index: number
  total: number
}): number | null {
  const { dx, vx, width, index, total } = facts
  const absX = Math.abs(dx)
  // 连"接过来"的门槛都没到，谈不上翻页（也顺带挡住 width=0 的退化情形）
  if (absX < SWIPE_LOCK_DX) return null
  const far = width > 0 && absX >= width * SWIPE_SETTLE_RATIO
  const flick = Math.abs(vx) >= SWIPE_FLICK_VX && absX >= SWIPE_FLICK_MIN_DX && vx * dx > 0
  if (!far && !flick) return null
  const next = index + (dx < 0 ? 1 : -1)
  return next >= 0 && next < total ? next : null
}
