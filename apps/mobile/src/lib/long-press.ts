import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/*
 * 长按（用户 2026-10-15：「订单里面的卡片要能删除，可以用那个按住显示单选框」）。
 *
 * 单独一个文件是为了**能单测那份判定**（与 `lib/scroll-memory.ts`、`lib/tab-retap.ts` 同一条理由）：
 * 长按的难点全在"什么时候**不算**长按"，而那些时机在组件里没法单独验。
 *
 * 三件事让"按住"在手机上真的成立（少一件都会被系统抢走）：
 * - **移动超过阈值就取消**：列表里按住是为了滚动，手指一动就该把这次长按丢掉，
 *   否则用户一滚列表就莫名其妙进了选择模式；
 * - **`contextmenu` 要拦**：安卓 WebView 里长按会弹系统的"复制/搜索"菜单，
 *   不拦的话我们的选择模式还没出来，系统菜单先盖上来（本项目已全局禁文本选中，
 *   但 contextmenu 是另一条路）；
 * - **触发之后要吃掉紧随其后的那一次 click**：手指抬起时浏览器还会补一个 click，
 *   不吞掉的话"长按选中"会被紧接着的点击又取消一次（表现为"按半天没选上"）。
 *
 * ## 2026-10-15 就修在这里：**取消不能只等"自己元素上的移动"**
 *
 * 做跟手翻页时抓出来的真 bug：手指慢慢横着划过一张卡（>500ms 才走完），**长按计时器先到了**，
 * 于是"想翻页"变成了"进了多选"。原因是取消监听挂在卡片自己身上——手指一旦滑出那张卡，
 * 后续的移动就不再落在它头上（事件 target 变成了别的元素），卡片一次 `pointermove` 都收不到，
 * 计时器就没人清。
 *
 * 所以现在**起手之后在 window 上补一份监听**（`pointermove` / `pointerup` / `pointercancel`，
 * 都用 capture）：手指走到哪儿都算数。三件配套的事：
 * - 只在"按下到取消/触发"这一段挂着，结束就摘（不长驻，也不影响别的手势）；
 * - 监听里**不看 target**：任何移动都算"手指动了"，这正是我们要的判据；
 * - `touchmove` 也听一份：安卓 WebView 里 pointer 事件并非总是跟着触摸派发（实测同一趟手势
 *   里只有 `pointerdown` 到了，后面的移动只有 `touchmove`），只信 pointer 会漏。
 */

/** 按住多久算长按 */
export const LONG_PRESS_MS = 500
/** 手指/鼠标移动超过这么多像素就不算长按（那是在滚动或在拖） */
export const LONG_PRESS_SLOP = 10
/**
 * 「吐掉紧随的那一次 click」这个标记的有效期。
 *
 * 正常情况下抬手补的那次 click 在几毫秒内就到，用不到这个兜底。但如果那次 click
 * **根本没来**（按住之后把手指拖到卡片外面再松手，click 落在公共祖先上，或者压根没有），
 * 标记就会一直挂着，把**下一次**点击也吐掉——表现为"点一下没反应"，
 * 正是 R-66 记的那类"看着像卡死、其实是状态没清"的问题。所以让它自己过期。
 */
export const LONG_PRESS_SWALLOW_MS = 1500

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void
  onPointerMove: (event: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onPointerLeave: () => void
  onContextMenu: (event: { preventDefault: () => void }) => void
}

