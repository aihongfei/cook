// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FilterTabs from './FilterTabs'

/**
 * 页内 tab 条（用户 2026-10-15：「类似这种 tab 页（全部、已安排、已做好）包括我的菜谱中收藏、
 * 我的菜谱这种 tab 页需要能左右滑动切换」）。
 *
 * 判定本身在 `lib/tab-swipe.rules.test.ts` 里钉住了，这一层只验**接线**：
 * 滑动真的换了 key、tab 条上划动不换（那一截自己会横滚）、点到头不越界。
 */

afterEach(cleanup)

const ITEMS = [
  { key: 'all', title: '全部' },
  { key: 'planned', title: '已安排' },
  { key: 'done', title: '已做好' },
]

function Harness() {
  const [tab, setTab] = useState('all')
  return (
    <FilterTabs items={ITEMS} activeKey={tab} onChange={setTab}>
      <div data-testid="content">{`当前：${tab}`}</div>
    </FilterTabs>
  )
}

/** 在某个元素上划一下（按下 → 抬手，中间带位移；判定就是按下到抬手这一整段） */
function swipe(el: Element, fromX: number, toX: number, dy = 6) {
  fireEvent.pointerDown(el, { button: 0, clientX: fromX, clientY: 300 })
  fireEvent.pointerUp(el, { button: 0, clientX: toX, clientY: 300 + dy })
}

it('内容包在手势面里（传了 children 才有滑动这一层）', () => {
  render(<Harness />)
  const area = document.querySelector('.swipe-area') as HTMLElement
  expect(area).toBeTruthy()
  expect(area.contains(screen.getByTestId('content'))).toBe(true)
})

it('往左划 → 下一个 tab；往右划 → 上一个', () => {
  render(<Harness />)
  const area = screen.getByTestId('content').parentElement as HTMLElement

  swipe(area, 320, 140) // 往左
  expect(screen.getByTestId('content').textContent).toBe('当前：planned')

  swipe(area, 140, 320) // 往右
  expect(screen.getByTestId('content').textContent).toBe('当前：all')
})

it('在 tab 条上划动**不换页**（那一截自己会横滚，划动是"看后面的选项"）', () => {
  const onChange = vi.fn()
  const { container } = render(<FilterTabs items={ITEMS} activeKey="all" onChange={onChange}><div /></FilterTabs>)
  const bar = container.querySelector('[data-no-swipe]') as HTMLElement
  expect(bar).toBeTruthy()

  swipe(bar, 320, 140)
  expect(onChange).not.toHaveBeenCalled()
})

it('到头了不循环：第一个往右划、最后一个往左划都不动', () => {
  const onChange = vi.fn()
  const { container, rerender } = render(<FilterTabs items={ITEMS} activeKey="all" onChange={onChange}><div /></FilterTabs>)
  const areaOf = () => container.querySelector('.swipe-area') as HTMLElement

  swipe(areaOf(), 140, 320) // 已经在第一个，往右划
  expect(onChange).not.toHaveBeenCalled()

  rerender(<FilterTabs items={ITEMS} activeKey="done" onChange={onChange}><div /></FilterTabs>)
  swipe(areaOf(), 320, 140) // 已经在最后一个，往左划
  expect(onChange).not.toHaveBeenCalled()
})

it('纵向划动（在滚列表）不换页', () => {
  const onChange = vi.fn()
  const { container } = render(<FilterTabs items={ITEMS} activeKey="all" onChange={onChange}><div /></FilterTabs>)
  const area = container.querySelector('.swipe-area') as HTMLElement
  fireEvent.pointerDown(area, { button: 0, clientX: 300, clientY: 200 })
  fireEvent.pointerUp(area, { button: 0, clientX: 280, clientY: 420 })
  expect(onChange).not.toHaveBeenCalled()
})
