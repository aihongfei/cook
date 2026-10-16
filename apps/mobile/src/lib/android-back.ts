import { App as CapacitorApp } from '@capacitor/app'
import { goBack } from './back-go'
import { backTargetOf } from './back-target'
import { resolveBack } from './back-policy'

/**
 * Android 系统返回键（F14-01 / R-13 ①；语义重定于 2026-10-16 / D-105）。
 *
 * 为什么必须自己接线：Capacitor 的 WebView **不会**把系统返回键翻译成 `history.back()`——
 * 不接管的话，按返回键在二级页上什么都不发生（模拟器实测：在 /taste 上按返回，页面纹丝不动），
 * 到根页面才退出。这与原生 App 的预期差得最远，是 R-13 列的第一条。
 *
 * ## 2026-10-16 改掉了什么（用户报的两条）
 *
 * 「连续点击菜单，然后返回都能一直返」＋「点击进入详情再点击其他菜单还能返回去详情」。
 * 根因是**把浏览器历史当成了导航栈**：原来第二档直接 `window.history.back()`，
 * 而底栏每次点击都会压一条历史——于是返回键忠实地一条条退，退过每个 Tab、
 * 还能退进刚离开的详情页。浏览器历史记的是"去过哪些地址"，不是"这一页的上一层是谁"。
 *
 * 现在**不再读历史**，改问 `resolveBack`（见 `lib/back-policy` 文件头）：
 * 子页回它自己登记过的上一层（`lib/back-target`，与页面上那颗箭头同一个值），
 * Tab 根页回「厨房」，到「厨房」再按才退出。
 *
 * 三档优先级（与用户心里的顺序一致）：
 * 1. **有弹层开着就先关弹层**：抽屉/确认框是"当前这一步"的界面，直接退页面会把它背后的页面也带走；
 * 2. **还能回上一层就回**：目标由那一页自己声明；导航用 `replace`——
 *    这一趟不是"又去了一页"，而是"退回去了"，历史里不该再多一条记录；
 * 3. **到首页了才退出 App**：`exitApp()` 与原生一致（退到桌面，不是"回到上一次打开的应用"）。
 *
 * 退出前**不再有"回不去"这一档**：原来靠 `history.state.idx > 0` 判，那个量描述的是
 * 浏览器历史（现在它已经不是导航栈了），留着只会把两种口径混在一起——
 * 全项目唯一使用它的一处就是这里，已删除。
 *
 * 只在原生壳里生效：浏览器里没有返回键事件，装了也只会白白多一层监听（且 Capacitor
 * 在 Web 上调用插件会抛未实现）。
 *
 * ## 系统的返回键由谁接管（2026-10-16 交付三）
 *
 * `@capacitor/app` 自己有一条 `OnBackPressedCallback`，而且它的开销是"每次按键都往 JS 发一个事件"。
 * 现在返回的判定**只许有一处**（就是本文件），所以 `capacitor.config.ts` 里关掉了它那条
 * （`plugins.App.disableBackButtonHandler`）——否则两条回调会在同一次按键上各做各的判断。
 * 关掉之后按键由**我们自己的** `BackGesturePlugin` 接管（它还要把手势进度送进来，见
 * `src/api/back-gesture-native.ts`）；插件不存在时退回"系统默认行为"。
 */

/** 弹层的关闭函数栈。后进先出：最后打开的那层先关（抽屉叠抽屉时顺序才对） */
const closers: Array<() => void> = []

/**
 * 弹层开合时通知外面（**手势那一层要用**，见文件末尾 `installAndroidBack`）。
 *
 * 为什么要有这条：`lib/back-gesture` 要算"这一次返回归不归我们管"，而**弹层是判据之一**
 * （开着弹层时要关弹层、不该摆两页）。它 subscribe 这里，一开一关就重算；
 * 反向的依赖（本模块 import back-gesture）会造成环形 import，所以用订阅而不用回调。
 */
const closerListeners = new Set<() => void>()

/** 订阅"弹层开合了"。返回取消订阅 */
export function subscribeBackCloserChanges(listener: () => void): () => void {
  closerListeners.add(listener)
  return () => {
    closerListeners.delete(listener)
  }
}

function notifyCloserChanges(): void {
  for (const listener of closerListeners) listener()
}

/**
 * 注册一个"返回时优先关闭我"的弹层。返回注销函数（组件卸载/收起时调用）。
 * 用栈而不是"只记一个"：AI 抽屉里还能再开别的抽屉，谁最后开谁先关。
 */
export function registerBackCloser(close: () => void): () => void {
  closers.push(close)
  notifyCloserChanges()
  return () => {
    const index = closers.lastIndexOf(close)
    if (index >= 0) closers.splice(index, 1)
    notifyCloserChanges()
  }
}

/** 当前有几层弹层开着（测试用；也方便排查"返回键怎么没退页面"） */
export function backCloserCount(): number {
  return closers.length
}

/**
 * 这一页现在该退到哪（交给 `resolveBack` 判，见 `lib/back-policy`）。
 *
 * 抽成一个小函数是为了让测试能一眼看清"输入是什么"：当前的路径 + 这一页登记的返回目标。
 */
export function backTargetNow(): string | null {
  return backTargetOf(window.location.pathname)
}

/**
 * 处理一次返回键按下。抽出来是为了能单测：
 * Capacitor 的监听要真机才有事件，而"先关弹层、再回上一层、最后退出"这套顺序是纯逻辑。
 *
 * @returns 'closed' | 'back' | 'exit' —— 实际做的动作，便于断言
 */
export function handleBackPress(options?: {
  /** 覆盖"这一趟退到哪"的判断（默认读当前路径与登记表） */
  decide?: () => ReturnType<typeof resolveBack>
  /** 覆盖导航动作（默认调 main.tsx 注入的路由 `replace`，测试里不需要真跳） */
  go?: (to: string) => void
  /** 覆盖退出动作（默认 Capacitor 的 exitApp，测试里不需要真退） */
  exit?: () => void
}): 'closed' | 'back' | 'exit' {
  const top = closers[closers.length - 1]
  if (top) {
    top()
    return 'closed'
  }

  const decide =
    options?.decide ??
    (() =>
      resolveBack({
        pathname: window.location.pathname,
        target: backTargetNow(),
      }))

  const decision = decide()
  if (decision.type === 'exit') {
    const exit = options?.exit ?? (() => void CapacitorApp.exitApp())
    exit()
    return 'exit'
  }

  const go = options?.go ?? goBack
  go(decision.to)
  return 'back'
}

/**
 * 装一次即可（`main.tsx` 调）。返回卸载函数；重复调用是安全的。
 *
 * **它不再监听 `@capacitor/app` 的 `backButton` 事件**（2026-10-16 / D-109）：
 * 那个事件已经被关掉了（`capacitor.config.ts` 的 `plugins.App.disableBackButtonHandler`），
 * 按键与手势统一由 `BackGesturePlugin` → `lib/back-gesture` → `handleBackPress()` 走。
 *
 * 所以这个函数现在只做一件接口上的小事：把 `handleBackPress` 暴露出去——
 * `installBackGesture()` 从 `lib/back-gesture` 那边接（它 import 本模块，
 * 本模块不回头 import 它，避免环形 import）。`main.tsx` 那两行不用管谁先谁后。
 */
export function installAndroidBack(): () => void {
  return () => {}
}
