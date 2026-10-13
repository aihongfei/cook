import { create } from 'zustand'
import type { SuggestedPick } from '@/api/ai'

/**
 * 「AI 帮你想」这一场会话的状态（用户 2026-10-13：「这里面的菜要求可以点进去看详情，
 * 然后返回的时候这个 ai 帮你想还是打开的，保持原样」）。
 *
 * **为什么要放进 store 而不是组件里的 useState**：点菜名看详情是一次**路由跳转**，
 * 发现页整个被卸载，组件状态（推荐列表、打了字的提示、已加入的标记）全都没了——
 * 用户从详情回来会看到一个关着抽屉、或者开着但空空如也的界面，等于刚才那一问白问。
 * 会话状态必须活过这次跳转，所以挪到模块级（与 `stores/auth` 同一套做法）。
 *
 * **命名**：叫 `useAiSuggestSession` 而不是 `useAiSuggest`——后者已经是 `api/ai` 里那个
 * "要一批推荐"的请求 hook，两个同名会让人分不清"状态"与"请求"。
 *
 * **不持久化**（没有 persist）：这是"这一次打开"的状态，刷新页面/重开 App 就该重新来过；
 * 而"关掉抽屉再打开是干净的一次"是之前就定下的口径（见 DiscoverPage 的注释），
 * 由 `close()` 守住。
 *
 * 三个动作的语义分得很清，这是本模块唯一容易做错的地方：
 * - `start()`：用户新开一次（点「AI 帮你想」）——推荐、输入、已加入标记、快问全部清零，
 *   快问那一排由**抽屉自己**在挂载时抽（见 AiSuggestSheet：那里离"抽哪一批"更近——
 *   有 AI 那批就抽它，没有才用兜底池）；
 * - `close()`：用户自己关掉（遮罩/下滑/去菜谱小书）——全清，下次打开是干净的一次；
 * - **点菜名进详情不调任何动作**：状态原地不动，抽屉的 `open` 仍是 true，
 *   所以返回时它还是开着的（"续上"这件事由 `picks` 非空自然表达，见 AiSuggestSheet 的 `resumed`）。
 */
interface AiSuggestSession {
  /** 抽屉开着没有。**活过路由跳转**——点菜名去详情时它必须保持 true */
  open: boolean
  /** 输入框里打过的字（返回后还在，用户不必重打） */
  hint: string
  /** 这一批推荐；`null` = 还没问过（也是"这次是续上还是新开"的判据） */
  picks: SuggestedPick[] | null
  /** 已经点过「点这道」的那几道（按 recipeId 记） */
  added: string[]
  /** 快问那一排（新开时先抽兜底池，AI 那批到手后重抽） */
  quickHints: string[]
  start: () => void
  close: () => void
  setHint: (hint: string) => void
  setPicks: (picks: SuggestedPick[] | null) => void
  markAdded: (recipeId: string) => void
  /** 清掉"已加入"标记（重问时用：新一批是另一批菜，旧标记没有意义） */
  clearAdded: () => void
  setQuickHints: (hints: string[]) => void
}

export const useAiSuggestSession = create<AiSuggestSession>()((set) => ({
  open: false,
  hint: '',
  picks: null,
  added: [],
  quickHints: [],
  start: () => set({ open: true, hint: '', picks: null, added: [], quickHints: [] }),
  close: () => set({ open: false, hint: '', picks: null, added: [], quickHints: [] }),
  setHint: (hint) => set({ hint }),
  setPicks: (picks) => set({ picks }),
  markAdded: (recipeId) => set((state) => (
    state.added.includes(recipeId) ? state : { added: [...state.added, recipeId] }
  )),
  clearAdded: () => set({ added: [] }),
  setQuickHints: (quickHints) => set({ quickHints }),
}))
