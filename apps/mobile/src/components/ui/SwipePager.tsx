import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  SWIPE_SETTLE_MS,
  dragOffset,
  releaseVelocity,
  settleIndex,
  swipeIntent,
  type SwipeIntent,
  type SwipeSample,
  type SwipeStartFacts,
} from '@/lib/tab-swipe.rules'

/**
 * 页内 tab 的**跟手翻页**（用户 2026-10-15 两轮：先要"能左右滑动切换"，看完之后要
 * 「左右滚动要有切页动画啊，好像 el-tab 和原生那样的，要跟随手指拖动，滑到中间时，两个页是都能看见的」）。
 *
 * 用法：把要能滑的那一组内容**按页**交给它——`renderPanel(key)` 负责画第 key 页：
 * ```tsx
 * <SwipePager keys={tabs.map(t => t.key)} activeKey={tab} onChange={setTab}
 *             renderPanel={(key) => <List category={key} />} />
 * ```
 *
 * ## 三件事刻意的
 *
 * 1. **只有当前页常在 DOM 里，邻居是"临时挂上"的**：手指横向走够 8px、判定成翻页的那一刻，
 *    才把那一侧的邻居挂进来（于是"滑到中间两页都能看见"成立），落位动画结束后立刻摘掉。
 *    为什么不做成"三页常驻"：邻居的数据要现取（我的菜谱那三页各是一个请求），常驻等于进页面
 *    就发三个请求，而用户可能一次都不滑。
 * 2. **跟手那段自己写 transform，不走 React**：拖动时每帧都在变，走 state 会把这几页长列表
 *    按 60 次/秒重渲染。**整个组件从不在 JSX 里写 `style.transform`**（会与手写的那份打架），
 *    只在 `paint()` 一处写。
 * 3. **可见性不依赖动画跑没跑**：落位靠**定时器**收尾（不用 `transitionend`——动效被系统关掉时
 *    它永远不来），而且终态（哪一页在屏上）只由 `rendered` / transform 的终值决定。
 *    这是 `TabLayout.scss` 里记过的那条纪律：WebView 节流时动画可能压根不跑，
 *    那时页面也必须是**能看见的、正确的**。
 *
 * ## 为什么触摸不走 React 的 onTouchMove
 *
 * React 17 起把 `touchmove` 挂在根容器上、而且是 **passive** 的，里面 `preventDefault()`
 * 无效（浏览器直接忽略）。而"接过来之后拦住默认行为"正是跟手拖动成立的前提：
 * `touch-action: pan-y` 是**手势开始时**就定下的、中途改不了——不拦的话浏览器仍会把这趟手势
 * 当成纵向滚动，页面跟着手指上下晃，还会用 `pointercancel` 把我们收走。所以触摸走
 * `addEventListener(..., { passive: false })`（见下面那个 effect），鼠标/触控板那条路才用 React 的
 * Pointer 事件（它不需要 preventDefault，也需要不了 pointercancel）。
 *
 * 判定全在 `@/lib/tab-swipe.rules`（纯函数、有单测）；这里只负责"把手势翻译成那份事实、
 * 把 transform 画上去"。`data-no-swipe`（`Chips` 那一行、tab 条自己）一律不接——
 * 在它们上面划动的意思是"看后面的选项"，标记打在共享组件里，页面不用记。
 */
interface SwipePagerProps {
  /** 全部页的 key（顺序就是左右顺序） */
  keys: readonly string[]
  /** 当前页 */
  activeKey: string
  onChange: (key: string) => void
  /** 画第 key 页的内容。邻居页也会被调用（那就是"滑到中间两页都能看见"），页面要保证能画 */
  renderPanel: (key: string) => ReactNode
  className?: string
  /**
   * **整屏**：让这套翻页占满父元素剩下的高度（用户 2026-10-16：「改成三个 tab 可以互相滑动的，
   * 整屏滑动，并高度要自适应」）。
   *
   * 不传时的高度是"当前那一页内容有多高"——短内容会把可滑的区域缩成窄窄一条，
   * 滑动看着不像翻页（像是卡片自己在动）、在空白处划也没有反应。
   * 传了之后：翻页区撑到屏幕底部，**每一页至少占满这块高度**（短内容不留"半数高度"的观感），
   * 于是"整屏滑过去"成立；而内容比屏幕高时它照旧被顶高、页面正常滚
   * （`min-height` 不是 `height`，长内容一个字都不会被裁）。
   *
   * 它要求父元素能算出剩余高度（`Page` 的 `page__body` 就是一个 flex 列），
   * 所以只在与固定页头同一套骨架里用（见 `Page.tsx`）。
   */
  fill?: boolean
}

