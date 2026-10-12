import type { MealSlot } from '@/api/orders'

/**
 * 「去安排某一餐」的目标（M4 / F4-02）：本周菜单点「去安排」时带上的日期 + 餐次。
 *
 * 它要跨几个页面传（发现页 → 菜谱小书 → 菜谱详情 → 点菜抽屉），所以在路由 state 里走，
 * 每处都用 `readPlanTarget` 读一遍——路由 state 是**外部输入**（用户可以手改、也可能是昨天留下的链接），
 * 直接 `as` 断言就等于把它当可信数据用了。读不出来就返回 null，各页面自然退回默认行为。
 *
 * `label` 只用于展示（"后天·晚餐"这种），**不参与判定**：真正的可选范围以点菜抽屉里的
 * `dayOptions`（后端按"现在"算的）为准，两者对不上时按后者兜底（见 OrderDishSheet）。
 */
export interface PlanTarget {
  date: string
  meal: MealSlot
  /** 展示用文案（如"后天"）；从路由 state 读不到就退回日期本身 */
  label: string
}

export function readPlanTarget(state: unknown): PlanTarget | null {
  if (typeof state !== 'object' || state === null) return null
  const plan = (state as { plan?: unknown }).plan
  if (typeof plan !== 'object' || plan === null) return null
  const { date, meal, label } = plan as { date?: unknown; meal?: unknown; label?: unknown }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (meal !== 'LUNCH' && meal !== 'DINNER') return null
  return { date, meal, label: typeof label === 'string' && label.trim() ? label.trim() : date }
}
