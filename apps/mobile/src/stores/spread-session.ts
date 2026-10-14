import { create } from 'zustand'
import type { SpreadResult } from '@/api/spread'

/**
 * 「摇一桌」这个抽屉的会话状态（M5 / F5-01，2026-10-15 由「摇一道」升级而来）。
 *
 * **为什么和 `today-session` 一样要放进 store**：抽屉里的菜名能点进详情，
 * 那是一次路由跳转，发现页整个被卸载。用户看完做法返回时，这一桌必须**原样还在**
 * ——重新摇一桌等于把他正在看的那桌菜抽走。这条是用户 2026-10-13 对「帮我决定」
 * 亲口提的（"返回时还是打开的、保持原样"），同一个道理，不重复踩一次。
 *
 * `asked` 也在 store 里：React StrictMode 会"挂载 → 卸载 → 再挂载"，组件 state 会重置，
 * 于是同一个请求发两次，后回来的那桌把已经显示出来的一桌菜**悄悄换掉**。
 *
 * 不持久化：刷新/重开 App 就该重新来过；"关掉再打开是干净的一场"由 `close()` 守住。
 */
interface SpreadSession {
  /** 抽屉开着没有。**活过路由跳转** */
  open: boolean
  /** 摇出来的这一桌（`null` = 还没摇 / 还没回来） */
  result: SpreadResult | null
  /** 这一场**已经摇过了**（见文件头：StrictMode 会重挂载，标记不能只放组件里） */
  asked: boolean
  /** 用户改过的人数（`null` = 按后端算的：这一餐存着的或默认值） */
  diners: number | null
  /** 这一桌里已经加进菜单的那几道（单独「就它了」与整组加入都记在这里） */
  added: string[]

  start: () => void
  close: () => void
  markAsked: () => void
  /** 新摇的一桌进来：`added` 一并清掉（那是上一桌的记录，留着会让新菜显示成"已加入"） */
  setResult: (result: SpreadResult, diners: number | null) => void
  markAdded: (recipeIds: string[]) => void
  /** 请求失败：清回 `null` 但**不关抽屉**，用户点「再摇一次」还要用 */
  reset: () => void
}

type Actions =
  | 'open' | 'start' | 'close' | 'markAsked' | 'setResult' | 'markAdded' | 'reset'

/** 一场会话开始/结束时的所有字段 */
const EMPTY: Omit<SpreadSession, Actions> = {
  result: null,
  asked: false,
  diners: null,
  added: [],
}

export const useSpreadSession = create<SpreadSession>()((set) => ({
  open: false,
  ...EMPTY,
  start: () => set({ open: true, ...EMPTY }),
  close: () => set({ open: false, ...EMPTY }),
  markAsked: () => set({ asked: true }),
  setResult: (result, diners) => set({ result, diners, added: [] }),
  markAdded: (recipeIds) => set((state) => ({
    added: [...state.added, ...recipeIds.filter((id) => !state.added.includes(id))],
  })),
  reset: () => set({ result: null }),
}))
