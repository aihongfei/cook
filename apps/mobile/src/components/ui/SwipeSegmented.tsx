import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  SWIPE_SETTLE_MS,
  dragOffset,
  releaseVelocity,
  settleIndex,
  swipeIntent,
  type SwipeIntent,
  type SwipeSample,
} from '@/lib/tab-swipe.rules'
import './ui.scss'

/**
 * 分段切换（全家点菜单 / 只看我的），**左右划也能换**。
 *
 * 用户 2026-10-16 的口径是「段控也能滑」——订单页那个问题我给的推荐是"段控点、内容滑"，
 * 用户选了相反的一边，那就照做。同一批要求里他也说过 tab 类的东西「要跟随手指拖动」，
 * 所以这里**不是**"划一下抬手才换"，而是滑块跟着手指走、抬手落位（与 `SwipePager` 同一套判定）。
 *
 * ## 为什么单独一个组件，而不是塞进 `SwipePager`
 *
 * `SwipePager` 的一页是**整屏宽**的（`left: i*100%`）：它翻的是"一屏内容"。
 * 段控的滑块只有 1/n 宽（两个并排的文字），几何对不上。
 * 判定那部分**一个字都没重写**——`swipeIntent` / `dragOffset` / `releaseVelocity` / `settleIndex`
 * 全从 `@/lib/tab-swipe.rules` 来（那些纯函数有单测），这里只负责"把手势翻译成那份事实、
 * 把滑块画上去"。
 *
 * ## 两条纪律（与 `SwipePager` 一致，理由各自那一处）
 *
 * 1. **跟手那段自己写 transform、不走 React**：拖动时每帧都在变，走 state 会把这一页重渲染 60 次/秒。
 *    `/ 整个组件从不在 JSX 里写 `style.transform``——只在 `paint()` 一处写。
 * 2. **触摸不走 React 的 `onTouchMove`**：React 17 起那条是 passive 的，`preventDefault()` 无效，
 *    而"接过来之后拦住默认行为"正是跟手成立的前提（详见 `SwipePager` 文件头）。
 *
 * ## `data-no-swipe` 标在自己身上
 *
 * 段控本身不会再横着滚（就两个选项，不像 tab 条），所以它**可以**接这一下划动；
 * 但万一将来它被放进某个 `SwipePager` 里，外层就该让开——标一句，省得那天出"两个东西一起动"。
 *
 * ⚠️ 与页面里那些 tab 条的分工：**在哪个开关上划，就换哪个开关**。
 * tab 条（`FilterTabs` / `Chips`）自己会横着滚，"在它上面划"的意思是"看后面的选项"，照旧不接
 * （那两处标着 `data-no-swipe`）。段控没有可滚的内容，这一下就归它自己。
 */
interface SwipeSegmentedProps {
  items: readonly { key: string; title: string }[]
  activeKey: string
  onChange: (key: string) => void
  className?: string
  /** 给读屏的一句说明：这组开关在换什么（如「看谁的」） */
  label: string
}

/** 手势期间那份临时状态。放 ref 不放 state：见文件头第 1 条 */
interface Gesture {
  status: SwipeIntent
  startX: number
  startY: number
  /** 按下时在第几格 */
  index: number
  lastX: number
  samples: SwipeSample[]
}

/** 抬手之后那次 click 的吐掉期限（不吐的话，划过去会被紧跟着的点击再切回来） */
const SWALLOW_CLICK_MS = 1500

/**
 * 交还指针捕获（只有真的接管过才交还；理由与写法见 `SwipePager` 里同名那个函数）。
 */
function releaseCapture(el: Element, captured: { current: number | null }) {
  const id = captured.current
  if (id === null) return
  captured.current = null
  try {
    el.releasePointerCapture?.(id)
  } catch {
    // 已经自己丢了——没什么要做的
  }
}

