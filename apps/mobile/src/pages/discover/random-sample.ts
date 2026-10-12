/**
 * 从池子里随机取 n 个**不重复**的项（M16 / D-026 的示例提示用）。
 *
 * 为什么要随机：示例是**引导**，同一个问题看第三遍就变成墙纸，用户不会再读它；
 * 换着出还顺带让人知道这个入口能问多宽。
 *
 * 用 Fisher-Yates 洗**前 n 个**就停（不全洗）：省一点是一点，而且只取前 n 个时
 * 后段洗不洗对结果没有影响。
 *
 * `random` 可注入是为了测试能**确定地**验随机性（传 0 等于不洗牌、传 1 等于每次换到末尾），
 * 否则"随机"这件事在测试里只能靠概率断言——那种测试会偶发地红。
 */
export function sample<T>(pool: readonly T[], count: number, random: () => number = Math.random): T[] {
  const copy = [...pool]
  const limit = Math.min(count, copy.length)
  for (let i = 0; i < limit; i += 1) {
    // 夹在 [0, 剩余长度-1]：random() 理论上可能是 0 或（被桩成）1，
    // 越界会取到 undefined，那种脏数据到界面上就是一片空白
    const offset = Math.max(0, Math.min(Math.floor(random() * (copy.length - i)), copy.length - i - 1))
    const j = i + offset
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy.slice(0, limit)
}

/**
 * 从 [0, total) 里随机取一个下标；`total <= 0` 时返回 **-1**（"没有东西可挑"，让调用方自己决定怎么说）。
 *
 * 返回 -1 而不是抛异常：空库不是错误，是一个正常状态（"菜谱库还是空的"这种话由界面去说）。
 * 同样夹取上界——`random()` 被桩成 1 时 `Math.floor(1 * total)` 正好越界。
 */
export function randomIndex(total: number, random: () => number = Math.random): number {
  if (!Number.isFinite(total) || total <= 0) return -1
  return Math.max(0, Math.min(Math.floor(random() * total), total - 1))
}
