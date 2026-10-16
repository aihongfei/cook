import { create } from 'zustand'
import { pageIdentityOf } from './scroll-memory'

/**
 * 返回这一趟的**两层动画**（用户 2026-10-16：「需要返回那种从底层页面上方划过的那种效果，
 * 就和原生那种似的」）。
 *
 * ## 为什么现在才做得到
 *
 * 从 2026-10-14 起页面是**缓存**着的（`KeepAlivePages`，D-083）：离开的那一页不卸载、
 * 只是藏起来。所以"要回去的那一页"此刻就躺在 DOM 里——两层同时在屏上不再需要额外代价。
 *
 * ## 两层怎么摆
 *
 * | 层 | 谁的 DOM | 摆法 | 动作 |
 * | --- | --- | --- | --- |
 * | 上层 | **要离开的那一页** | `position: fixed` + 自己的滚动 | 从 0 滑到 100%（向右划走） |
 * | 下层 | **要回去的那一页** | 同上 | 从 -14% 轻轻跟进到 0 |
 *
 * 两层都 `fixed`（各自带自己的滚动位置），**屏上没有任何一层依赖主体的滚动条**——
 * 这是踩过才知道的一条：第一版把下层留在文档流里（想让滚动位置自然对上），
 * 结果两层一动，主体那个滚动容器的内容高度就变了，浏览器当场把 `scrollTop` 夹到 0，
 * 滚动记忆那一趟 rAF 正好把夹过的值记下来（R-65 那一族）。两层都拿出去之后，
 * 主体高度只剩一个**撑高的占位块**（见下），滚动位置在整趟动画里纹丝不动。
 *
 * ## 进度不进 React
 *
 * 手指拖动时每一帧都要改位移（交付三）。进 store 等于每帧重渲染整个外壳（缓存里最多 6 页），
 * 所以拖动进度走**一个 CSS 变量**（文档根上的 `--back-progress`），由 `lib/back-gesture` 直接写；
 * store 里只有"哪两层、现在处于哪一档、两层各自的滚动位置"。
 *
 * 松手那一段不需要写变量：位移的目标值由 CSS 类给出（100% / 0），浏览器从"当前算出来的值"
 * （拖动到的位置）过渡过去——拖到一半松手是**接着走**，不是从头再来。
 *
 * ## 三条兜底（R-61 的规矩：动画不许决定内容可见性）
 *
 * 1. **看门狗**：进入动画档就上闹钟，超时强制收尾——CSS 过渡万一不跑（WebView 被节流、
 *    系统把动画关掉），上层不会永远盖着屏幕；
 * 2. **上层的第一帧就是"当前这一页原样"**（不是空白），收尾状态是"已滑出屏外"；
 * 3. **换页即作废**：这一趟还在飞的时候用户又去了别的页（点底栏、点通知），立刻收掉。
 *
 * ## 与"换页动画"的分工
 *
 * `use-page-turn` 的 `--back`（新页从左边滑进来）在**返回**这一档上不再出场：
 * 这条路上现在有两层，再让新页自己滑一次就是各滑各的。`usePageTurn` 会在这次导航时
 * 看到 `isBackTransitionActive()` 为真、当场把这一趟标成"不挂动画类"。
 * `--back` 仍然服务另一个入口：浏览器里直接调 `history.back()` 那种不经过本模块的返回。
 */
export const BACK_ANIMATION_MS = 240

/** 下层跟进的比例（-14% → 0）。取 14% 而不是"跟满"：两层位移相同就成了硬切，没有层次 */
export const BACK_ENTER_PARALLAX = 14

export type BackPhase = 'idle' | 'dragging' | 'animating'

interface BackTransitionState {
  phase: BackPhase
  /** 要离开的那一页（缓存键 = 路径） */
  leaveKey: string
  /** 要回去的那一页（缓存键 = 路径） */
  enterKey: string
  /** 离开那一页自己的滚动位置（它变成 fixed 层之后要自己带滚动，见文件头） */
  leaveScroll: number
  /** 要回去那一页自己的滚动位置（同上：它也得摆在"用户离开时的样子"上） */
  enterScroll: number
}

export const useBackTransition = create<BackTransitionState>()(() => ({
  phase: 'idle',
  leaveKey: '',
  enterKey: '',
  leaveScroll: 0,
  enterScroll: 0,
}))

/** 目标地址 → 页面键（去掉查询串：查询串是页内状态，D-091） */
export function enterKeyOf(to: string): string {
  return pageIdentityOf({ pathname: to.split('?', 1)[0] })
}

/** 现在这一页的键（动画要去缓存里找的键就是它） */
function currentKey(): string {
  return pageIdentityOf(window.location)
}

export function isBackTransitionActive(): boolean {
  return useBackTransition.getState().phase !== 'idle'
}

/* ------------------------------------------------------------------ 与外壳的接线 */

/**
 * 主体那个滚动容器。**为什么是查 DOM**：它归 `TabLayout` 所有，而"记住的滚动位置"
 * 只有它手上有（`scroll-memory` 的表在它的 ref 里）；这里要读的是**当前**位置
 * （离开的那一页此刻就滚在那儿），不是记忆里的值——所以直接问 DOM 最短。
 */
function bodyEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.tab-layout__body')
}

function bodyScrollTop(): number {
  return bodyEl()?.scrollTop ?? 0
}

/**
 * 滚动记忆的读取口（由 `TabLayout` 在挂载时接上）。
 *
 * 拖动预览要用：两层都要摆在**各自上次停的地方**，不然用户看到的是两页的页头。
 * 卸载时置空——那张表随外壳实例一起消失（见 scroll-memory 的说明）。
 */
let readScroll: ((key: string) => number) | null = null

