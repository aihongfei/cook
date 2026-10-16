// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backCloserCount, backTargetNow, handleBackPress, registerBackCloser } from './android-back'
import { clearBackTargets, registerBackTarget } from './back-target'
import { resolveBack } from './back-policy'

/**
 * 安卓系统返回键的三档优先级（F14-01 / R-13 ①；语义重定于 2026-10-16 / D-105）。
 *
 * 为什么值得单独测：这段逻辑在浏览器里**跑不起来**（没有 backButton 事件），
 * 而它恰恰是"APK 里返回键像不像原生 App"的全部依据——只能靠单测盯住顺序，
 * 真机验证放在 RUNBOOK 的验收步骤里。
 *
 * 每一条都对应一个实测过的错误行为：
 * ① 弹层开着却退了页面 → 用户想关抽屉，结果连页面一起没了；
 * ② **原来拿"浏览器历史里还有没有上一条"当判据** → 底栏点几个 Tab 就能一路退回去，
 *   从详情点去别的 Tab 还能退回详情（用户 2026-10-16 报的两条，见 `back-policy` 文件头）。
 *   现在判据是"这一页登记的上一层"，与页面上那颗箭头同一个值；
 * ③ 到首页了还不退出 → 用户只能从多任务里划掉。
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

/** 把"人在哪一页、这一页登记的返回目标是什么"摆好（默认那条判据读的就是这两个） */
function at(pathname: string, target?: string) {
  window.history.replaceState(null, '', pathname)
  clearBackTargets()
  if (target) registerBackTarget(pathname, target)
}

beforeEach(() => {
  at('/kitchen')
})

afterEach(() => {
  unregisters.splice(0).forEach((unregister) => unregister())
  clearBackTargets()
  vi.restoreAllMocks()
})

describe('handleBackPress', () => {
  it('有弹层时先关弹层，不回退页面（①）', () => {
    const close = vi.fn()
    register(close)
    const exit = vi.fn()
    const go = vi.fn()

    const action = handleBackPress({ go, exit })

    expect(action).toBe('closed')
    expect(close).toHaveBeenCalledTimes(1)
    expect(go).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('多层弹层按**后进先出**关：最后打开的那层先关', () => {
    const first = vi.fn()
    const second = vi.fn()
    register(first)
    register(second)

    handleBackPress({ go: () => {}, exit: () => {} })

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('没有弹层时退到**这一页登记的那一层**（②：不再是 history.back）', () => {
    at('/order/2026-10-15-DINNER', '/order')
    const go = vi.fn()
    const exit = vi.fn()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    const action = handleBackPress({ go, exit })

    expect(action).toBe('back')
    expect(go).toHaveBeenCalledWith('/order')
    // 关键：**不再碰浏览器历史**——用户报的两条怪行为都从那里来
    expect(back).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('Tab 根页（冰箱）：先回厨房，不退出（②：连点菜单不再一路退）', () => {
    at('/fridge')
    const go = vi.fn()
    const exit = vi.fn()

    const action = handleBackPress({ go, exit })

    expect(action).toBe('back')
    expect(go).toHaveBeenCalledWith('/kitchen')
    expect(exit).not.toHaveBeenCalled()
  })

  it('到首页（厨房）才退出 App（③）', () => {
    at('/kitchen')
    const go = vi.fn()
    const exit = vi.fn()

    const action = handleBackPress({ go, exit })

    expect(action).toBe('exit')
    expect(exit).toHaveBeenCalledTimes(1)
    expect(go).not.toHaveBeenCalled()
  })

  it('登记表里的目标是**动态路径**时也照它退（详情 → 上一餐那样的链）', () => {
    at('/recipes/r1', '/order/2026-10-15-DINNER')
    const go = vi.fn()

    expect(handleBackPress({ go, exit: () => {} })).toBe('back')
    expect(go).toHaveBeenCalledWith('/order/2026-10-15-DINNER')
  })

  it('默认判据读的就是"当前路径 + 登记表"（backTargetNow 与 resolveBack 同一份输入）', () => {
    at('/shopping', '/discover')
    expect(backTargetNow()).toBe('/discover')
    expect(
      resolveBack({ pathname: window.location.pathname, target: backTargetNow() }),
    ).toEqual({ type: 'go', to: '/discover' })

    // 没登记过的页：兜底回厨房（`resolveBack` 的那条规矩）
    at('/prep')
    expect(backTargetNow()).toBeNull()
    expect(
      resolveBack({ pathname: window.location.pathname, target: backTargetNow() }),
    ).toEqual({ type: 'go', to: '/kitchen' })
  })

  it('注销后不再吃掉返回键（抽屉关掉/组件卸载的那条路）', () => {
    const close = vi.fn()
    const unregister = register(close)
    unregister()

    expect(backCloserCount()).toBe(0)
    // 在子页上（有登记目标）：这一步该退页面，而不是"什么都不做"
    at('/prep', '/order')
    expect(handleBackPress({ go: () => {}, exit: () => {} })).toBe('back')
    expect(close).not.toHaveBeenCalled()
  })

  it('注销的是自己那一层，不误伤别人（同一函数注册两次也对）', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unregisterA = register(a)
    register(b)

    unregisterA()

    at('/prep', '/order')
    handleBackPress({ go: () => {}, exit: () => {} })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })
})
