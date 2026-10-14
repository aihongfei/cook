/**
 * 点单卡上的"有事没看过"标记（用户 2026-10-14：「订单有红点，但是里面的卡片看不出来
 * 哪个是提醒的」）。
 *
 * 单独一个 `.ts` 而不是塞在 `OrderPage.tsx` 里，与 `plan-target.ts` 同一条理由：
 * 纯函数与组件分开，`fast refresh` 才不会被非组件导出打断（lint 会为这一点报警），
 * 而且这两条判据能**不进 jsdom** 直接单测——它们才是这段逻辑里会被改坏的地方。
 */

/** 提醒里够画到卡片上的那几列（`AppNotification` 的子集，只取用得上的） */
export interface MealBadgeSource {
  kind: string
  mealKey: string | null
  unread: boolean
  tag: string
}

/**
 * 把未读提醒按**哪一餐**聚起来（卡上要标的就这一件事）。
 *
 * 三条刻意的：
 * - **只看未读**（`unread`）：已读的提醒不该继续在列表上叫——用户在通知中心点过了，
 *   回来还看到一模一样的标记，会觉得"我明明点过了"；
 * - **只收带 `mealKey` 的**：「该备菜」说的是"某一餐还空着"——**那一餐没有卡**
 *   （没人点菜才空着），所以它标不到卡片上。它仍然算在订单 Tab 的红点里
 *   （入口在订单那一支），但列表上没有它的位置，**不编一个指不到东西的标记**；
 * - **键是 `餐次:类别`**：后端每一餐、每一类只产出一条（id 就是 `plan:2026-10-18-DINNER`
 *   这个形状），所以这里不是"去重"、是**查表**——一餐有两条（菜单、做好了）时
 *   两条各占各的键，不会互相顶掉。
 */
export function unreadByMeal(items: MealBadgeSource[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const item of items) {
    if (!item.unread || !item.mealKey) continue
    out.set(`${item.mealKey}:${item.kind}`, item.tag)
  }
  return out
}

/**
 * 这一张卡上要标哪些（**顺序固定**：做好了在前，菜单在后）。
 *
 * 顺序写死而不是跟着列表的顺序走：列表按时刻排，而"最要紧的那个"不总是最新的
 * ——饭做好了比"菜单定下来了"更该先看到。
 */
export function badgesOfMeal(map: Map<string, string>, mealKey: string): string[] {
  return (['done', 'plan'] as const)
    .map((kind) => map.get(`${mealKey}:${kind}`))
    .filter((tag): tag is string => Boolean(tag))
}
