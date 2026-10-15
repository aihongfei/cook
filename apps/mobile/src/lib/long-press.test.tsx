// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP, LONG_PRESS_SWALLOW_MS, useLongPress } from './long-press'

/**
 * 长按的判定（用户 2026-10-15：「可以用那个按住显示单选框」）。
 *
 * 这一组盯的全是"**什么时候不算长按**"——触发那一条反而是最简单的。
 * 每一条都对应一个真实后果：
 * - 时间没到就抬手 → 用户只是想点开这一页（不该进选择模式）；
 * - 手指动了 → 他在滚列表（一滚就进选择模式，比没有这个功能还糟）；
 * - 长按之后那次 click → 浏览器补发的，不吐掉的话"按半天选不上"。
 */

function Probe({ onLongPress, disabled = false }: { onLongPress: () => void; disabled?: boolean }) {
  const { handlers, consumeClick } = useLongPress(onLongPress, { disabled })
  return (
    <div
      data-testid="target"
      {...handlers}
      onClick={() => {
        if (consumeClick()) return
        // 正常的点击行为：测试里把它记在 dataset 上，方便断言"点还在"
        const node = document.querySelector('[data-testid="target"]') as HTMLElement
        node.dataset.clicked = String(Number(node.dataset.clicked ?? 0) + 1)
      }}
    />
  )
}

const target = () => screen.getByTestId('target')

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

it('按住到点才算：时间没到就抬手，什么都不发生', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} />)

  fireEvent.pointerDown(target(), { button: 0, clientX: 10, clientY: 10 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS - 50)
  })
  fireEvent.pointerUp(target())

  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(fired).not.toHaveBeenCalled()
})

it('按住满 500ms 就触发', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} />)

  fireEvent.pointerDown(target(), { button: 0, clientX: 10, clientY: 10 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS)
  })
  expect(fired).toHaveBeenCalledTimes(1)
})

it('手指动了就取消（那是滚动列表，不是长按）', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} />)

  fireEvent.pointerDown(target(), { button: 0, clientX: 10, clientY: 10 })
  // 往下滑一段（滚列表）
  fireEvent.pointerMove(target(), { clientX: 10, clientY: 10 + LONG_PRESS_SLOP + 20 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS + 100)
  })
  expect(fired).not.toHaveBeenCalled()
})

it('长按之后浏览器补的那一次 click 被吐掉（否则刚选上又被取消）', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} />)

  fireEvent.pointerDown(target(), { button: 0, clientX: 10, clientY: 10 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS)
  })
  expect(fired).toHaveBeenCalledTimes(1)

  // 手指抬起 → 浏览器补一个 click：这一次要吞掉，不动 dataset
  fireEvent.pointerUp(target())
  fireEvent.click(target())
  expect(target().dataset.clicked).toBeUndefined()

  // 之后正常的点击照常生效（吐掉的只有紧随其后的那一次）
  fireEvent.click(target())
  expect(target().dataset.clicked).toBe('1')
})

it('长按那次 click 一直没来（按住后拖出卡片再松手）：标记要自己过期，别把下一次点击也吞了', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} />)

  fireEvent.pointerDown(target(), { button: 0, clientX: 10, clientY: 10 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS)
  })
  fireEvent.pointerUp(target())
  // 这里**故意不补 click**（模拟手势最终没落在卡片上）
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_SWALLOW_MS + 100)
  })

  fireEvent.click(target())
  expect(target().dataset.clicked).toBe('1')
})

it('禁用了就不参与（比如「做好了」的卡不该被长按选中）', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} disabled />)

  fireEvent.pointerDown(target(), { button: 0, clientX: 10, clientY: 10 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS + 100)
  })
  expect(fired).not.toHaveBeenCalled()
})

it('右键/中键不算（桌面上右键该弹自己的菜单）', () => {
  const fired = vi.fn()
  render(<Probe onLongPress={fired} />)

  fireEvent.pointerDown(target(), { button: 2, clientX: 10, clientY: 10 })
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS + 100)
  })
  expect(fired).not.toHaveBeenCalled()
})
