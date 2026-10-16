// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { goBack, resetBackNavigator, setBackNavigator } from './back-go'
import {
  isBackTransitionActive,
  resetBackTransition,
  setCachedStateReader,
} from './back-transition'

/**
 * 「退回去」这一个动作（D-105 / D-106）。
 *
 * 三件事必须在同一次点击里一起发生，这里逐条钉住——它们各自都能单独坏掉，
 * 而坏掉的表现都是"用户看得出不对"：
 * ① 起跳两层动画（否则返回是硬切）；
 * ② 用 `replace` 导航（否则历史里又堆一条，用户报的"能一直退"复发）；
 * ③ 把目标那一页自己的 state 交还给它（否则那条返回链断在中间一站）。
 */

afterEach(() => {
  resetBackNavigator()
  resetBackTransition()
})

describe('goBack', () => {
  it('起跳两层动画 + replace 导航', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    const navigate = vi.fn()
    setBackNavigator(navigate)

    goBack('/recipes/mine')

    expect(navigate).toHaveBeenCalledWith('/recipes/mine', { replace: true, state: undefined })
    expect(isBackTransitionActive()).toBe(true)
  })

  it('目标页在缓存里时，它自己的 state 原样交还（返回链不断）', () => {
    window.history.replaceState(null, '', '/recipes/r1')
    const navigate = vi.fn()
    setBackNavigator(navigate)
    // 「这一餐」当初就是从通知中心进来的：这份 state 必须跟着回去，
    // 不然它的返回箭头会退回点菜单（D-079/D-082 接上的那一段就断了）
    const state = { from: '/notifications' }
    setCachedStateReader(() => state)

    goBack('/order/2026-10-15-DINNER')

    expect(navigate).toHaveBeenCalledWith('/order/2026-10-15-DINNER', { replace: true, state })
  })

  it('路由还没接上时退回浏览器历史（降级，不该什么都没发生）', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    goBack('/kitchen')
    expect(back).toHaveBeenCalledTimes(1)
  })
})
