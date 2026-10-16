// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginBackDrag,
  beginBackTransition,
  cancelBackDrag,
  enterKeyOf,
  finishBackTransitionNow,
  isBackTransitionActive,
  resetBackTransition,
  setBackDragProgress,
  setPreviewKeys,
  setScrollReader,
  startBackNavigation,
  useBackTransition,
} from './back-transition'

/**
 * 返回动画的状态机（D-106）。
 *
 * 它盯的是**用户报的那件事的可判定部分**：返回要有"两页都在动"的那一趟，
 * 而且这一趟**不许卡住**（R-61 的规矩：动画跑不动时页面也必须看得见）。
 * 真正"看起来对不对"在浏览器/模拟器里验收，这里钉的是三件事：
 *
 * ① 什么时候进"两层"这一档（按钮返回、手势可预览的拖动、手势松手）；
 * ② 什么时候**不**进（没得预览、目标就是当前页）；
 * ③ 无论怎么折腾，最后一定收得回来（连按、看门狗、换页）。
 */

afterEach(() => {
  resetBackTransition()
  vi.useRealTimers()
  window.history.replaceState(null, '', '/kitchen')
})

describe('返回动画档', () => {
  it('按钮返回（无拖动）：直接进动画档，离开/目标两层都记下来', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    beginBackTransition('/recipes/mine')

    const state = useBackTransition.getState()
    expect(state.phase).toBe('animating')
    expect(state.leaveKey).toBe('/recipes/r1')
    expect(state.enterKey).toBe('/recipes/mine')
    expect(isBackTransitionActive()).toBe(true)
  })

  it('目标就是当前页时不开这一趟（点自己的返回箭头不该动）', () => {
    window.history.replaceState(null, '', '/kitchen')
    setPreviewKeys(['/kitchen'])
    expect(beginBackDrag('/kitchen')).toBe(false)
    expect(isBackTransitionActive()).toBe(false)
  })

  it('拖动预览：目标在缓存里才接管进度', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    setPreviewKeys(['/recipes/r1', '/recipes/mine'])

    expect(beginBackDrag('/recipes/mine')).toBe(true)
    expect(useBackTransition.getState().phase).toBe('dragging')

    setBackDragProgress(0.42)
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0.42')
    // 越界值会被夹住（进度是比例，永远只有 0~1）
    setBackDragProgress(3)
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('1')
  })

  it('目标不在缓存里（冷启动深链直达详情）：不预览，改由松手后整段播', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    setPreviewKeys(['/recipes/r1'])

    expect(beginBackDrag('/recipes/mine')).toBe(false)
    expect(isBackTransitionActive()).toBe(false)
  })

  it('拖到一半缩回去：这一趟作废、进度归零', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    setPreviewKeys(['/recipes/r1', '/recipes/mine'])
    beginBackDrag('/recipes/mine')
    setBackDragProgress(0.6)

    cancelBackDrag()

    expect(isBackTransitionActive()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0')
  })

  it('手势松手：接着当前进度播完（不是从头再来）', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    setPreviewKeys(['/recipes/r1', '/recipes/mine'])
    beginBackDrag('/recipes/mine')
    setBackDragProgress(0.6)

    startBackNavigation('/recipes/mine')

    expect(useBackTransition.getState().phase).toBe('animating')
    // 进度**没被重置**：CSS 从"当前算出来的 0.6"过渡到 1（接着走）
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0.6')
  })

  it('连按返回：已经开播的这一趟不被打断（不被重置回起点）', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    startBackNavigation('/recipes/mine')
    useBackTransition.setState({ leaveKey: '哨兵' })

    startBackNavigation('/favorites')

    expect(useBackTransition.getState().leaveKey).toBe('哨兵')
  })

  it('看门狗：CSS 过渡不跑也会到点收尾（R-61：不许卡住屏幕）', () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/recipes/r1')
    beginBackTransition('/recipes/mine')
    expect(isBackTransitionActive()).toBe(true)

    vi.advanceTimersByTime(240 + 120 + 1)

    expect(isBackTransitionActive()).toBe(false)
  })

  it('收尾后进度归零、两层清空（下次返回从头算）', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    beginBackTransition('/recipes/mine')
    setBackDragProgress(0) // 不在拖动档，应当被忽略
    finishBackTransitionNow()

    expect(useBackTransition.getState()).toMatchObject({ phase: 'idle', leaveKey: '', enterKey: '' })
  })

  it('下层那次要摆到目标页自己记的位置（enterScroll），不是 0', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    setPreviewKeys(['/recipes/r1', '/recipes/mine'])
    setScrollReader((key) => (key === '/recipes/mine' ? 420 : 0))

    beginBackDrag('/recipes/mine')

    expect(useBackTransition.getState().enterScroll).toBe(420)
  })
})

describe('enterKeyOf', () => {
  it('查询串不算另一页（页内 tab 是同一页，D-091）', () => {
    expect(enterKeyOf('/recipes?category=汤')).toBe('/recipes')
    expect(enterKeyOf('/order/2026-10-15-DINNER')).toBe('/order/2026-10-15-DINNER')
  })
})
