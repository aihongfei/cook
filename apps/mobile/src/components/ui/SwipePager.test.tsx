// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SwipePager from './SwipePager'

/**
 * 跟手翻页（用户 2026-10-15：「左右滚动要有切页动画啊，好像 el-tab 和原生那样的，
 * 要跟随手指拖动，滑到中间时，两个页是都能看见的」）。
 *
 * 判定本身在 `lib/tab-swipe.rules.test.ts` 里钉住了，这一层只验**接线与动画**：
 * 跟手时轨道真的跟着手指走、**拖动中两页同时在 DOM 里**（这就是"滑到中间两页都能看见"）、
 * 抬手够远就翻/不够就弹回、点 tab 也有横移动画、到头不循环、`data-no-swipe` 与纵向不接、
 * 拖动之后那一次 click 被吞掉。
 */

/** jsdom 没有布局引擎：`clientWidth` 恒为 0，而翻页阈值是按页宽算的 → 给个真宽度 */
const WIDTH = 400

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => WIDTH,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const KEYS = ['a', 'b', 'c']

function Harness({
  initial = 'a',
  onSwitched,
  panelExtra,
  fill,
}: {
  initial?: string
  onSwitched?: (key: string) => void
  panelExtra?: (key: string) => React.ReactNode
  fill?: boolean
} = {}) {
  const [active, setActive] = useState(initial)
  return (
    <div>
      {/* 点 tab：父组件自己改 activeKey（与真实页面里 antd-mobile Tabs 那条路一样） */}
      <button type="button" onClick={() => setActive('b')}>去第二页</button>
      <SwipePager
        keys={KEYS}
        activeKey={active}
        fill={fill}
        onChange={(key) => {
          onSwitched?.(key)
          setActive(key)
        }}
        renderPanel={(key) => (
          <div data-testid={`panel-${key}`}>
            <p>{`这一页是 ${key}`}</p>
            {panelExtra?.(key)}
          </div>
        )}
      />
    </div>
  )
}

const root = () => document.querySelector('.swipe-pager') as HTMLElement
const track = () => document.querySelector('.swipe-pager__track') as HTMLElement
/** 现在 DOM 里挂着哪几页（顺序＝页面顺序） */
const panels = () =>
  [...document.querySelectorAll('.swipe-pager__panel')].map((panel) => (panel as HTMLElement).dataset.panelKey)
const transform = () => track().style.transform
const transition = () => track().style.transition

function touchStart(x: number, y = 400, target?: Element) {
  fireEvent.touchStart(target ?? root(), { touches: [{ clientX: x, clientY: y }] })
}
function touchMove(x: number, y = 400) {
  fireEvent.touchMove(root(), { touches: [{ clientX: x, clientY: y }] })
}
function touchEnd(x: number, y = 400) {
  fireEvent.touchEnd(root(), { changedTouches: [{ clientX: x, clientY: y }] })
}

/** 跟手划一段：按下 → 中间几个点 → 抬手 */
function drag(fromX: number, toX: number, { steps = 4, y = 400, lift = true } = {}) {
  touchStart(fromX, y)
  for (let step = 1; step <= steps; step += 1) {
    touchMove(fromX + ((toX - fromX) * step) / steps, y)
  }
  if (lift) touchEnd(toX, y)
}

it('静止时只有当前这一页在 DOM 里（邻居不预渲染——它可能要现取数据）', () => {
  render(<Harness />)

  expect(panels()).toEqual(['a'])
  expect(screen.getByTestId('panel-a')).toBeTruthy()
})

it('跟手拖动：轨道跟着手指走，而且**两页同时在 DOM 里**', () => {
  render(<Harness />)

  touchStart(300)
  touchMove(280) // 走够 8px → 接过来
  expect(panels()).toEqual(['a', 'b']) // 要翻的那一页先进来
  expect(transform()).toMatch(/calc\(0% \+ -20px\)/)

  touchMove(240)
  expect(transform()).toMatch(/calc\(0% \+ -60px\)/)

  // 抬回来一点（还没到阈值）→ 弹回原位，页不变
  touchEnd(250)
  expect(screen.getByTestId('panel-a')).toBeTruthy()
  expect(transition()).toContain('transform')
})

