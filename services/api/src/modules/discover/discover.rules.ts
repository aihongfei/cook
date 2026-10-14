import { BadRequestException } from '@nestjs/common'

/**
 * 家人最爱 / 家人常点（M5 / F5-02）的纯规则。口径见 D-038。
 *
 * 与其他 `*.rules.ts` 同一套路：**不碰数据库的判定都放这里**，单测直接验。
 *
 * 这块要回答的问题是"这一家子最爱吃什么"，而"最爱"只能从两件已经发生过的事里看出来：
 * **做过**（点单被推到"已做好"）与**收藏**（有人把那道菜收进自己的收藏）。
 * 两个信号怎么合、按什么排、什么不算数，全在这里定死。
 */

/**
 * 做过一次算几分、被一个人收藏算几分。
 *
 * 做一次重得多：要选、要买、要下厨、要吃完——收藏只是一下点击。
 * 所以 **做过 = 2 分、收藏 = 1 分**：一道做过两次的菜（4 分）稳稳压过被三个人收藏
 * 但一次没做过的菜（3 分）。若反过来（收藏更重），榜单会被"顺手点过的"占满，
 * 而这家人的实际口味（真吃什么）看不出来。
 *
 * 这是**产品取舍**，不是算出来的：数值写在这里是为了让"为什么它排在前面"可以解释，
 * 也方便用户否决后一处改掉。
 */
export const COOKED_WEIGHT = 2
export const FAVORITE_WEIGHT = 1

/** 一屏给多少道：榜单是要"扫一眼就决定"，超过十来行就变成又一个菜谱列表了 */
export const PICKS_LIMIT_DEFAULT = 8
export const PICKS_LIMIT_MAX = 24

/** 一次"做过"：某一餐里有这道菜（F5-02 只认已做好的餐） */
export interface CookedRow {
  recipeId: string
  /** 那一餐的 id —— **按"餐"计次，不按"份"**：同一餐里两个人各点一份只算做过一次 */
  mealOrderId: string
  /** 那一餐的日期（`YYYY-MM-DD`）——同格式的日期串排序等价于日期排序 */
  cookedOn: string
}

/** 一次收藏：谁收了哪道菜（`Favorite` 上 (userId, recipeId) 唯一，所以一行 = 一个人） */
export interface FavoriteRow {
  recipeId: string
  userId: string
}

export interface PickScore {
  recipeId: string
  /** 做过几次（不同的餐） */
  cooked: number
  /** 喜欢数：family 口径 = 家里几个人收着；mine 口径 = 我收着（0/1） */
  favorites: number
  score: number
  /** 最近一次做的日期，没做过为 null */
  lastCookedOn: string | null
}

/** 一页要几道（可选，给了就校验） */
export function parsePicksLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return PICKS_LIMIT_DEFAULT
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > PICKS_LIMIT_MAX) {
    throw new BadRequestException(`一页要在 1～${PICKS_LIMIT_MAX} 道之间`)
  }
  return value
}

/**
 * 数"做过几次"：**去重到餐**，并记下最近那一餐。
 *
 * 不去重就会出现"这道菜做过 5 次"其实是"一餐里五个人各点了一份"——家里人口越多，
 * 同一道菜的数字越大，榜单会变成"点的人多"而不是"做得多"。这与卡片合并（D-029）是同一个道理：
 * 一餐里同一道菜是**一件事**，不是几件事。
 */
export function countCooked(
  rows: readonly CookedRow[],
): Map<string, { cooked: number; lastCookedOn: string | null }> {
  const meals = new Map<string, Set<string>>()
  const last = new Map<string, string>()
  for (const row of rows) {
    const seen = meals.get(row.recipeId) ?? new Set<string>()
    seen.add(row.mealOrderId)
    meals.set(row.recipeId, seen)
    const previous = last.get(row.recipeId)
    if (!previous || row.cookedOn > previous) last.set(row.recipeId, row.cookedOn)
  }
  return new Map(
    [...meals].map(([recipeId, seen]) => [
      recipeId,
      { cooked: seen.size, lastCookedOn: last.get(recipeId) ?? null },
    ]),
  )
}

