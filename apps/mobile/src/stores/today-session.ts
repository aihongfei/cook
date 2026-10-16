import { create } from 'zustand'
import type { DecideResult } from '@/api/decide'
import type { SuggestedPick } from '@/api/ai'

/**
 * 「帮我决定」这一个抽屉的会话状态（M5 / F5-05 + M16 / F5-05 合并后，见 D-061）。
 *
 * 2026-10-13 用户提出「帮我决定」与「AI 帮你想」看着重复，选定合并成**一个入口**：
 * 打开先给**立刻的那一道**（纯规则、懂冰箱、不用 AI 也能用），下面一行"想吃点特别的？"
 * 才去调 AI。所以这两套状态现在住在同一个 store 里——它们本来就是同一个抽屉的两半。
 *
 * **为什么需要 store 而不是组件里的 useState**（两半各自的原因，现在并存）：
 * - 抽屉里的菜名能点进详情，那是一次**路由跳转**，发现页整个被卸载。用户看完做法返回时
 *   必须看到**同一道菜**（重新挑等于把答案抽走）、以及刚才那份 AI 推荐原样还在
 *   （用户 2026-10-13 对「AI 帮你想」的原话是"返回时还是打开的、保持原样"）；
 * - `asked` / `started` 这类"这一场开始了没有"的标记也必须在 store 里：
 *   React StrictMode 会"挂载 → 卸载 → 再挂载"，组件 state 会重置，于是同一个请求
 *   会发两次，后回来的那次结果把已经显示出来的东西**悄悄换掉**
 *   （浏览器实测抓到过：先"番茄炒蛋"、一秒后自己变成另一道）。
 *
 * 不持久化：这是"这一次打开"的状态，刷新/重开 App 就该重新来过；
 * "关掉再打开是干净的一场"由 `close()` 守住。
 */
interface TodaySession {
  /** 抽屉开着没有。**活过路由跳转**——点菜名去详情时它必须保持 true */
  open: boolean

  // ---------- 上半：立刻的那一道（F5-05） ----------

  /** 挑出来的那道（`null` = 还没挑 / 还没回来）。也是"续上还是新开"的判据 */
  result: DecideResult | null
  /** 这一轮已经看过的菜谱 id：「换一道」要把它们排除掉，否则可能换回同一道 */
  seen: string[]
  /** 上面这道已经加进菜单了没有 */
  decideAdded: boolean
  /** 这一场**已经问过了**（见文件头：StrictMode 会重挂载，标记不能只放组件里） */
  asked: boolean

  /**
   * 「换个场合挑」选中的那个场合（标签名，如 `宴请`；`null` = 没选）。
   *
   * **也在 store 里**，理由与 `result` 一样：这一行是抽屉的一部分，而抽屉里的菜名
   * 点得进详情——用户点了「来客人了」、挑出一道菜、点菜名去看做法、再返回时，
   * 那一行必须还是选中的那一个（否则他会以为"我点的场合没了"，
   * 与用户 2026-10-13 在这个抽屉上定的"保持原样"是同一条要求）。
   */
  occasion: string | null

  // ---------- 下半：想提要求时问 AI（M16 子集） ----------

  /** 用户在输入框里打过的字（返回后还在，不必重打） */
  hint: string
  /** AI 给的那一批；`null` = 还没问过 */
  picks: SuggestedPick[] | null
  /** 已经点过「点这道」的那几道（按 recipeId 记） */
  aiAdded: string[]
  /** 快问那一排（先给兜底池，AI 那批到手后换上） */
  quickHints: string[]
  /** 问过 AI 了没有（同 `asked`：活过重挂载，免得重挂载时又发一次） */
  aiAsked: boolean
  /**
   * 下半（AI）那块**展开了没有**。
   *
   * 也在 store 里：用户点 AI 推荐的菜名去看做法、再返回时，那一块必须还是展开的
   * （用户 2026-10-13 对「AI 帮你想」的原话是"返回时还是打开的、保持原样"）。
   * 放在组件的 useState 里，路由跳转一卸载就收回去了——推荐还在，但用户得再点一次才看得见。
   */
  aiOpen: boolean

  start: () => void
  close: () => void
  markAsked: () => void
  setResult: (result: DecideResult) => void
  pushSeen: (recipeId: string) => void
  setDecideAdded: (added: boolean) => void
  setOccasion: (occasion: string | null) => void
  /** 请求失败：把 result 清回 `null`，但**不关抽屉、也不清 seen**——点「再试一次」时还要用 */
  reset: () => void

  markAiAsked: () => void
  setAiOpen: (open: boolean) => void
  setHint: (hint: string) => void
  setPicks: (picks: SuggestedPick[] | null) => void
  markAiAdded: (recipeId: string) => void
  /** 清掉 AI 那边的"已加入"标记（重新问时用：新一批是另一批菜，旧标记没有意义） */
  clearAiAdded: () => void
  setQuickHints: (hints: string[]) => void
}

/** 一场会话开始时（以及结束时）的所有字段。**不写 `as const`**：
 * 那会让数组变成 `readonly []`，与上面的接口对不上（TS2322）。 */
const EMPTY: Omit<TodaySession, 'open' | 'start' | 'close' | 'markAsked' | 'setResult' | 'pushSeen' | 'setDecideAdded' | 'setOccasion' | 'reset' | 'markAiAsked' | 'setAiOpen' | 'setHint' | 'setPicks' | 'markAiAdded' | 'clearAiAdded' | 'setQuickHints'> = {
  result: null,
  seen: [],
  decideAdded: false,
  asked: false,
  occasion: null,
  hint: '',
  picks: null,
  aiAdded: [],
  quickHints: [],
  aiAsked: false,
  aiOpen: false,
}

export const useTodaySession = create<TodaySession>()((set) => ({
  open: false,
  ...EMPTY,
  start: () => set({ open: true, ...EMPTY }),
  close: () => set({ open: false, ...EMPTY }),
  markAsked: () => set({ asked: true }),
  setResult: (result) => set({ result }),
  pushSeen: (recipeId) => set((state) => (
    state.seen.includes(recipeId) ? state : { seen: [...state.seen, recipeId] }
  )),
  setDecideAdded: (decideAdded) => set({ decideAdded }),
  setOccasion: (occasion) => set({ occasion }),
  reset: () => set({ result: null }),
  markAiAsked: () => set({ aiAsked: true }),
  setAiOpen: (aiOpen) => set({ aiOpen }),
  setHint: (hint) => set({ hint }),
  setPicks: (picks) => set({ picks }),
  markAiAdded: (recipeId) => set((state) => (
    state.aiAdded.includes(recipeId) ? state : { aiAdded: [...state.aiAdded, recipeId] }
  )),
  clearAiAdded: () => set({ aiAdded: [] }),
  setQuickHints: (quickHints) => set({ quickHints }),
}))