it('抬手走够这一页的 22% 就翻过去；落位之后邻居退场，只剩新那一页', async () => {
  const onSwitched = vi.fn()
  render(<Harness onSwitched={onSwitched} />)

  drag(300, 100) // 往左 200px，超过 400*0.22
  await waitFor(() => expect(onSwitched).toHaveBeenCalledWith('b'))
  // 落位期间两页都还在（这正是"滑到中间两页都能看见"的收尾那一半）
  expect(panels()).toEqual(['a', 'b'])
  expect(transform()).toMatch(/calc\(-100% \+ 0px\)/)

  // 收尾之后邻居摘掉
  await waitFor(() => expect(panels()).toEqual(['b']), { timeout: 2000 })
})

it('没走够就弹回去：不换页，邻居也退场', () => {
  // 时间要自己控：jsdom 里两个合成事件之间可能只差几毫秒，那会被当成"甩"
  //（真手指不可能在几毫秒里走 60px，控制住时间才是这条用例要验的东西）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  try {
    const onSwitched = vi.fn()
    render(<Harness onSwitched={onSwitched} />)

    touchStart(300)
    vi.advanceTimersByTime(150)
    touchMove(280)
    vi.advanceTimersByTime(150)
    touchMove(260)
    vi.advanceTimersByTime(150)
    touchMove(240)
    touchEnd(240)

    expect(onSwitched).not.toHaveBeenCalled()
    expect(panels()).toEqual(['a', 'b'])

    // 收尾（定时器那一路，不依赖 transitionend）之后邻居摘掉
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(panels()).toEqual(['a'])
  } finally {
    vi.useRealTimers()
  }
})

it('到头那一侧不循环：第一页往右划，页不动、也不会有"前一页"进来', () => {
  const onSwitched = vi.fn()
  render(<Harness onSwitched={onSwitched} />)

  touchStart(100)
  touchMove(160)
  touchMove(220)
  // 橡皮筋：走 120px 只画出一小段
  const painted = Number(transform().match(/\+ (-?[\d.]+)px/)?.[1] ?? 0)
  expect(painted).toBeGreaterThan(0)
  expect(painted).toBeLessThan(120)
  expect(panels()).toEqual(['a'])

  touchEnd(220)
  expect(onSwitched).not.toHaveBeenCalled()
})

it('纵向划动只滚页面：不换页，轨道一动不动', () => {
  const onSwitched = vi.fn()
  render(<Harness onSwitched={onSwitched} />)
  const before = transform()

  touchStart(300, 400)
  touchMove(290, 460)
  touchMove(285, 520)
  touchEnd(285, 520)

  expect(onSwitched).not.toHaveBeenCalled()
  expect(transform()).toBe(before)
  expect(panels()).toEqual(['a'])
})

it('起点落在 `data-no-swipe` 的那一行上 → 一律不接（那一行自己会横滚）', () => {
  const onSwitched = vi.fn()
  render(<Harness onSwitched={onSwitched} panelExtra={() => <div data-no-swipe>这一行自己横滚</div>} />)
  const before = transform()

  // 手指落在那一行里起手：整个手势都不接（哪怕后面划得再远）
  fireEvent.touchStart(document.querySelector('[data-no-swipe]')!, { touches: [{ clientX: 300, clientY: 400 }] })
  fireEvent.touchMove(root(), { touches: [{ clientX: 160, clientY: 400 }] })
  fireEvent.touchMove(root(), { touches: [{ clientX: 120, clientY: 400 }] })
  fireEvent.touchEnd(root(), { changedTouches: [{ clientX: 120, clientY: 400 }] })

  expect(onSwitched).not.toHaveBeenCalled()
  expect(transform()).toBe(before)
  expect(panels()).toEqual(['a'])
})

