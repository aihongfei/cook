// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import FilterTabs from './FilterTabs'

/**
 * 页内 tab 条（用户 2026-10-15：「类似这种 tab 页（全部、已安排、已做好）包括我的菜谱中收藏、
 * 我的菜谱这种 tab 页需要能左右滑动切换」，随后又要求「要跟随手指拖动，滑到中间时，
 * 两个页是都能看见的」）。
 *
 * 判定与动画本身在 `lib/tab-swipe.rules.test.ts` / `SwipePager.test.tsx` 里钉住了，
 * 这一层只验**接线**：给了 `renderPanel` 才带走滑、滑动真的换了 key、tab 条上划动不换、
 * 点到头不越界、纵向不换。
 */

/** jsdom 没有布局：`clientWidth` 恒为 0，而翻页阈值是按页宽算的 → 给个真宽度 */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 400,
  })
})

afterEach(cleanup)

const ITEMS = [
  { key: 'all', title: '全部' },
  { key: 'planned', title: '已安排' },
  { key: 'done', title: '已做好' },
]

function Harness() {
  const [tab, setTab] = useState('all')
  return (
    <FilterTabs
      items={ITEMS}
      activeKey={tab}
      onChange={setTab}
      renderPanel={(key) => <div data-testid="content">{`当前：${key}`}</div>}
    />
  )
}

const pager = () => document.querySelector('.swipe-pager') as HTMLElement

/** 跟手划一下：按下 → 中间几个点 → 抬手 */
function swipe(fromX: number, toX: number, { dy = 0, target }: { dy?: number; target?: Element } = {}) {
  fireEvent.touchStart(target ?? pager(), { touches: [{ clientX: fromX, clientY: 400 }] })
  for (let step = 1; step <= 4; step += 1) {
    const x = fromX + ((toX - fromX) * step) / 4
    fireEvent.touchMove(pager(), { touches: [{ clientX: x, clientY: 400 + (dy * step) / 4 }] })
  }
  fireEvent.touchEnd(pager(), { changedTouches: [{ clientX: toX, clientY: 400 + dy }] })
}

it('给了 renderPanel 才有翻页这一层（老调用方只想要 tab 条）', () => {
  const { container } = render(
    <FilterTabs items={ITEMS} activeKey="all" onChange={() => {}} renderPanel={(key) => <div>{key}</div>} />,
  )
  const layer = container.querySelector('.swipe-pager') as HTMLElement
  expect(layer).toBeTruthy()
  expect(layer.querySelector('.swipe-pager__panel')).toBeTruthy()

  // 不给就什么都不加（向后兼容）
  const alone = render(<FilterTabs items={ITEMS} activeKey="all" onChange={() => {}} />)
  expect(alone.container.querySelector('.swipe-pager')).toBeNull()
})

it('往左划 → 下一个 tab；往右划 → 上一个', async () => {
  render(<Harness />)

  swipe(320, 140) // 往左（400px 宽的 22% 是 88px，这里走了 180px）
  // 落位期间两页都在，所以等收尾之后再看（收尾走定时器，不依赖动画）
  await waitFor(() => expect(screen.getByTestId('content').textContent).toBe('当前：planned'))

  swipe(140, 320) // 往右
  await waitFor(() => expect(screen.getByTestId('content').textContent).toBe('当前：all'))
})

it('拖动中间两页都在 DOM 里（这就是"滑到中间两页都能看见"）', () => {
  render(<Harness />)

  fireEvent.touchStart(pager(), { touches: [{ clientX: 320, clientY: 400 }] })
  fireEvent.touchMove(pager(), { touches: [{ clientX: 260, clientY: 400 }] })

  const keys = [...document.querySelectorAll('.swipe-pager__panel')].map(
    (panel) => (panel as HTMLElement).dataset.panelKey,
  )
  expect(keys).toEqual(['all', 'planned'])
})

it('在 tab 条上划动**不换页**（那一截自己会横滚，划动是"看后面的选项"）', () => {
  const onChange = vi.fn()
  const { container } = render(
    <FilterTabs items={ITEMS} activeKey="all" onChange={onChange} renderPanel={(key) => <div>{key}</div>} />,
  )
  const bar = container.querySelector('[data-no-swipe]') as HTMLElement
  expect(bar).toBeTruthy()

  swipe(320, 140, { target: bar })
  expect(onChange).not.toHaveBeenCalled()
})

it('到头了不循环：第一个往右划、最后一个往左划都不动', () => {
  const onChange = vi.fn()
  const { rerender } = render(
    <FilterTabs items={ITEMS} activeKey="all" onChange={onChange} renderPanel={(key) => <div>{key}</div>} />,
  )

  swipe(140, 320) // 已经在第一个，往右划
  expect(onChange).not.toHaveBeenCalled()

  rerender(<FilterTabs items={ITEMS} activeKey="done" onChange={onChange} renderPanel={(key) => <div>{key}</div>} />)
  swipe(320, 140) // 已经在最后一个，往左划
  expect(onChange).not.toHaveBeenCalled()
})

it('纵向划动（在滚列表）不换页', () => {
  const onChange = vi.fn()
  render(<FilterTabs items={ITEMS} activeKey="all" onChange={onChange} renderPanel={(key) => <div>{key}</div>} />)

  swipe(300, 280, { dy: 220 })
  expect(onChange).not.toHaveBeenCalled()
})