export function countFavorites(rows: readonly FavoriteRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.recipeId, (counts.get(row.recipeId) ?? 0) + 1)
  return counts
}

/**
 * 合成分数并排序。
 *
 * 三件事刻意的：
 * - **只留有信号的**（做过或收藏过）：库里 600 道没信号的菜全是 0 分，放进来等于随机推荐，
 *   而这一块的承诺是"你家的口味"，宁可不给也不能拿无关的菜凑数；
 * - **同分给确定顺序**（做过 → 收藏 → recipeId）：没有这一层，同分项的顺序由数据库返回顺序决定，
 *   同一份数据两次请求可能不一样，界面看着像在跳；测试也无法稳定断言；
 * - **不设"最少做过几次"的门槛**：新家庭只有一次记录时，那一道就是它家的最爱——
 *   硬要凑够次数才显示，等于对刚用起来的家庭说"你还不够格看这个"。
 */
export function rankPicks(
  cooked: ReadonlyMap<string, { cooked: number; lastCookedOn: string | null }>,
  favorites: ReadonlyMap<string, number>,
): PickScore[] {
  const ids = new Set([...cooked.keys(), ...favorites.keys()])
  return [...ids]
    .map((recipeId) => {
      const cookedTimes = cooked.get(recipeId)?.cooked ?? 0
      const favoriteCount = favorites.get(recipeId) ?? 0
      return {
        recipeId,
        cooked: cookedTimes,
        favorites: favoriteCount,
        score: cookedTimes * COOKED_WEIGHT + favoriteCount * FAVORITE_WEIGHT,
        lastCookedOn: cooked.get(recipeId)?.lastCookedOn ?? null,
      }
    })
    .filter((pick) => pick.cooked > 0 || pick.favorites > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.cooked - a.cooked ||
        b.favorites - a.favorites ||
        a.recipeId.localeCompare(b.recipeId),
    )
}

/**
 * 「我做过」那行字（M9 / F9-01，D-075）：**做过 N 次 · 最近 …**。
 *
 * **由后端拼**，与采购清单那句 `stockLabel`、冰箱的 `addedLabel` 同一条规矩（D-059 四）：
 * 这类句子前端各拼一遍必然漂移，而"我到底做过几次"是用户会拿来当事实读的一句话。
 *
 * 日期的说法**复用冰箱那套相对日期的口径**（今天 / 昨天 / N 天前 / 更早 / 具体月日）：
 * 用户判断"上次做是什么时候"用的是日历，不是秒表。三档以上就直给月日——
 * "13 天前"要用户自己再算一遍，不如写 `10-02` 一眼就对得上日历。
 *
 * `lastCookedOn` 为空（理论上不会：有记录才有这一行）时只说次数，不编一个日期。
 */
export function cookedLabel(cooked: number, lastCookedOn: string | null, today: string): string {
  const times = `做过 ${cooked} 次`
  if (!lastCookedOn) return times
  return `${times} · 最近 ${recentDayLabel(lastCookedOn, today)}`
}

/** 相对日期的说法（`YYYY-MM-DD` 进、给人看的话出） */
export function recentDayLabel(dayKey: string, today: string): string {
  const days = daysBetween(dayKey, today)
  if (days === null) return dayKey // 日期串坏掉时如实回原文，不编"今天"（那是假的）
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days === 2) return '前天'
  if (days <= 6) return `${days} 天前`
  /*
   * 一周以上写 `10-02`：`13 天前` 要用户自己再算一遍，而月日一眼就对得上日历。
   * 跨年时补上年份（`2025-12-30` → `2025-12-30`）——不补的话"12-30"到底是哪个冬天说不清。
   */
  const [year, month, day] = dayKey.split('-')
  return year === today.slice(0, 4) ? `${month}-${day}` : dayKey
}

/** 两个 `YYYY-MM-DD` 相差几个日历日（后者减前者）；日期串不合规时返回 null */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86_400_000)
}
