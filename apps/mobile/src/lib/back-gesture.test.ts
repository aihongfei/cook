// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerBackCloser } from './android-back'
import { clearBackTargets, registerBackTarget } from './back-target'
import {
  handleBackGestureEvent,
  resetBackGestureListeners,
  shouldHandleBackGesture,
  syncBackGesture,
} from './back-gesture'
import {
  isBackTransitionActive,
  resetBackTransition,
  setPreviewKeys,
  useBackTransition,
} from './back-transition'

/**
 * 返回手势的跟手（D-109）。
 *
 * 真实的进度事件只有 Android 14+ 真机上才有，所以判定与状态全在这里测：
 * **"哪一次归我们、哪一次让给系统"**（这条错了的表现是"边缘一划就把 App 退掉"
 * 或"划了没反应"）、四个事件各自做什么、以及"弹层开着时不许摆两页"。
 */

// 原生桥在 jsdom 里不存在（`Capacitor.getPlatform()` 不是 android），所以这个 mock
// 把"我们打算告诉原生什么"记下来——判定本身才是被测对象。
// `failNext` 用来模拟"插件还没挂上"（启动早期真的会这样）
const setEnabledCalls: boolean[] = []
let failNext = false
vi.mock('@/api/back-gesture-native', () => ({
  backGestureSupported: () => true,
  setBackGestureEnabled: (enabled: boolean) => {
    setEnabledCalls.push(enabled)
    if (failNext) {
      failNext = false
      return Promise.resolve(false)
    }
    return Promise.resolve(true)
  },
  backGestureEnabled: () => Promise.resolve(true),
  onBackGesture: () => Promise.resolve(() => {}),
}))

/*
 * 退出这一步最终会调 `@capacitor/app` 的 `exitApp`，而它在 jsdom 里未实现
 * （真调会抛一条未处理的拒绝，可能掩盖真失败）。打桩并记下调用——
 * "厨房根页按返回＝退出"因此也能被断言。
 */
const exitCalls: number[] = []
vi.mock('@capacitor/app', () => ({
  App: {
    exitApp: () => {
      exitCalls.push(1)
      return Promise.resolve()
    },
    addListener: () => Promise.resolve({ remove: () => {} }),
  },
}))

function at(pathname: string, target?: string) {
  window.history.replaceState(null, '', pathname)
  clearBackTargets()
  if (target) registerBackTarget(pathname, target)
}

/** 让"目标页在缓存里"这个前提成立（生产里由 `KeepAlivePages` 每次渲染同步） */
function cache(...keys: string[]) {
  setPreviewKeys(keys)
}

afterEach(() => {
  resetBackTransition()
  resetBackGestureListeners()
  clearBackTargets()
  setEnabledCalls.length = 0
  failNext = false
  vi.restoreAllMocks()
})

describe('接不接管（shouldHandleBackGesture）', () => {
  it('子页（有登记的上一层）归我们', () => {
    at('/recipes/r1', '/recipes')
    expect(shouldHandleBackGesture()).toBe(true)
  })

  it('Tab 根页里"不是厨房"的那些也归我们（那一下是"回厨房"，要跟手）', () => {
    at('/fridge')
    expect(shouldHandleBackGesture()).toBe(true)
  })

  it('**厨房根页不归我们**：让系统自己播"窗口缩回桌面"的退出预览', () => {
    at('/kitchen')
    expect(shouldHandleBackGesture()).toBe(false)
  })

  it('弹层开着时归我们（返回键要用来关抽屉，手势同理）', () => {
    at('/kitchen')
    expect(shouldHandleBackGesture()).toBe(false)

    const unregister = registerBackCloser(() => {})
    expect(shouldHandleBackGesture()).toBe(true)

    unregister()
    expect(shouldHandleBackGesture()).toBe(false)
  })

  it('syncBackGesture 对同值去重（每次渲染都喊一声也不会反复跨桥）', () => {
    at('/kitchen')
    syncBackGesture()
    syncBackGesture()
    syncBackGesture()
    expect(setEnabledCalls).toEqual([false])

    at('/fridge')
    syncBackGesture()
    expect(setEnabledCalls).toEqual([false, true])
  })

  it('**调用落空要重试**（插件在启动早期还没挂上时，那个值不能就此永远不再发）', async () => {
    at('/fridge')
    // 第一次调用失败（原生插件还没就绪）
    failNext = true
    syncBackGesture()
    await Promise.resolve()
    await Promise.resolve()
    expect(setEnabledCalls).toEqual([true])

    // 下一次喊（同值）应当**再发一次**——记号被抹掉了
    syncBackGesture()
    expect(setEnabledCalls).toEqual([true, true])
  })
})

