// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backCloserCount, handleBackPress, registerBackCloser } from './android-back'

/**
 * 安卓系统返回键的三档优先级（F14-01 / R-13 ①）。
 *
 * 为什么值得单独测：这段逻辑在浏览器里**跑不起来**（没有 backButton 事件），
 * 而它恰恰是"APK 里返回键像不像原生 App"的全部依据——只能靠单测盯住顺序，
 * 真机验证放在 RUNBOOK 的验收步骤里。
 *
 * 每一条都对应一个实测过的错误行为：
 * ① 弹层开着却退了页面 → 用户想关抽屉，结果连页面一起没了；
 * ② 用 `history.length` 判断能否回退 → 退回去之后它不减，返回键会变成"永远不退 App"；
 * ③ 到根了还不退出 → 用户只能从多任务里划掉。
 */

/**
 * 每条用例注册的弹层都要在这里注销掉。
 * ⚠️ **别写成 `while (backCloserCount() > 0) handleBackPress(...)`**：`handleBackPress`
 * 只负责"调用最上面那层的 close"，**不负责出栈**（出栈是组件卸载时调注销函数的事，
 * 见模块里那段说明）。拿它当清栈用会死循环——本地真跑出过一次 heap OOM。
 */
const unregisters: Array<() => void> = []

function register(close: () => void) {
  const unregister = registerBackCloser(close)
  unregisters.push(unregister)
  return unregister
}

afterEach(() => {
  unregisters.splice(0).forEach((unregister) => unregister())
  vi.restoreAllMocks()
})

describe('handleBackPress', () => {
  it('有弹层时先关弹层，不回退页面（①）', () => {
    const close = vi.fn()
    register(close)
    const exit = vi.fn()

    const action = handleBackPress({ canGoBack: () => true, exit })

    expect(action).toBe('closed')
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('多层弹层按**后进先出**关：最后打开的那层先关', () => {
    const first = vi.fn()
    const second = vi.fn()
    register(first)
    register(second)

    handleBackPress({ canGoBack: () => true, exit: () => {} })

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('没有弹层且还能回退时，回退历史（②）', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    const action = handleBackPress({ canGoBack: () => true, exit: () => {} })

    expect(action).toBe('back')
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('到根页面（回不去了）才退出 App（③）', () => {
    const exit = vi.fn()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    const action = handleBackPress({ canGoBack: () => false, exit })

    expect(action).toBe('exit')
    expect(exit).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
  })

  it('默认判据读 history.state.idx：首条（0）当根、第二条（1）能退', () => {
    const exit = vi.fn()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    // 首条历史（idx=0）：这是整页加载那条，退回去等于离开应用
    window.history.replaceState({ idx: 0 }, '')
    expect(handleBackPress({ exit })).toBe('exit')

    // 走了一步（idx=1）：能退
    window.history.replaceState({ idx: 1 }, '')
    expect(handleBackPress({ exit })).toBe('back')

    // 读不到 state（非 router 环境）时保守当首条，别把用户卡在"返回没反应"上
    window.history.replaceState(null, '')
    expect(handleBackPress({ exit })).toBe('exit')

    expect(back).toHaveBeenCalledTimes(1)
  })

  it('注销后不再吃掉返回键（抽屉关掉/组件卸载的那条路）', () => {
    const close = vi.fn()
    const unregister = register(close)
    unregister()

    expect(backCloserCount()).toBe(0)
    expect(handleBackPress({ canGoBack: () => true, exit: () => {} })).toBe('back')
    expect(close).not.toHaveBeenCalled()
  })

  it('注销的是自己那一层，不误伤别人（同一函数注册两次也对）', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unregisterA = register(a)
    register(b)

    unregisterA()

    handleBackPress({ canGoBack: () => true, exit: () => {} })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })
})
