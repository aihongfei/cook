/**
 * 每个页面自己的滚动位置（用户 2026-10-14：「我从下方点进去，再返回就滚动到最上面了，
 * 需要保留上次的位置，包括厨房那页也是，整个系统都是」）。
 *
 * 单独一个模块是为了能**不进 DOM** 直接单测（与 `plan-target.ts`、`unread-badges.ts`
 * 同一条理由）：判断就两条——"哪一页"与"记到哪"——而它们正是最容易写错的地方。
 */

/** 「哪一页」= 路径 + 查询串（`/recipes?category=主食` 与 `/recipes` 是两页） */
export function pageKeyOf(location: { pathname: string; search?: string }): string {
  return `${location.pathname}${location.search ?? ''}`
}

export interface ScrollMemory {
  /** 这一页上次停在哪；没记过就是 0（新页面从头看） */
  read(key: string): number
  save(key: string, top: number): void
}

/**
 * 一张 `页面 → 位置` 的表。
 *
 * `save` 只收**能当滚动位置用的数**（有限、非负）：读回来会直接赋给 `scrollTop`，
 * 一个 `NaN` 或负值会让页面跳到莫名其妙的地方，而"退回顶部"至少是能理解的行为。
 *
 * 没有 `clear`：这张表活在 `TabLayout` 的 ref 里，**退出登录会把那个布局卸载**，
 * 表随实例一起消失（下一个账号进来是新的一张）。留一个没人调用的 `clear`
 * 只会让人以为"某处需要手动清"——真需要时再加。
 */
export function createScrollMemory(): ScrollMemory {
  const map = new Map<string, number>()
  return {
    read: (key) => map.get(key) ?? 0,
    save: (key, top) => {
      if (Number.isFinite(top) && top >= 0) map.set(key, top)
    },
  }
}
