import { cachedStateOf, startBackNavigation } from './back-transition'

/**
 * 「退回去」这一个动作的**唯一入口**（2026-10-16 / D-105、D-106）。
 *
 * 三件必须一起发生的事，写在同一个函数里，免得哪个调用点漏一件：
 *
 * 1. **起跳两层动画**（`startBackNavigation`）：要离开的那一页划走、要回去的那一页跟进；
 * 2. **用 `replace` 导航**：这一趟是"退回去了"，不是"又去了一页"——
 *    历史里不该再多留一条（这也是用户报的"返回能一直退"的根治，见 `back-policy`）；
 * 3. **把目标那一页自己的 state 交还给它**：`replace` 不会自动带回去（见
 *    `back-transition` 里 `cachedStateOf` 的说明）——不带的话，
 *    通知中心 → 那一餐 → 菜谱 → 返回这一餐 的返回箭头会退回点菜单。
 *
 * 谁调它：页面上那颗「← 返回」（`components/ui/BackLink`）、系统返回键
 * （`lib/android-back`）、以及手势松手（`lib/back-gesture`）。
 */
let navigateFn: ((to: string, options?: { replace?: boolean; state?: unknown }) => void) | null = null

/**
 * 由 `main.tsx` 在启动时接上路由的 `navigate`。
 *
 * **为什么要注入**：路由对象在 `router/index.tsx`，而它 import 页面、页面又要用
 * `goBack`——直接互相 import 会绕成一个环。谁在最外层谁接线，模块只留一个口
 * （与 `RealtimeSync` 那一族的分层同一条规矩）。
 */
export function setBackNavigator(fn: ((to: string, options?: { replace?: boolean; state?: unknown }) => void) | null): void {
  navigateFn = fn
}

/** 退到 `to`（见文件头三件事）。路由还没接上时退回浏览器历史——降级，不是本意 */
export function goBack(to: string): void {
  startBackNavigation(to)
  if (navigateFn) {
    navigateFn(to, { replace: true, state: cachedStateOf(to) })
    return
  }
  window.history.back()
}

/** 测试用：拔掉接线（用例之间必须互不影响） */
export function resetBackNavigator(): void {
  navigateFn = null
}