export default function SwipeSegmented({
  items,
  activeKey,
  onChange,
  className,
  label,
}: SwipeSegmentedProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const swallow = useRef(false)
  const swallowTimer = useRef<number | null>(null)

  const total = items.length
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey),
  )

  // 手势回调与定时器要读**最新**的值，又不该因此重新绑定（与 SwipePager 同一做法）
  const itemsRef = useRef(items)
  const activeKeyRef = useRef(activeKey)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    itemsRef.current = items
    activeKeyRef.current = activeKey
    onChangeRef.current = onChange
  })

  /** 把滑块画上去。`animate=false` 就是跟手（绝不能有过渡，否则手指和滑块会脱节） */
  const paint = useCallback((index: number, dx: number, animate: boolean) => {
    const thumb = thumbRef.current
    if (!thumb) return
    thumb.style.transition = animate
      ? `transform ${SWIPE_SETTLE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
      : 'none'
    // 基准用百分比、跟手用像素：百分比是"滑块的宽度"（见 ui.scss 那段算式），一格就是 100%，
    // 格与格之间那个 8px 的间隙单独加（`--segment-gap` 就定义在 `.segmented--swipe` 上）
    thumb.style.transform =
      `translate3d(calc(${index * 100}% + ${index} * var(--segment-gap, 8px) + ${dx}px), 0, 0)`
  }, [])

  /*
   * 画基准：**任何**改 activeKey 的路都走这里（点某一格、划动落位），
   * 于是"点一下滑块也会滑过去"不需要在别处再写一遍。正在跟手时不画——这一趟由手指说了算。
   */
  const paintedIndex = useRef(activeIndex)
  useLayoutEffect(() => {
    if (gesture.current?.status === 'horizontal') return
    const changed = paintedIndex.current !== activeIndex
    paintedIndex.current = activeIndex
    paint(activeIndex, 0, changed)
  }, [activeIndex, paint])

  const start = useCallback((x: number, y: number) => {
    gesture.current = {
      status: 'pending',
      startX: x,
      startY: y,
      // 按下那一刻在第几格：与 activeIndex 同一个算法，但**当场定下**（手势期间不改）
      index: Math.max(
        0,
        itemsRef.current.findIndex((item) => item.key === activeKeyRef.current),
      ),
      lastX: x,
      samples: [{ x, t: performance.now() }],
    }
  }, [])

  const move = useCallback(
    (x: number, y: number, preventDefault: () => void) => {
      const current = gesture.current
      if (!current || current.status === 'blocked' || current.status === 'vertical') return
      current.lastX = x
      const dx = x - current.startX
      if (current.status === 'pending') {
        // 边缘带、"只有一格"都在 swipeIntent 里判（`blocked` 传 false：段控自己接这一下，见文件头）
        const intent = swipeIntent({
          startX: current.startX,
          viewportWidth: window.innerWidth,
          total: itemsRef.current.length,
          blocked: false,
          dx,
          dy: y - current.startY,
        })
        if (intent !== 'horizontal') {
          current.status = intent
          return
        }
        current.status = 'horizontal'
      }
      current.samples.push({ x, t: performance.now() })
      if (current.samples.length > 10) current.samples.shift()
      preventDefault()
      paint(
        current.index,
        dragOffset({
          dx,
          width: rootRef.current?.clientWidth ?? 0,
          index: current.index,
          total: itemsRef.current.length,
        }),
        false,
      )
    },
    [paint],
  )

  const end = useCallback(
    (x: number) => {
      const current = gesture.current
      gesture.current = null
      if (!current || current.status !== 'horizontal') return
      /*
       * 划动之后紧跟着的那一次 click 不是"点击"，吐掉——不吐的话它落在按下的那一格上，
       * 会把刚落位的选择**立刻切回去**（与 `long-press.ts` / `SwipePager` 同一条）。
       */
      swallow.current = true
      if (swallowTimer.current !== null) window.clearTimeout(swallowTimer.current)
      swallowTimer.current = window.setTimeout(() => {
        swallow.current = false
        swallowTimer.current = null
      }, SWALLOW_CLICK_MS)

      const now = performance.now()
      const dx = x - current.startX
      const vx = releaseVelocity([...current.samples, { x, t: now }], now)
      const target = settleIndex({
        dx,
        vx,
        width: rootRef.current?.clientWidth ?? 0,
        index: current.index,
        total: itemsRef.current.length,
      })
      const nextKey = target === null ? undefined : itemsRef.current[target]?.key
      if (nextKey !== undefined) {
        // 先带着过渡画到那一格，再让父组件改 activeKey（上面那个 layout effect 会画同一个值，不打架）
        paint(target as number, 0, true)
        onChangeRef.current(nextKey)
        return
      }
      // 没够（或到头了）→ 弹回去
      paint(current.index, 0, true)
    },
    [paint],
  )

  /* 触摸这一路（非 passive，见文件头第 2 条） */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        gesture.current = null
        return
      }
      const touch = event.touches[0]
      if (!touch) return
      start(touch.clientX, touch.clientY)
    }
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      move(touch.clientX, touch.clientY, () => event.preventDefault())
    }
    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0]
      end(touch ? touch.clientX : (gesture.current?.lastX ?? 0))
    }
    // `touchcancel` 按**抬手**处理（理由见 SwipePager：按"取消"会让用户遇到"划了没反应"）
    const onTouchCancel = () => end(gesture.current?.lastX ?? 0)
    root.addEventListener('touchstart', onTouchStart, { passive: true })
    root.addEventListener('touchmove', onTouchMove, { passive: false })
    root.addEventListener('touchend', onTouchEnd, { passive: true })
    root.addEventListener('touchcancel', onTouchCancel, { passive: true })
    return () => {
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('touchend', onTouchEnd)
      root.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [start, move, end])

  // 鼠标/触控板（开发时在桌面浏览器里试）
  /**
   * 鼠标这一路**已经接管**的那个指针。放 ref 不放 state：手势期间的事实，变它不该触发重渲染。
   *
   * ⚠️ 与 `SwipePager` 里同一处坑、同一份修法（用户 2026-10-16：「滚动里面的卡片都不能点击了」）：
   * **在 pointerdown 就 `setPointerCapture` 会让 click 落到这一层上**——捕获会把配对的
   * `mouseup` 也改派过来，于是浏览器算出的 click 目标变成"按下处与抬起处的最近公共祖先"。
   * 段控自己也是按钮：那样一来**点某一格就换不了**（正是"点了没反应"）。
   * 所以接管推迟到确认"这是在划"的那一刻（`onPointerMove` 里读 `move` 改的状态）。
   */
  const capturedPointer = useRef<number | null>(null)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      start(event.clientX, event.clientY)
    },
    [start],
  )
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') return
      move(event.clientX, event.clientY, () => event.preventDefault())
      if (gesture.current?.status === 'horizontal' && capturedPointer.current === null) {
        event.currentTarget.setPointerCapture?.(event.pointerId)
        capturedPointer.current = event.pointerId
      }
    },
    [move],
  )
  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') return
      releaseCapture(event.currentTarget, capturedPointer)
      end(event.clientX)
    },
    [end],
  )
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      releaseCapture(event.currentTarget, capturedPointer)
      if (!gesture.current) return
      end(gesture.current.lastX)
    },
    [end],
  )

  /** 划动之后那一次 click 在这一层拦住（见 end 里那段） */
  const onClickCapture = useCallback((event: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (!swallow.current) return
    swallow.current = false
    if (swallowTimer.current !== null) {
      window.clearTimeout(swallowTimer.current)
      swallowTimer.current = null
    }
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return (
    <div
      ref={rootRef}
      className={['segmented', 'segmented--swipe', className].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={label}
      data-no-swipe
      // 格数给样式算滑块宽度（`--segments`，见 ui.scss）
      style={{ '--segments': Math.max(1, total) } as CSSProperties}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* 跟着手指走的滑块。位置全部由 paint() 手写——这里不写 transform */}
      <span ref={thumbRef} className="segmented__thumb" aria-hidden="true" />
      {items.map((item, index) => {
        const isActive = item.key === activeKey
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            // 给测试与调试一个稳定的把手（格号就是左右顺序）
            data-segment-index={index}
            className={['segmented__item', isActive && 'is-active'].filter(Boolean).join(' ')}
            onClick={() => onChange(item.key)}
          >
            {item.title}
          </button>
        )
      })}
    </div>
  )
}
