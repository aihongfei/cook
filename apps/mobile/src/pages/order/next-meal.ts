import type { MealSlot } from '@/api/orders'

/**
 * 默认选「下一餐」：下午 3 点前默认今天的晚饭，之后默认明天的午饭。
 *
 * 这条规则被两个入口共用——「想吃这道」抽屉（F3-01）与 AI 推荐里的「点这道」（D-026）——
 * 所以放在这里：两处各写一遍的话，改口径时必然漏掉一个，用户会遇到"同一个按钮落到不同的一餐"。
 *
 * days 是后端下发的可选日期（今天/明天/后天）。为空时（选项还没回来）返回空值，界面自然什么都不选；
 * 只有一天可选时退回那一天。**餐次与日期都由后端口径决定**，前端不硬编码能点哪几天。
 */
export function nextMealDefaults(days: { value: string; label: string }[]): { day: string; meal: MealSlot | null } {
  if (days.length === 0) return { day: '', meal: null }
  const tonight = new Date().getHours() < 15
  return tonight
    ? { day: days[0].value, meal: 'DINNER' }
    : { day: days[1]?.value ?? days[0].value, meal: 'LUNCH' }
}