/**
 * 手势期间那份临时状态。放 ref 不放 state：拖动时每帧都在变（见文件头第 2 条），
 * 而它一变就要重渲染的话，跟手就会卡。
 */
interface Gesture {
  status: SwipeIntent
  /** 按下那一刻的事实（起手位置、视口宽度、几页、是否落在 `data-no-swipe` 上）——手势期间不变 */
  facts: SwipeStartFacts
  /** 按下的纵坐标：判"这一下是想滚页面还是想翻页"要用它（`facts` 里只有横向的起手位） */
  startY: number
  /** 按下时在第几页 */
  index: number
  lastX: number
  /** 最近这几个点（判"甩"用，见 `releaseVelocity`） */
  samples: SwipeSample[]
}

/** 抬手之后那次 click 的吐掉期限（同 `long-press.ts` 的理由：那次 click 可能压根不来） */
const SWALLOW_CLICK_MS = 1500

export default function SwipePager({
  keys,
  activeKey,
  onChange,
  renderPanel,
  className,
  fill,
}: SwipePagerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const swallow = useRef(false)
  const swallowTimer = useRef<number | null>(null)
  /** 上一次画的是**哪一页**（用来判断"这次该不该带动画"——点 tab 与滑动落位都会改 activeKey） */
  const paintedKey = useRef(activeKey)

  /** 现在挂在 DOM 里的页。静止时只有当前页，拖动/落位期间才含邻居 */
  const [rendered, setRendered] = useState<string[]>([activeKey])
  /** >0 = 正在落位（过渡打开）。每 +1 都重开一次收尾计时 */
  const [settleSeq, setSettleSeq] = useState(0)

  // 这几个每次渲染都可能变的东西放 ref：手势回调与定时器要读**最新**的值，又不该因此重新绑定
  const keysRef = useRef(keys)
  const activeKeyRef = useRef(activeKey)
  const onChangeRef = useRef(onChange)
  /** 落位是否还在进行（手势起手时要"先把上一段收尾"，但平时别为一次轻点白白重渲染一遍） */
  const settlingRef = useRef(false)
  useEffect(() => {
    keysRef.current = keys
    activeKeyRef.current = activeKey
    onChangeRef.current = onChange
  })

  const activeIndex = Math.max(0, keys.indexOf(activeKey))

  /** 把"第几页 + 手指带了多少"画上去。`animate=false` 就是跟手（绝不能有过渡，否则手指和页面会脱节） */
  const paint = useCallback((index: number, dx: number, animate: boolean) => {
    const track = trackRef.current
    if (!track) return
    track.style.transition = animate
      ? `transform ${SWIPE_SETTLE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
      : 'none'
    // 基准用百分比、跟手用像素：百分比随容器宽度自己走（转屏/分屏不用重算），
    // 跟手那一段必须按像素才像"跟着手指"
    track.style.transform = `translate3d(calc(${-index * 100}% + ${dx}px), 0, 0)`
  }, [])

  const startSettle = useCallback(() => {
    settlingRef.current = true
    setSettleSeq((seq) => seq + 1)
  }, [])

  /** 落位收尾：把邻居摘掉、过渡关掉。终态由这一次渲染决定，不依赖动画 */
  const finishSettle = useCallback(() => {
    settlingRef.current = false
    setSettleSeq(0)
    setRendered([activeKeyRef.current])
  }, [])

  /*
   * 收尾只认定时器，**不认 `transitionend`**：动效被系统关掉（`prefers-reduced-motion`）
   * 或 WebView 节流时它压根不来，那时"两页同时在、谁都不在正确位置"会一直挂着。
   * 多等 60ms 没有代价——那时候邻居已经在屏外了。
   */
  useEffect(() => {
    if (settleSeq === 0) return
    const timer = window.setTimeout(finishSettle, SWIPE_SETTLE_MS + 60)
    return () => window.clearTimeout(timer)
  }, [settleSeq, finishSettle])

  /** 把某一页挂进 DOM（已经在就不动——`setRendered` 返回同一个引用时 React 自己会跳过） */
  const showPanel = useCallback((index: number) => {
    const key = keysRef.current[index]
    if (key === undefined) return
    setRendered((prev) => (prev.includes(key) ? prev : [...prev, key]))
  }, [])

  const start = useCallback(
    (x: number, y: number, target: Element | null) => {
      // 上一段落位还没收尾就又要划：先把上一段结束掉（不然"两页同时在"会叠起来）
      if (settlingRef.current) finishSettle()
      gesture.current = {
        status: 'pending',
        facts: {
          startX: x,
          viewportWidth: window.innerWidth,
          total: keysRef.current.length,
          // 标记打在共享组件里（`Chips` 那一行、tab 条自己），页面不用记
          blocked: Boolean(target?.closest('[data-no-swipe]')),
        },
        startY: y,
        index: Math.max(0, keysRef.current.indexOf(activeKeyRef.current)),
        lastX: x,
        samples: [{ x, t: performance.now() }],
      }
    },
    [finishSettle],
  )

  const move = useCallback(
    (x: number, y: number, preventDefault: () => void) => {
      const current = gesture.current
      if (!current || current.status === 'blocked' || current.status === 'vertical') return
      current.lastX = x
      const dx = x - current.facts.startX
      if (current.status === 'pending') {
        // 边缘带、`data-no-swipe`、"只有一页"都在 swipeIntent 里判——判出来才真的动手
        const intent = swipeIntent({ ...current.facts, dx, dy: y - current.startY })
        if (intent !== 'horizontal') {
          current.status = intent
          return
        }
        current.status = 'horizontal'
      }
      // 他要往哪翻，那一页就得先在 DOM 里（反悔往另一边划时，另一边也得在）
      showPanel(dx < 0 ? current.index + 1 : current.index - 1)
      current.samples.push({ x, t: performance.now() })
      if (current.samples.length > 10) current.samples.shift()
      // 接过来之后必须拦住默认行为（见文件头"为什么触摸不走 React 的 onTouchMove"）
      preventDefault()
      paint(
        current.index,
        dragOffset({
          dx,
          width: rootRef.current?.clientWidth ?? 0,
          index: current.index,
          total: current.facts.total,
        }),
        false,
      )
    },
    [paint, showPanel],
  )

  const end = useCallback(
    (x: number) => {
      const current = gesture.current
      gesture.current = null
      if (!current || current.status !== 'horizontal') return
      // 拖动之后的这一次 click 不是"点击"，吐掉（同 long-press：不吐的话松手会顺手点进详情）
      swallow.current = true
      if (swallowTimer.current !== null) window.clearTimeout(swallowTimer.current)
      swallowTimer.current = window.setTimeout(() => {
        swallow.current = false
        swallowTimer.current = null
      }, SWALLOW_CLICK_MS)

      const now = performance.now()
      const dx = x - current.facts.startX
      const vx = releaseVelocity([...current.samples, { x, t: now }], now)
      const target = settleIndex({
        dx,
        vx,
        width: rootRef.current?.clientWidth ?? 0,
        index: current.index,
        total: current.facts.total,
      })
      if (target !== null && target !== current.index) {
        // 交给 onChange：父组件改了 activeKey，下面那个 layout effect 会带着过渡画过去——
        // 于是落位这一路"两页同时在"照样成立（正是用户要的那一半）
        showPanel(target)
        startSettle()
        onChangeRef.current(keysRef.current[target])
        return
      }
      // 没够（或到头了）→ 弹回去，也走一次落位动画
      paint(current.index, 0, true)
      startSettle()
    },
    [paint, showPanel, startSettle],
  )

  /*
   * 触摸这一路（非 passive，见文件头）。挂在原生监听上而不是 JSX 属性上，
   * 就是因为 React 的 touchmove 是 passive 的、`preventDefault()` 无效。
   */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onTouchStart = (event: TouchEvent) => {
      // 双指（缩放、多指手势）不接：那不是在翻页
      if (event.touches.length > 1) {
        gesture.current = null
        return
      }
      const touch = event.touches[0]
      if (!touch) return
      start(touch.clientX, touch.clientY, event.target as Element | null)
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
    /*
     * `touchcancel` 按**抬手**处理，不是按"取消"：能把它发过来的是系统手势或"浏览器开始滚了"，
     * 而那时手指已经横向走过一段了——按抬手判（够远就翻）正是用户的意思。
     * 若当成"取消"，用户会遇到本项目最怕的那类问题：**划了没反应，还不知道为什么**。
     */
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

  // 鼠标/触控板（开发时在桌面浏览器里试）：同一条状态机，只是不用拦默认行为
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      // jsdom 与老 WebView 里可能没有这个方法（拿不到捕获也不影响后面那几步：事件仍会冒泡到这一层）
      event.currentTarget.setPointerCapture?.(event.pointerId)
      start(event.clientX, event.clientY, event.target as Element | null)
    },
    [start],
  )
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') return
      move(event.clientX, event.clientY, () => event.preventDefault())
    },
    [move],
  )
  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') return
      end(event.clientX)
    },
    [end],
  )
  const onPointerCancel = useCallback(() => {
    if (!gesture.current) return
    end(gesture.current.lastX)
  }, [end])

  /** 拖动之后紧跟着的那一次 click 不是点击（见 end 里那段），在这一层拦住 */
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

  /*
   * 画基准：**任何**改 activeKey 的路都走这里（点 tab、滑动落位、地址栏直接改），
   * 于是"点 tab 也有横移动画"这一件事不需要在别处再写一遍。
   * 正在跟手时不画——这一趟由手指说了算。
   */
  useLayoutEffect(() => {
    if (gesture.current?.status === 'horizontal') return
    const previous = paintedKey.current
    const changed = previous !== activeKey
    paintedKey.current = activeKey
    if (changed) {
      /*
       * 两页一起挂上：出去的那一页要在落位动画期间**还留在屏上**（否则点 tab 就是硬切，
       * 而用户要的正是"两个页都能看见"那一半）；进来的那一页也得挂（它可能压根没渲染过）。
       */
      setRendered((prev) => {
        const next = new Set(prev)
        next.add(activeKey)
        next.add(previous)
        return next.size === prev.length ? prev : [...next]
      })
    }
    paint(activeIndex, 0, changed || settleSeq > 0)
    // 页换了就收尾（把邻居摘掉）；没换也要跑一次，好让"过渡打开着"这件事有个结束
    if (changed) startSettle()
  }, [activeKey, activeIndex, rendered, settleSeq, paint, startSettle])

  return (
    <div
      ref={rootRef}
      className={['swipe-pager', fill && 'swipe-pager--fill', className].filter(Boolean).join(' ')}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div ref={trackRef} className="swipe-pager__track">
        {rendered.map((key) => {
          const index = keys.indexOf(key)
          const isActive = key === activeKey
          return (
            <div
              key={key}
              className={['swipe-pager__panel', isActive && 'is-active'].filter(Boolean).join(' ')}
              // 每一页按**序号**定位（不随当前页变）：换页时只有轨道在动，页自己不动，
              // 于是 React 的重渲染不会跟过渡动画打架
              style={{ left: `${Math.max(0, index) * 100}%` }}
              data-panel-key={key}
              /*
               * 邻居是"屏外那一半"：读屏别念它、鼠标也别点它。
               * （它只活到落位结束，不会长期留在无障碍树里，所以用 aria-hidden 而不是 inert 就够。）
               */
              aria-hidden={isActive ? undefined : true}
            >
              {renderPanel(key)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
