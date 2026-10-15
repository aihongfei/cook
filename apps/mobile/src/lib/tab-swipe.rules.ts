/*
 * 「左右滑动切换 tab」的判定（用户 2026-10-15：「类似这种 tab 页（全部、已安排、已做好）
 * 包括我的菜谱中收藏、我的菜谱这种 tab 页需要能左右滑动切换」）。
 *
 * 单独一个文件、写成纯函数，理由与 `long-press.ts` 完全一样：**难点全在"什么时候不算滑动"**，
 * 而那些时机在组件里没法单独验（列表里划一下到底该翻页还是该滚页面，只有把判定拿出来才好钉住）。
 *
 * ## 为什么不直接用 antd-mobile 的 Swiper
 *
 * 项目里已经在用 antd-mobile 的 `Tabs`（tab 条那部分就是它），而它没有滑动切换；
 * 能滑的那个是同一个包里的 `Swiper`，但 `Swiper` 是**定高轮播**（`--height` / `slideSize`，
 * 内容要放进它自己的 transform 轨道里）——这几页的 tab 内容是**长列表**：整页只有一个滚动容器
 * （`.tab-layout__body`，见 `layouts/KeepAlivePages` 的滚动位置记忆与列表的无限滚动哨兵）。
 * 把长列表塞进定高轨道要先量高再动画，那会同时弄坏无限滚动与"换页保留滚动位置"。
 * 所以：**tab 条继续用组件（antd-mobile `Tabs`），滑动这一件小事用这个纯规则 + `SwipeArea`**。
 */

/** 触发换页所需的最小横向位移（px）。太小会和"点一下"、和滚动时的抖动混在一起 */
export const SWIPE_MIN_DX = 56

/** 横向意图：横向位移要明显大过纵向，否则那是在滚页面（列表里几乎人人都是斜着划的） */
export const SWIPE_DIRECTION_RATIO = 1.6

/**
 * 屏幕左右边缘这一段**不接**：安卓/WebView 的边缘手势（返回上一页）从边缘起划，
 * 跟它抢没有好下场——用户想返回，结果只是换了个 tab。
 */
export const SWIPE_EDGE_GUARD = 24

export interface SwipeFacts {
  /** 抬手时相对按下的横向位移（右正左负） */
  dx: number
  /** 同上的纵向位移 */
  dy: number
  /** 按下的位置（用来避开边缘手势区） */
  startX: number
  /** 视口宽度（算右边那条边缘带） */
  viewportWidth: number
  /** 当前是第几个（0 起） */
  index: number
  /** 一共几个 */
  total: number
  /**
   * 手势起点落在"自己要横着滚 / 明确不参与"的东西上。
   *
   * 最典型的是**筛选胶囊那一行**（`.chips`）与 tab 条本身：它们自己就能横着滚，
   * 在它们上面划动的意思是"看看后面还有什么选项"，不是"换一页"。
   * 由 `SwipeArea` 按 `data-no-swipe` 标出来（标在共享组件里，页面不用记）。
   */
  blocked: boolean
}

/**
 * 这次划动该切到第几个 tab？不该切就给 `null`（调用方据此什么都不做）。
 *
 * 方向按手机上的惯例：**往左划（dx < 0）看下一个**，往右划看上一个。
 */
export function swipeTargetIndex(facts: SwipeFacts): number | null {
  const { dx, dy, startX, viewportWidth, index, total, blocked } = facts
  if (blocked) return null
  if (total < 2) return null
  if (index < 0 || index >= total) return null
  if (Math.abs(dx) < SWIPE_MIN_DX) return null
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTION_RATIO) return null
  // 边缘那一条带留给系统手势（见 SWIPE_EDGE_GUARD）
  if (startX < SWIPE_EDGE_GUARD || startX > viewportWidth - SWIPE_EDGE_GUARD) return null

  const next = dx < 0 ? index + 1 : index - 1
  // 到头的方向不做任何事（不循环：这是"翻页"，不是转盘）
  return next >= 0 && next < total ? next : null
}
