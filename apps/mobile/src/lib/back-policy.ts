import { tabs } from '@/config/tabs'

/**
 * 「按返回键该去哪」这件事的**唯一判据**（用户 2026-10-16：「连续点击菜单，然后返回都能一直返，
 * 点击进入详情再点击其他菜单还能返回去详情，和原生的逻辑完全不一样」）。
 *
 * ## 原来错在哪
 *
 * 底栏五个 Tab 是普通 `<Link>`（每次点击往历史里压一条），而返回键直接调
 * `window.history.back()`——于是它**忠实地一条条退**：退过每一个点过的 Tab，
 * 还能退进刚离开的详情页。那是**把浏览器历史当成了导航栈**，而浏览器历史里
 * 记的是"去过哪些地址"，不是"这一页的上一层是谁"。
 *
 * ## 现在的口径（两句话说完）
 *
 * 1. **子页 → 回它的上一层**。上一层由页面自己声明（`useBackLink` 登记的那一份，
 *    与页面上那颗「← 返回」指向的是同一个值，见 `lib/back-target`）——
 *    所以"返回键"和"页面上的返回按钮"**按构造不可能去两个地方**；
 * 2. **Tab 根页 → 先回「厨房」，再按 → 退出**（任一 Tab 根页，不只是厨房）：
 *    五个 Tab 是平级的五个岛，从冰箱按返回不该退出 App，而是"回家"；
 *    到了厨房（默认首页）再按，与原生一致地退回桌面。
 *
 * 没登记目标又不在 Tab 里的页（现在的唯一一处是菜谱小书的**桌面版**分支，
 * 它自己写着「← 厨房」）退到厨房——菜谱库本来就归厨房。
 *
 * ## 为什么写成纯函数
 *
 * 这条判据只在**真机上按返回键**才跑到，模拟器/浏览器的自动化都探不进去；
 * 抽出来就能用单测把每种落点钉死（与 `page-turn.ts`、`unread-badges.ts` 同一条做法）。
 */
export type BackDecision = { type: 'exit' } | { type: 'go'; to: string }

/** 首页 Tab：返回键的"最后一站"（到了这儿再按才退出应用） */
export const HOME_TAB = '/kitchen'

/**
 * 登录那几页在外壳之外（`router/index.tsx` 里挂在守卫外），没有底栏、也没有返回箭头。
 * 它们之间是"上一页"的关系：注册/忘记密码是**从登录页点进去**的，按返回该回登录页；
 * 登录页本身是这一支的根，按返回＝退出（与原生一致）。
 */
const AUTH_BACK: Record<string, string> = {
  '/register': '/login',
  '/forgot': '/login',
  '/reset-password': '/login',
}

/**
 * @param pathname 现在人在哪（`window.location.pathname`，不含查询串）
 * @param target   这一页登记过的返回目标（没有就传 null/undefined）
 */
export function resolveBack(input: { pathname: string; target?: string | null }): BackDecision {
  const { pathname } = input
  const target = input.target ?? null

  // 页面自己声明了上一层：用它。**它优先于一切**——包括"Tab 根页"那些规则，
  // 因为声明是"这一页是从哪儿来的"这个更具体的事实。
  if (target) return { type: 'go', to: target }

  if (pathname === '/login') return { type: 'exit' }
  const auth = AUTH_BACK[pathname]
  if (auth) return { type: 'go', to: auth }

  // 「厨房」是默认首页：到这儿再按返回才是退出（原生的"退到桌面"）
  if (pathname === HOME_TAB) return { type: 'exit' }

  // 其余全部回厨房：另外四个 Tab 根页（平级"回家"）、以及没登记目标的子页
  return { type: 'go', to: HOME_TAB }
}

/**
 * 这个路径是不是底栏五个 Tab 之一。
 *
 * 判据只有这里一份：`resolveBack` 与 `lib/back-gesture`（手势要不要自己接管）
 * 都要问"这是不是一个岛的根"。
 */
export function isTabPath(pathname: string): boolean {
  return tabs.some((tab) => tab.path === pathname)
}