describe('四个事件的各自处理', () => {
  it('start：摆好两层（能预览时），进度从 0 起', () => {
    at('/recipes/r1', '/recipes')
    cache('/recipes/r1', '/recipes')

    handleBackGestureEvent({ kind: 'start' })

    expect(useBackTransition.getState().phase).toBe('dragging')
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0')
  })

  it('start：**弹层开着**时不摆两页（这一趟是关抽屉，摆了反而把背后的页面拽出来）', () => {
    at('/recipes/r1', '/recipes')
    cache('/recipes/r1', '/recipes')
    const unregister = registerBackCloser(() => {})

    handleBackGestureEvent({ kind: 'start' })

    expect(isBackTransitionActive()).toBe(false)
    unregister()
  })

  it('start：判据是"退出"时什么都不做（厨房根页，那一下归系统）', () => {
    at('/kitchen')
    handleBackGestureEvent({ kind: 'start' })
    expect(isBackTransitionActive()).toBe(false)
  })

  it('start：目标不在缓存里（冷启动深链直达详情）时不预览', () => {
    at('/recipes/r1', '/recipes')
    cache('/recipes/r1')

    handleBackGestureEvent({ kind: 'start' })

    expect(isBackTransitionActive()).toBe(false)
  })

  it('progress：把进度写进 CSS 变量（不进 React）', () => {
    at('/recipes/r1', '/recipes')
    cache('/recipes/r1', '/recipes')
    handleBackGestureEvent({ kind: 'start' })

    handleBackGestureEvent({ kind: 'progress', progress: 0.35 })
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0.35')
  })

  it('progress：没在拖动时忽略（实体键那一路没有 start，不该被它带偏）', () => {
    at('/recipes/r1', '/recipes')
    handleBackGestureEvent({ kind: 'progress', progress: 0.9 })
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('')
  })

  it('cancel：缩回去（拖到一半又松开手指、没退成）', () => {
    at('/recipes/r1', '/recipes')
    cache('/recipes/r1', '/recipes')
    handleBackGestureEvent({ kind: 'start' })
    handleBackGestureEvent({ kind: 'progress', progress: 0.7 })

    handleBackGestureEvent({ kind: 'cancel' })

    expect(isBackTransitionActive()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0')
  })

  it('press（拖动到一半松手）：**接着当前进度播完**，不是从头再来', () => {
    at('/recipes/r1', '/recipes')
    cache('/recipes/r1', '/recipes')
    handleBackGestureEvent({ kind: 'start' })
    handleBackGestureEvent({ kind: 'progress', progress: 0.55 })

    handleBackGestureEvent({ kind: 'press' })

    // 进动画档，且进度**没被重置**（CSS 从 0.55 过渡到 1）
    expect(useBackTransition.getState().phase).toBe('animating')
    expect(document.documentElement.style.getPropertyValue('--back-progress')).toBe('0.55')
  })

  it('press（实体返回键，没有 start）：照常整段起跳', () => {
    at('/recipes/r1', '/recipes')
    handleBackGestureEvent({ kind: 'press' })
    expect(useBackTransition.getState().phase).toBe('animating')
  })

  it('press（厨房根页）：不摆两层，而是走"退出"那一条', () => {
    at('/kitchen')

    handleBackGestureEvent({ kind: 'press' })

    expect(exitCalls).toHaveLength(1)
    expect(isBackTransitionActive()).toBe(false)
  })
})
