import { create } from 'zustand'
import type { DecideResult } from '@/api/decide'

/**
 * 「帮我决定」这一场会话的状态（M5 / F5-05）。
 *
 * **为什么需要 store**：这与「AI 帮你想」是同一个问题（见 `ai-suggest-session` 的说明）——
 * 抽屉里的菜名能点进详情，那是一次**路由跳转**，发现页整个被卸载。若把"挑出来的那道菜"
 * 只放在组件里，用户看完做法返回时会发现抽屉关了、菜也没了；他刚在评估的那道菜
 * 就这样消失了，只能重新点一次（而重新点会给出**另一道**菜——比"没效果"更让人困惑）。
 * 所以这道菜、已经看过的几道、以及"已经加进菜单"的标记都放在模块级。
 *
 * **与「AI 帮你想」的一处不同**：那边"续上"的判据是 `picks` 非空；这边是 `result` 非空。
 * 两者都在 `start()` 里清零，于是"新点一次 = 干净的一次"由同一个动作守住。
 *
 * 不持久化：这是"这一次打开"的状态，刷新/重开 App 就该重新来过。
 */
interface DecideSession {
  /** 抽屉开着没有。**活过路由跳转**——点菜名去详情时它必须保持 true */
  open: boolean
  /** 这一轮挑出来的那道（`null` = 还没挑 / 还没回来）。也是"续上还是新开"的判据 */
  result: DecideResult | null
  /** 这一轮已经看过的菜谱 id：换一道时把它们排除掉，否则可能换回同一道 */
  seen: string[]
  /** 当前这道已经加进菜单了没有（加过就把按钮换成一句话，避免同一道菜加两遍） */
  added: boolean
  /**
   * 这一场**已经问过了**。
   *
   * 这个标记必须在 store 里（活过重挂载），不能只是组件里的 state：
   * React 的 StrictMode 在开发模式下会"挂载 → 卸载 → 再挂载"，组件 state 会重置，
   * 于是"打开即问一次"会问**两次**；而且后回来的那次结果会把已经显示出来的那道菜
   * **悄悄换掉**——用户刚看到一道菜、还没读完理由，它自己变了（浏览器实测抓到的：
   * 同一个抽屉里先显示"番茄炒蛋"，一秒后变成"香奶胡萝卜鸡蛋羹"）。
   */
  asked: boolean
  start: () => void
  close: () => void
  markAsked: () => void
  setResult: (result: DecideResult) => void
  /** 记下"看过这道了"（换一道之前调） */
  pushSeen: (recipeId: string) => void
  setAdded: (added: boolean) => void
  /** 请求失败：把 result 清回 `null`，但**不关抽屉、也不清 seen**——用户点「再试一次」时还要用 */
  reset: () => void
}

export const useDecideSession = create<DecideSession>()((set) => ({
  open: false,
  result: null,
  seen: [],
  added: false,
  asked: false,
  start: () => set({ open: true, result: null, seen: [], added: false, asked: false }),
  close: () => set({ open: false, result: null, seen: [], added: false, asked: false }),
  markAsked: () => set({ asked: true }),
  setResult: (result) => set({ result }),
  pushSeen: (recipeId) => set((state) => (
    state.seen.includes(recipeId) ? state : { seen: [...state.seen, recipeId] }
  )),
  setAdded: (added) => set({ added }),
  reset: () => set({ result: null }),
}))