export function useLongPress(
  onLongPress: () => void,
  options: { disabled?: boolean } = {},
): { handlers: LongPressHandlers; consumeClick: () => boolean } {
  const { disabled = false } = options
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  /** 这一次交互已经变成"长按"了：紧随其后的 click 要吐掉（见文件头） */
  const fired = useRef(false)
  /** 上面那个标记的兜底过期计时器（见 LONG_PRESS_SWALLOW_MS） */
  const swallowTimer = useRef<number | null>(null)
  // handle 存 ref：调用方每次渲染都传新箭头函数，写进依赖会让计时器每次重渲染都重来
  const callback = useRef(onLongPress)
  useEffect(() => {
    callback.current = onLongPress
  }, [onLongPress])

  /** 正在 window 上挂着的那份"手指动到哪儿都算"的监听（见文件头） */
  const watch = useRef<{ stop: () => void } | null>(null)
  const stopWatch = useCallback(() => {
    watch.current?.stop()
    watch.current = null
  }, [])

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
    stopWatch()
  }, [stopWatch])

  const clearSwallowTimer = useCallback(() => {
    if (swallowTimer.current !== null) {
      window.clearTimeout(swallowTimer.current)
      swallowTimer.current = null
    }
  }, [])

  /**
   * 起手之后在 **window** 上补一份监听：`pointermove` / `touchmove` / `pointerup` / `pointercancel`。
   *
   * 为什么非要 window：卡片自己只收得到"落在卡片上"的移动，手指一滑出去它就再也听不见了，
   * 于是那个 500ms 的计时器没人清、慢慢横划一下反而进了选择模式（真机上抓到的，见文件头）。
   * 为什么 `touchmove` 也要听：实测同一趟手势里 pointer 移动可能一个都不派发，
   * 只有 `touchmove` 有——只信 pointer 就会漏掉一整类设备。
   */
  const startWatch = useCallback(() => {
    stopWatch()
    const start = () => origin.current
    const onMove = (event: PointerEvent | TouchEvent) => {
      const from = start()
      if (!from) return stopWatch()
      const point = 'touches' in event ? event.touches[0] : (event as PointerEvent)
      if (!point) return
      if (Math.hypot(point.clientX - from.x, point.clientY - from.y) > LONG_PRESS_SLOP) cancel()
    }
    const onEnd = () => cancel()
    // capture：别的层 `stopPropagation` 也拦不住这一份（我们要的是"手指动了"这个事实）
    const options = { capture: true, passive: true } as const
    window.addEventListener('pointermove', onMove, options)
    window.addEventListener('touchmove', onMove, options)
    window.addEventListener('pointerup', onEnd, options)
    window.addEventListener('pointercancel', onEnd, options)
    watch.current = {
      stop: () => {
        window.removeEventListener('pointermove', onMove, options)
        window.removeEventListener('touchmove', onMove, options)
        window.removeEventListener('pointerup', onEnd, options)
        window.removeEventListener('pointercancel', onEnd, options)
      },
    }
  }, [cancel, stopWatch])

  useEffect(() => {
    return () => {
      cancel()
      clearSwallowTimer()
    }
  }, [cancel, clearSwallowTimer])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // 只认主键：右键/中键不参与（桌面上右键本来就该弹自己的菜单）
      if (disabled || event.button !== 0) return
      fired.current = false
      origin.current = { x: event.clientX, y: event.clientY }
      // 手指动到哪儿都算（不能只等"还在卡片上"的那些移动，见文件头）
      startWatch()
      timer.current = window.setTimeout(() => {
        timer.current = null
        origin.current = null
        stopWatch()
        fired.current = true
        // 兜底：万一那次 click 没来，标记也要自己过期（见 LONG_PRESS_SWALLOW_MS）
        clearSwallowTimer()
        swallowTimer.current = window.setTimeout(() => {
          swallowTimer.current = null
          fired.current = false
        }, LONG_PRESS_SWALLOW_MS)
        callback.current()
      }, LONG_PRESS_MS)
    },
    [disabled, clearSwallowTimer, startWatch, stopWatch],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = origin.current
      if (!start) return
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
      if (moved > LONG_PRESS_SLOP) cancel()
    },
    [cancel],
  )

  const consumeClick = useCallback(() => {
    if (!fired.current) return false
    fired.current = false
    clearSwallowTimer()
    return true
  }, [clearSwallowTimer])

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu: (event) => event.preventDefault(),
    },
    consumeClick,
  }
}
