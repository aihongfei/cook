import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

/**
 * Android 系统返回键（F14-01 / R-13 ①）。
 *
 * 为什么必须自己接线：Capacitor 的 WebView **不会**把系统返回键翻译成 `history.back()`——
 * 不接管的话，按返回键在二级页上什么都不发生（模拟器实测：在 /taste 上按返回，页面纹丝不动），
 * 到根页面才退出。这与原生 App 的预期差得最远，是 R-13 列的第一条。
 *
 * 三档优先级（与用户心里的顺序一致）：
 * 1. **有弹层开着就先关弹层**：抽屉/确认框是"当前这一步"的界面，直接退页面会把它背后的页面也带走；
 * 2. **还能回退就回退**：判据用 `history.state.idx`（react-router 在每条历史记录里存的序号），
 *    而不是 `history.length`——后者在"退回去"之后仍然不减，会让人以为还能再退（踩过的坑）；
 * 3. **到根了才退出 App**：`exitApp()` 与原生一致（退到桌面，不是"回到上一次打开的应用"）。
 *
 * 只在原生壳里生效：浏览器里没有返回键事件，装了也只会白白多一层监听（且 Capacitor
 * 在 Web 上调用插件会抛未实现）。
 */

/** 弹层的关闭函数栈。后进先出：最后打开的那层先关（抽屉叠抽屉时顺序才对） */
const closers: Array<() => void> = []

/**
 * 注册一个"返回时优先关闭我"的弹层。返回注销函数（组件卸载/收起时调用）。
 * 用栈而不是"只记一个"：AI 抽屉里还能再开别的抽屉，谁最后开谁先关。
 */
export function registerBackCloser(close: () => void): () => void {
  closers.push(close)
  return () => {
    const index = closers.lastIndexOf(close)
    if (index >= 0) closers.splice(index, 1)
  }
}

/** 当前有几层弹层开着（测试用；也方便排查"返回键怎么没退页面"） */
export function backCloserCount(): number {
  return closers.length
}

/**
 * 处理一次返回键按下。抽出来是为了能单测：
 * Capacitor 的监听要真机才有事件，而"先关弹层、再回退、最后退出"这套顺序是纯逻辑。
 *
 * @returns 'closed' | 'back' | 'exit' —— 实际做的动作，便于断言
 */
export function handleBackPress(options?: {
  /** 覆盖"还能不能回退"的判断（默认读 history.state.idx） */
  canGoBack?: () => boolean
  /** 覆盖退出动作（默认 Capacitor 的 exitApp，测试里不需要真退） */
  exit?: () => void
}): 'closed' | 'back' | 'exit' {
  const top = closers[closers.length - 1]
  if (top) {
    top()
    return 'closed'
  }

  const canGoBack =
    options?.canGoBack ??
    (() => {
      // react-router 把序号写在历史记录的 state 里；首条是 0。读不到（非 router 环境）就当首条
      const idx = (window.history.state as { idx?: number } | null)?.idx
      return typeof idx === 'number' && idx > 0
    })

  if (canGoBack()) {
    window.history.back()
    return 'back'
  }

  const exit = options?.exit ?? (() => void CapacitorApp.exitApp())
  exit()
  return 'exit'
}

/** 装一次即可（main.tsx 调）。返回卸载函数；重复调用是安全的 */
export function installAndroidBack(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {}

  const handle = CapacitorApp.addListener('backButton', () => {
    handleBackPress()
  })

  return () => {
    void handle.then((listener) => listener.remove())
  }
}
