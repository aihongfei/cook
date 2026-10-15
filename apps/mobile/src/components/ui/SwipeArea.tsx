import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { swipeTargetIndex } from '@/lib/tab-swipe.rules'

/**
 * 「左右滑动切换」的**手势面**（用户 2026-10-15：「类似这种 tab 页……需要能左右滑动切换」）。
 *
 * 用法：把要能滑的那一块内容包起来，告诉它这一组 tab 的 key 与当前 key：
 * ```tsx
 * <SwipeArea keys={items.map(i => i.key)} activeKey={tab} onChange={setTab}>{内容}</SwipeArea>
 * ```
 * 判定的规则全在 `@/lib/tab-swipe.rules`（纯函数、有单测）；这里只负责"把 pointer 事件
 * 翻译成那份事实 + 调一次 `onChange`"。
 *
 * ## 三个刻意的做法
 *
 * - **只在抬手时决定**（`onPointerUp`）：中途不断改 tab 会在指头还没松开时就换页，
 *   用户想反悔都来不及；判定的位移也是"按下 → 抬手"这一整段。
 * - **不 `preventDefault`**：纵向滚动、按钮的点击都要照常工作。横向那点事由 CSS 的
 *   `touch-action: pan-y` 与 `.tab-layout__body` 的 `overscroll-behavior-x: none` 兜住
 *   （见 `styles/layouts` 里那两处注释），不靠 JS 抢事件。
 * - **`data-no-swipe` 一律放行**：`Chips` 与 `FilterTabs` 的 tab 条自己会横着滚，
 *   在它们上面划动的意思是"看后面的选项"。标记打在**共享组件里**，页面不用记着加。
 */
export default function SwipeArea({
  keys,
  activeKey,
  onChange,
  className,
  children,
}: {
  keys: readonly string[]
  activeKey: string
  onChange: (key: string) => void
  className?: string
  children: ReactNode
}) {
  const start = useRef<{ x: number; y: number; blocked: boolean } | null>(null)

  const onPointerDown = (event: ReactPointerEvent) => {
    // 只认主键（右键/中键不参与，与长按那条同一条规矩）
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    start.current = {
      x: event.clientX,
      y: event.clientY,
      blocked: Boolean(target.closest('[data-no-swipe]')),
    }
  }

  const onPointerUp = (event: ReactPointerEvent) => {
    const from = start.current
    start.current = null
    if (!from) return

    const index = keys.indexOf(activeKey)
    const next = swipeTargetIndex({
      dx: event.clientX - from.x,
      dy: event.clientY - from.y,
      startX: from.x,
      viewportWidth: window.innerWidth,
      index,
      total: keys.length,
      blocked: from.blocked,
    })
    if (next !== null) onChange(keys[next])
  }

  return (
    <div
      className={['swipe-area', className].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null }}
    >
      {children}
    </div>
  )
}
