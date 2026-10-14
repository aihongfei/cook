import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { pageTurn, type PageTurn } from './page-turn'

/** 换页动画时长（与 TabLayout.scss 里的三条 `animation` 一致） */
export const PAGE_TURN_MS = 240

interface Applied {
  /** 这一趟动画属于**哪个页面**（pathname，不含查询串） */
  page: string
  turn: PageTurn
  /** 动画已经收工：不再挂类（见下面那段"保命的一条"） */
  retired: boolean
}

/**
 * 换页动画的**类名修饰**（返回 `''` = 不挂任何动画类）。
 *
 * 方向是**两个页面之间的关系**，只看当前这一个 location 算不出来——所以这里记着上一页。
 * 五件事刻意的：
 *
 * - **在渲染期间就把方向定下来**，不留到 `useEffect`：effect 在浏览器画完之后才跑，
 *   那时新页面已经按默认方向播完第一帧了，动画会先闪一下再纠正。这里走的是 React
 *   官方那条"渲染中调整 state"的写法——`setState` 之后 React 会**立刻**重渲染，
 *   而且**不画**中间那一帧，所以第一帧就是对的方向；
 * - **上一页记在 `useEffect` 里**（不在渲染中写 ref）：StrictMode 会把渲染跑两遍，
 *   在渲染里写 ref 会让"上一页"在第二次渲染时变成"当前页"，方向就永远是 fade；
 * - **"换页"的判据是 pathname，不是整条地址**：页面内那些把状态存进查询串的控件
 *   （「我的菜谱」三个 tab 的 `?tab=`、菜谱小书的品类/菜系 `?category=`）改的是
 *   **同一个页面**的内容，不是换了一页。原先拿 `pathname + search` 当判据，于是点一个
 *   tab 会**整页重播入场动画**：页头、"我的菜谱"标题、tab 条一起变成透明的再从右边滑进来
 *   ——用户 2026-10-15 报的「这三个切换时，页面会抖；还有首页那些 tab 的，没加载过的
 *   第一次点会闪现一下」就是这个。
 *
 *   实测（未加载过的 tab 第一次点）拿到的顺序是：URL 先变 → 内容换成加载态 →
 *   整页掉到 `opacity: 0` → 数据到了（此时才开始淡入，量到 `opacity 0.06` 时卡片已经在了）
 *   → 一路淡到 1。看上去就是"闪一下"；
 * - **动画类只挂一小会儿，到点摘掉**（见下面那段注释——这是保命的一条），
 *   收工状态跟着**页面**走：同一个页面上改查询串不会把已收工的动画重新挂回来；
 * - **首次进入应用仍然播那条淡入**（与换页前一致），不做特殊化。
 */
export function usePageTurn(): string {
  const location = useLocation()
  const navigationType = useNavigationType()
  const previous = useRef<{ path: string; state: unknown } | null>(null)

  const page = location.pathname
  const current = `${location.pathname}${location.search}`
  const [applied, setApplied] = useState<Applied>({ page, turn: 'fade', retired: false })

  if (applied.page !== page) {
    const prior = previous.current
    setApplied({
      page,
      // 没有上一页（首次渲染）时把 from 传成 to：`pageTurn` 里 from === to 直接给 fade
      turn: pageTurn({
        from: prior?.path ?? current,
        to: current,
        fromState: prior?.state,
        navigationType,
      }),
      retired: false,
    })
  }

  /*
   * **动画类到点就摘掉**——这不是锦上添花，是保命的一条。
   *
   * 摘掉之后这一层回到基础样式，而基础样式就是"完全可见"的那一份（没有 opacity、
   * 没有 transform）。为什么必须有这一手：**CSS 动画可能压根不跑**——
   * WebView 被节流、系统把动画关掉、或者渲染进程正忙，动画会一直停在第一帧，
   * 而第一帧是 `opacity: 0`。那一刻起页面**永远看不见**：底栏与 AI 球还在（它们在
   * 这一层之外），内容区却是一片空白，点一下屏幕才出现。
   *
   * 这个现象是 2026-10-14 装机复验时真撞上的：模拟器上装完包第一次打开，
   * 内容区空白了两分多钟，点了一下底栏才画出来；同一时刻在浏览器里量这一层的
   * computed style，正是 `opacity: 0` 且动画的 `currentTime` 停在 0。
   *
   * 所以规矩是：**内容的可见性不许依赖动画跑没跑**。动画只是"跑得到就好看一点"，
   * 跑不到也必须看得见。
   */
  useEffect(() => {
    if (applied.retired) return
    const timer = setTimeout(() => setApplied((state) => ({ ...state, retired: true })), PAGE_TURN_MS + 80)
    return () => clearTimeout(timer)
  }, [applied.page, applied.retired])

  useEffect(() => {
    previous.current = { path: current, state: location.state }
  }, [current, location.state])

  // 还没应用（同一帧内就会应用）时不挂类，避免抖一下
  if (applied.page !== page) return ''
  // 这一页的动画已经收工（或正在收工）：不挂类 = 基础样式 = 一定看得见
  if (applied.retired) return ''
  return `tab-layout__page--${applied.turn}`
}
