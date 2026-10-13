import { create } from 'zustand'
import type { FridgeZone } from '@/api/fridge'

/**
 * 冰箱页"看哪一格"的状态（B 方案，见 D-063）。
 *
 * **为什么需要 store 而不是组件里的 useState**：冰箱页里能点进菜谱详情
 * （「能做点什么」那种卡），那是一次**路由跳转**，冰箱页整个被卸载。
 * 用户看了做法返回时，如果靠 useState，选中的那一格会**跳回默认的那一格**——
 * 他刚才特意点开的「常温」没了。
 *
 * 用户对这类"返回后原样"的要求是明说过的（2026-10-13，针对发现页那张卡：
 * "返回时还是打开的、保持原样"）。这里只是把同一条规矩用在冰箱页：
 * **选中哪一格、最近录入展没展开，都要活过路由跳转**。
 *
 * 与 `today-session` 一样**不持久化**：这是"这一次打开"的状态，
 * 刷新或重开 App 就该重新来过（回到默认那一格）。
 */
interface FridgeView {
  /**
   * 用户点过的那一格。`null` = 还没点过 → 组件用默认值（样数最多的那格）。
   *
   * 存 `null` 而不是存"默认那一格"：默认值是**按当前冰箱算出来的**
   * （样数最多的那格），把它写死进 store 就等于让"哪一格最多"在用户点过之后不再更新。
   */
  zone: FridgeZone | null
  /** 「最近记的 N 样」展开着没有（同一类：返回后该还是展着的） */
  recentOpen: boolean

  setZone: (zone: FridgeZone) => void
  setRecentOpen: (open: boolean) => void
}

export const useFridgeView = create<FridgeView>()((set) => ({
  zone: null,
  recentOpen: false,
  setZone: (zone) => set({ zone }),
  setRecentOpen: (recentOpen) => set({ recentOpen }),
}))
