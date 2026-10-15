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

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }, [])

  const clearSwallowTimer = useCallback(() => {
    if (swallowTimer.current !== null) {
      window.clearTimeout(swallowTimer.current)
      swallowTimer.current = null
    }
  }, [])

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
      timer.current = window.setTimeout(() => {
        timer.current = null
        origin.current = null
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
    [disabled, clearSwallowTimer],
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