export function setScrollReader(reader: ((key: string) => number) | null): void {
  readScroll = reader
}

/**
 * 缓存里现在有哪些页（由 `KeepAlivePages` 每次渲染同步）。
 *
 * 拖动**预览**的前提是"要回去的那一页已经在缓存里"——不在就没得预览
 * （冷启动深链直达详情那种）。这时不开始拖动：松手后照常整段播一遍动画，
 * 比拖着一层空白走要诚实得多。
 */
let previewKeys = new Set<string>()

export function setPreviewKeys(keys: string[]): void {
  previewKeys = new Set(keys)
}

/**
 * 缓存页自己的 location.state（由 `KeepAlivePages` 接上）。
 *
 * **为什么必须把它带回去**：返回用的是 `replace`，而 react-router 的 `replace`
 * 不会自动恢复目标那条历史记录的 state——不带的话，退回去的那一页会以为
 * "我是直接敲地址进来的"，它的返回箭头于是退到兜底页。
 * 实例：通知中心 → 某一餐 → 某道菜的菜谱 → 返回这一餐 →**这一页的返回箭头该回通知中心**，
 * 不带 state 就退回点菜单（D-079 / D-082 好不容易接上的那一段会断）。
 */
let readCachedState: ((key: string) => unknown) | null = null

export function setCachedStateReader(reader: ((key: string) => unknown) | null): void {
  readCachedState = reader
}

/** 退到 `to` 时该交还给它的 state（缓存里没有这一页就返回 undefined，兜底页照常） */
export function cachedStateOf(to: string): unknown {
  const state = readCachedState?.(enterKeyOf(to))
  return state ?? undefined
}

/* ------------------------------------------------------------------ 动画档 */

let watchdog: ReturnType<typeof setTimeout> | null = null

function stopWatchdog(): void {
  if (watchdog !== null) clearTimeout(watchdog)
  watchdog = null
}

function setIdle(): void {
  stopWatchdog()
  document.documentElement.style.setProperty('--back-progress', '0')
  useBackTransition.setState({ phase: 'idle', leaveKey: '', enterKey: '' })
}

function armWatchdog(): void {
  stopWatchdog()
  watchdog = setTimeout(() => {
    // 到点就收尾：CSS 过渡跑没跑过都要收（R-61 的规矩，见文件头）
    if (useBackTransition.getState().phase === 'animating') setIdle()
  }, BACK_ANIMATION_MS + 120)
}

function begin(to: string, phase: 'dragging' | 'animating'): void {
  const enterKey = enterKeyOf(to)
  useBackTransition.setState({
    phase,
    leaveKey: currentKey(),
    enterKey,
    leaveScroll: bodyScrollTop(),
    // 下层摆在它上次停的地方：拖动露出来的那一角得是"用户离开时的样子"
    enterScroll: readScroll?.(to) ?? 0,
  })
}

/**
 * 开始一趟返回动画（松手那一档：0 → 1 直接播）。
 *
 * 页面上那颗「← 返回」与系统返回键都走 `startBackNavigation`（在下面），
 * 这一条是它的"没有拖动"分支。
 */
export function beginBackTransition(to: string): void {
  if (isBackTransitionActive()) return
  begin(to, 'animating')
  armWatchdog()
}

/**
 * 拖动开始（交付三：系统的预测式返回把手指进度送进来）。
 *
 * @returns 预览得了吗——`false` 时调用方**什么都不用做**：
 *   不接管位移，松手时照常整段播一遍（走 `startBackNavigation` 的 idle 分支）。
 */
export function beginBackDrag(to: string): boolean {
  if (isBackTransitionActive()) return false
  const enterKey = enterKeyOf(to)
  if (enterKey === currentKey()) return false
  if (!previewKeys.has(enterKey)) return false

  begin(to, 'dragging')
  document.documentElement.style.setProperty('--back-progress', '0')
  return true
}

/** 手指移动（0→1）。只写一个 CSS 变量，不进 React（见文件头） */
export function setBackDragProgress(progress: number): void {
  if (useBackTransition.getState().phase !== 'dragging') return
  const clamped = Math.max(0, Math.min(1, progress))
  document.documentElement.style.setProperty('--back-progress', String(clamped))
}

/** 拖到一半又缩回去：这一趟作废（两层各自回到原样，主体从头到尾没动过） */
export function cancelBackDrag(): void {
  if (useBackTransition.getState().phase !== 'dragging') return
  setIdle()
}

/**
 * **返回这一趟的统一入口**（页内箭头与系统返回键、按钮与手势都走它）。
 *
 * 三种情况一句话说清：
 * - 正在拖动（手势松手）：接着当前进度播完；
 * - 正在播（连按返回、箭头的连点）：忽略这一下，别把已经开始的这趟打断；
 * - 什么都没发生（按钮返回、以及"预览不了"的手势）：整段起跳。
 */
export function startBackNavigation(to: string): void {
  const { phase } = useBackTransition.getState()
  if (phase === 'dragging') {
    useBackTransition.setState({ phase: 'animating' })
    armWatchdog()
    return
  }
  if (phase === 'animating') return
  beginBackTransition(to)
}

/** 立刻收尾（看门狗到点、换页发现这一趟已作废） */
export function finishBackTransitionNow(): void {
  if (!isBackTransitionActive()) return
  setIdle()
}

/** 测试用：把模块级的接线与状态复位（用例之间必须互不影响） */
export function resetBackTransition(): void {
  stopWatchdog()
  readScroll = null
  previewKeys = new Set()
  readCachedState = null
  document.documentElement.style.removeProperty('--back-progress')
  useBackTransition.setState({
    phase: 'idle',
    leaveKey: '',
    enterKey: '',
    leaveScroll: 0,
    enterScroll: 0,
  })
}
