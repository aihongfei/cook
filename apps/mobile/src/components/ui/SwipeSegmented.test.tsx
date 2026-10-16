// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SwipeSegmented from './SwipeSegmented'

/**
 * 可滑的段控（用户 2026-10-16「段控也能滑」）。
 *
 * 判定那部分在 `lib/tab-swipe.rules.test.ts` 里钉住了（与 `SwipePager` 共用同一套纯函数），
 * 这里只验这一层自己那点东西：**滑块画在哪儿**（宽度算式与格间隙）、点击照旧能切、
 * 在它上面划动**能被自己接住**（这一点与 tab 条正好相反——tab 条自己横滚，标记 `data-no-swipe` 让开）。
 */

/** jsdom 没有布局引擎：`clientWidth` 恒为 0，而"划得够不够翻页"是按控件宽算的 → 给个真宽度 */
const WIDTH = 400

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ITEMS = [
  { key: 'family', title: '全家点菜单' },
  { key: 'mine', title: '只看我的' },
]

function Harness({ onChange }: { onChange?: (key: string) => void } = {}) {
  const [active, setActive] = useState('family')
  return (
    <SwipeSegmented
      label="看谁的点单"
      items={ITEMS}
      activeKey={active}
      onChange={(key) => {
        onChange?.(key)
        setActive(key)
      }}
    />
  )
}

const root = () => document.querySelector('.segmented') as HTMLElement
const thumb = () => document.querySelector('.segmented__thumb') as HTMLElement
const activeLabel = () => document.querySelector('.segmented__item.is-active')?.textContent?.trim()

function drag(fromX: number, toX: number, { steps = 4, dy = 0, lift = true } = {}) {
  fireEvent.touchStart(root(), { touches: [{ clientX: fromX, clientY: 200 }] })
  for (let step = 1; step <= steps; step += 1) {
    fireEvent.touchMove(root(), {
      touches: [{ clientX: fromX + ((toX - fromX) * step) / steps, clientY: 200 + (dy * step) / steps }],
    })
  }
  if (lift) fireEvent.touchEnd(root(), { changedTouches: [{ clientX: toX, clientY: 200 + dy }] })
}

it('滑块在：位移＝格号 × 100% 再加格间隙（百分比只走"一格宽"，间隙得自己加）', () => {
  render(<Harness />)

  expect(thumb()).toBeTruthy()
  // 第一格：没有位移，但两个变量都得在（宽度算式要用）
  expect(root().style.getPropertyValue('--segments')).toBe('2')
  expect(thumb().style.transform).toContain('translate3d(calc(0% + 0 * var(--segment-gap, 8px)')
})

it('点某一格照旧能切（滑动是加的那一条路，不是唯一的路）', async () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)

  fireEvent.click(screen.getByRole('tab', { name: '只看我的' }))

  await waitFor(() => expect(activeLabel()).toBe('只看我的'))
  expect(onChange).toHaveBeenCalledWith('mine')
})

it('跟手划：滑块跟着手指走，抬手够远就换一格', async () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)

  drag(150, 140, { lift: false })
  // 走够 8px 才接过来，之后就跟着手指：位移里带着这一段的像素
  expect(thumb().style.transform).toContain('-10px')
  expect(thumb().style.transition).toBe('none')

  drag(150, 40) // 走 110px > 400 * 0.22
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('mine'))
  await waitFor(() => expect(activeLabel()).toBe('只看我的'))
})

it('没够就弹回、什么都不换（轻轻带一下不该换格）', async () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)

  drag(150, 120) // 只走 30px

  expect(onChange).not.toHaveBeenCalled()
  expect(activeLabel()).toBe('全家点菜单')
  // 弹回也走一次过渡（不是硬跳）
  expect(thumb().style.transition).toContain('transform')
})

it('纵向划动不接（那是在滚页面，不是换格）', async () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)

  drag(150, 150, { dy: 60 })

  expect(onChange).not.toHaveBeenCalled()
})

it('边缘那条带不接（安卓的边缘手势是"返回上一页"，不跟它抢）', async () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)

  // 视口左边 24px 以内起手
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  drag(10, 300)

  expect(onChange).not.toHaveBeenCalled()
})

it('标了 data-no-swipe（自己不会再横滚，但被放进翻页区时外层要让开），并且自己接得住这一下', () => {
  render(<Harness />)

  // 标记在：万一将来它落在某个 `SwipePager` 里，外层不会跟它抢同一次划动
  expect(root().hasAttribute('data-no-swipe')).toBe(true)
  // 而它自己**不**受这个标记影响（`blocked: false` 是写死的，见组件里那段注释）
  drag(150, 40)
  expect(activeLabel()).toBe('只看我的')
})

it('读屏：是一组 tab（谁在选中有状态，不靠颜色）', () => {
  render(<Harness />)

  expect(screen.getByRole('tablist', { name: '看谁的点单' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: '全家点菜单' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: '只看我的' }).getAttribute('aria-selected')).toBe('false')
  // 滑块纯装饰，别念它
  expect(thumb().getAttribute('aria-hidden')).toBe('true')
})

describe('只有一格时不动手', () => {
  it('一格：划动什么都不发生（没有"下一页"这回事）', () => {
    const onChange = vi.fn()
    const { container } = render(
      <SwipeSegmented
        label="只有一个开关"
        items={[{ key: 'only', title: '就这个' }]}
        activeKey="only"
        onChange={onChange}
      />,
    )

    fireEvent.touchStart(container.querySelector('.segmented') as HTMLElement, {
      touches: [{ clientX: 150, clientY: 200 }],
    })
    fireEvent.touchMove(container.querySelector('.segmented') as HTMLElement, {
      touches: [{ clientX: 40, clientY: 200 }],
    })
    fireEvent.touchEnd(container.querySelector('.segmented') as HTMLElement, {
      changedTouches: [{ clientX: 40, clientY: 200 }],
    })

    expect(onChange).not.toHaveBeenCalled()
  })
})