it('点 tab 换页也走同一套：两页同时在 → 横移动画 → 落位只剩那一页', async () => {
  render(<Harness />)

  fireEvent.click(screen.getByRole('button', { name: '去第二页' }))

  expect(screen.getByTestId('panel-b')).toBeTruthy()
  expect(panels()).toEqual(['a', 'b'])
  expect(transition()).toContain('transform')
  expect(transform()).toMatch(/calc\(-100% \+ 0px\)/)

  await waitFor(() => expect(panels()).toEqual(['b']), { timeout: 2000 })
})

it('拖动之后紧跟着的那一次 click 被吞掉（松手不该顺手点进详情）', () => {
  const clicked = vi.fn()
  render(<Harness panelExtra={() => <button type="button" onClick={clicked}>点我</button>} />)

  drag(300, 100)
  fireEvent.click(screen.getAllByRole('button', { name: '点我' })[0])
  expect(clicked).not.toHaveBeenCalled()

  // 那次 click 真的没来也不会一直吞下去（同 long-press 的兜底）
  fireEvent.click(screen.getAllByRole('button', { name: '点我' })[0])
  expect(clicked).toHaveBeenCalledTimes(1)
})

it('鼠标也能拖（开发时在桌面浏览器里试的那条路）', () => {
  const onSwitched = vi.fn()
  render(<Harness onSwitched={onSwitched} />)

  fireEvent.pointerDown(root(), { pointerType: 'mouse', button: 0, clientX: 300, clientY: 400 })
  fireEvent.pointerMove(root(), { pointerType: 'mouse', clientX: 260, clientY: 400 })
  expect(transform()).toMatch(/calc\(0% \+ -40px\)/)
  fireEvent.pointerMove(root(), { pointerType: 'mouse', clientX: 100, clientY: 400 })
  fireEvent.pointerUp(root(), { pointerType: 'mouse', clientX: 100, clientY: 400 })

  expect(onSwitched).toHaveBeenCalledWith('b')
})

/*
 * **整屏**（`fill`，用户 2026-10-16：「改成三个 tab 可以互相滑动的，整屏滑动，并高度要自适应，
 * 菜谱没有超出屏幕时不要空白滑动」）。
 *
 * jsdom 没有布局引擎（量不出"剩下的高度是多少"），所以这里只能钉住**类名与结构**
 * ——真正的几何由浏览器与模拟器实测（见 RUNBOOK）。能钉住的是这三条：
 * ① `fill` 真的挂上去了（那是 CSS 里 `flex: 1` + `min-height: 100%` 唯一的开关）；
 * ② 每一页仍然是同一套结构（没有为整屏另起一套 DOM）；
 * ③ **没传 `fill` 时一个字都不变**（其它页面的滑动仍是"内容多高就多高"）。
 */
it('fill：挂上整屏那一类，每一页的结构不变（不是另起一套 DOM）', () => {
  render(<Harness fill />)

  expect(root().className).toContain('swipe-pager--fill')
  // 每一页还是 `.swipe-pager__panel`，而且静止时仍然只有当前页
  expect(panels()).toEqual(['a'])
})

it('不传 fill 时不挂那个类（其它页面的滑动不受影响）', () => {
  render(<Harness />)

  expect(root().className).not.toContain('swipe-pager--fill')
})

describe('甩（速度那一半）', () => {
  it('够快就翻，不必走够 22%', () => {
    // 抬手的"速度"是最近 40ms 的位移 ÷ 时间，所以要能真的走时间（`performance` 也要假）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      const onSwitched = vi.fn()
      render(<Harness onSwitched={onSwitched} />)

      touchStart(300)
      vi.advanceTimersByTime(20)
      touchMove(280)
      vi.advanceTimersByTime(20)
      touchMove(260)
      touchEnd(260)

      // 只走了 40px（阈值是 400*0.22=88），全靠"甩"这一条翻过去
      expect(onSwitched).toHaveBeenCalledWith('b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('慢慢挪同样的距离就只是弹回去（速度那一半没够）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      const onSwitched = vi.fn()
      render(<Harness onSwitched={onSwitched} />)

      touchStart(300)
      vi.advanceTimersByTime(200)
      touchMove(280)
      vi.advanceTimersByTime(200)
      touchMove(260)
      touchEnd(260)

      expect(onSwitched).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
