import { BadRequestException } from '@nestjs/common'
import type { MealSlot } from '@prisma/client'

/**
 * 「摇一桌」（F5-01）的纯规则：**按这一餐几个人吃，配一组菜**。
 *
 * ## 它和旁边的「摇一道」是什么关系
 *
 * F5-01 原来的形态是「摇一道」：随机取**库里一道**，落到详情页。它有两个毛病，
 * 用户没直接报，但都是真的：
 *
 * - **不知道几个人吃**：一家四口摇出来一道菜，用户还得自己再凑两三道——而这个按钮的
 *   意思本来是"这一餐你替我定了吧"；
 * - **不看忌口**（2026-10-14 核查发现的不一致）：写了"不吃辣"的人照样可能摇到辣菜，
 *   而「帮我决定」与首页推荐都已经过 `judgeDish` 硬拦。同一件事三种口径，必然有一个是错的。
 *
 * 现在升级成「摇一桌」：按人数配一桌（荤素汤尽量搭配）、过忌口、可整组加进某一餐；
 * 「摇一道」那条"只想随便看看一道菜"的路仍然保留——由抽屉里的「就它了」承担。
 *
 * ## 为什么道数由人数与餐次决定，而不是让用户填
 *
 * 用户心里想的是"今晚四个人吃"，不是"给我 3.5 道菜"。让他先算一遍人数再填道数，
 * 等于把决定权又推回去——而这个按钮的卖点正是"不用想"。
 * 反过来，直接问一句"几个人吃"是**他能立刻回答的问题**（而且这一餐本来就有就餐人数，
 * 见 `SPREAD_DINERS_DEFAULT` 那段）。
 *
 * 人数与道数的对应是**经验值**，不是算出来的：家常菜的搭配惯性就是
 * "两个菜够两人、四个菜够四到六人"，多一个人不至于加一道——加一道菜是多洗一个锅。
 * 所以档位是台阶状的（见 `dishCountFor`），而不是线性公式。
 */

/** 一餐最多配几道：再多就不是"配一桌"，是把整页菜谱端上来了 */
export const SPREAD_MAX_DISHES = 5

/** 用户没填人数、这一餐也没有已存人数时的默认值（两口之家是最常见的起点） */
export const SPREAD_DINERS_DEFAULT = 2

/** 人数的闸门：与就餐人数同口径（`DINER_COUNT_MAX`），免得两处能填的范围不一样 */
export const SPREAD_DINERS_MAX = 50

/**
 * 几个人吃 → 配几道菜。
 *
 * 台阶（而不是 `人数 / 2` 这类公式）的理由：**加一道菜对下厨的人是实打实的一份活**，
 * 而多来一个人通常只是在原有几道菜里多夹几筷子。所以：
 *
 * | 人数 | 午餐 | 晚餐 | 直觉 |
 * | --- | --- | --- | --- |
 * | 1 | 1 | 2 | 一个人午饭一个菜够了；晚饭多一道，剩了明天带 |
 * | 2 | 2 | 3 | 两口之家：一荤一素 / 再加一个汤 |
 * | 3～4 | 3 | 4 | 最常见的一桌 |
 * | 5～6 | 4 | 5 | 多加一道大菜或汤 |
 * | 7+ | 5 | 5 | 封顶 |
 *
 * 晚餐**始终不比午餐少**：晚饭是一天里最正式的一顿，这是普遍的家里习惯。
 */
export function dishCountFor(diners: number, meal: MealSlot): number {
  const base = diners <= 1 ? 1 : diners <= 2 ? 2 : diners <= 4 ? 3 : 4
  const withMeal = meal === 'DINNER' ? base + 1 : base
  return Math.min(SPREAD_MAX_DISHES, Math.max(1, withMeal))
}

/** 人数（可选，给了就校验）。返回 `null` 表示"没给"，由服务层决定回退到哪 */
export function parseSpreadDiners(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > SPREAD_DINERS_MAX) {
    throw new BadRequestException(`吃饭的人要在 1～${SPREAD_DINERS_MAX} 之间`)
  }
  return value
}

/**
 * 一桌菜里的一道候选（服务层填好，纯规则只负责搭配与排序）。
 *
 * 字段与 `DecideCandidate` 有重叠但**刻意不复用**：那个的 `have`/`missing`/`soon`
 * 是给"只给一道、理由要说透"用的，这里的每道菜只需要一句短理由——两者要的量不同，
 * 硬套成一个类型会让两边都长出用不上的字段。
 */
export interface SpreadCandidate {
  recipeId: string
  name: string
  /** 品类（荤菜/素菜/汤/主食…）：搭配就是按它凑的 */
  category: string
  /** 冰箱里能用上的哪几样（**按用户自己的说法**回显） */
  have: string[]
  /** 还差哪几样（不含调料） */
  missing: string[]
  /** 用上的食材里，有几样是"该先吃"的（已过期 / 三天内） */
  soon: string[]
  /** 家里做过几次（按"餐"去重） */
  cooked: number
  /** 最近一次做的日期；没做过为 null */
  lastCookedOn: string | null
}

/**
 * 排序：**先看"此刻真能做"，再看家人信号**。
 *
 * 与 `rankDecide` 同一条思路（分档而不是加权求和），但**档位少一档**：这里不区分
 * `ready`（一样都不缺）与 `near`（差一样）——一桌菜总会有一两道要顺路买的，
 * 把它们排到最后反而会凑不出搭配。所以只分三档：
 *
 * | 档 | 什么情况 |
 * | --- | --- |
 * | 冰箱凑得上（有 `have`） | 这一桌优先用家里现成的 |
 * | 家里做过/收着 | 至少是这家人吃的 |
 * | 其余 | 兜底 |
 *
 * 同档内：该先吃的 → 用上的多 → 做过次数 → 菜名 → id。
 * 最后两级是**确定顺序**用的（与 `rankPicks`/`rankDecide` 同一条规矩）：
 * 没有它们，同分项的顺序由数据库返回顺序决定，两次请求可能不一样，测试也没法稳定断言。
 */
export function rankSpread(rows: readonly SpreadCandidate[]): SpreadCandidate[] {
  const tier = (row: SpreadCandidate) => (row.have.length > 0 ? 0 : row.cooked > 0 ? 1 : 2)
  return [...rows]
    .map((row) => ({ row, name: row.name, recipeId: row.recipeId }))
    .sort(
      (a, b) =>
        tier(a.row) - tier(b.row) ||
        b.row.soon.length - a.row.soon.length ||
        b.row.have.length - a.row.have.length ||
        b.row.cooked - a.row.cooked ||
        a.name.localeCompare(b.name, 'zh') ||
        a.recipeId.localeCompare(b.recipeId),
    )
    .map((entry) => entry.row)
}

/**
 * 一桌菜的角色：**一荤一素一汤**是家常搭配最普遍的形状。
 *
 * 为什么只有这三档而不是"照菜谱品类一一对应"：品类在库里是自由文本（612 道里
 * 有"家常"这种不是品类的值、还有自建菜谱写什么都有），按它做严格的槽位匹配会经常填不满。
 * 所以这里只认三种**大概率能认出来**的角色，认不出的归 `other` 随便补位。
 */
export type SpreadRole = 'meat' | 'veg' | 'soup' | 'other'

/**
 * 角色在界面上的说法（**由后端下发**：与 `mealLabel` / `statusLabel` / `sourceLabel` 同一条规矩，
 * 前端只负责渲染，不自己维护第二份中英对照）。
 *
 * `other` 叫「另配」而不是「其他」：它是"没认出来的那道菜，但也进了这一桌"，
 * 用户扫过去看到的是自己家的一桌菜，不是一份分类表。
 */
export const ROLE_LABEL: Record<SpreadRole, string> = {
  meat: '荤菜',
  veg: '素菜',
  soup: '汤',
  other: '另配',
}

/** 菜名或品类里出现这些字就当作汤（库里"汤"是品类，但也有把汤归在"家常"里的） */
const SOUP_HINT = /汤|羹|粥|煲/
const MEAT_HINT = /荤|肉|鸡|鸭|鱼|虾|蟹|排骨|牛|羊|猪/
const VEG_HINT = /素|菜|蔬|瓜|豆|菌|菇/

export function roleOf(candidate: Pick<SpreadCandidate, 'category' | 'name'>): SpreadRole {
  const text = `${candidate.category} ${candidate.name}`
  // 汤优先：一道"豆腐鲫鱼汤"既像荤又像汤，但它在桌上的位置是汤
  if (SOUP_HINT.test(text)) return 'soup'
  if (MEAT_HINT.test(text)) return 'meat'
  if (VEG_HINT.test(text)) return 'veg'
  return 'other'
}

/**
 * 排好序的一桌：**先按搭配槽位凑，凑不满再用剩下的按序补**。
 *
 * 三条刻意的：
 * - **不因为"分类不认识"就不摇**：`other` 只是排最后，不会被丢掉。库里大部分菜都能
 *   落进三档之一，但真遇到一道认不出的菜时，让它参与总比整桌少一道好；
 * - **槽位顺序是 荤 → 素 → 汤 → 其他**：人多时先保证有肉（那是这一餐的主体），
 *   汤放最后是因为"没有汤也能吃"，而"没有肉"用户会直接问"这算什么晚饭"；
 * - **同一道菜只出现一次**（按 recipeId 去重），这是"配一桌"最基本的正确性。
 */
export function pickSpread(
  ranked: readonly SpreadCandidate[],
  count: number,
  random: () => number = Math.random,
): SpreadCandidate[] {
  const limit = Math.min(Math.max(0, Math.floor(count)), ranked.length)
  if (limit === 0) return []

  const used = new Set<string>()
  const taken: SpreadCandidate[] = []

  /*
   * 每个槽位内部**也在候选里抽**（而不是永远取该类第一名）：
   * 不抽的话，同一家人连点两次「摇一桌」，荤菜永远是那道排第一的——又变成"固定那几样"。
   * 抽的范围比 `pickRecommendations` 窄（这里只抽前几名），因为一桌菜要的是**搭配合理**，
   * 不是"从一大池里换花样"。
   */
  for (const role of ['meat', 'veg', 'soup', 'other'] as const) {
    if (taken.length >= limit) break
    const bucket = ranked.filter((row) => !used.has(row.recipeId) && roleOf(row) === role)
    if (bucket.length === 0) continue
    const pick = sampleFrom(bucket, ROLE_WINDOW, random)[0]
    if (!pick) continue
    used.add(pick.recipeId)
    taken.push(pick)
  }

  /*
   * 槽位凑不满（比如库里没汤）：剩下的按原顺序补，**不重排**——排序已经在排序层做过了。
   *
   * `other` 槽位之外补进来的菜**要避开已经占过的角色**（`fresh` 优先）：
   * 不避的话，6 人一桌可能补进来第二道汤（`meat/veg/soup` 各一道之后，按序补的第一道恰好是汤）。
   *
   * 真到了"剩下的全是重复角色"（库里品类就那几样）时，**按角色给重复项排序**：
   * 两道肉很家常（一个红烧一个清蒸），**两道汤最怪**——所以肉 > 素 > 其他 > 汤。
   * 这一步只是排序，不改变"给够道数"这件事。
   */
  const roleCount = new Map<SpreadRole, number>()
  for (const row of taken) roleCount.set(roleOf(row), (roleCount.get(roleOf(row)) ?? 0) + 1)
  const fresh: SpreadCandidate[] = []
  const duplicates: SpreadCandidate[] = []
  for (const row of ranked) {
    if (used.has(row.recipeId)) continue
    if ((roleCount.get(roleOf(row)) ?? 0) > 0) duplicates.push(row)
    else fresh.push(row)
  }
  duplicates.sort((a, b) => DUPLICATE_ORDER[roleOf(a)] - DUPLICATE_ORDER[roleOf(b)])
  for (const row of [...fresh, ...duplicates]) {
    if (taken.length >= limit) break
    if (used.has(row.recipeId)) continue
    used.add(row.recipeId)
    taken.push(row)
  }
  return taken
}

/**
 * 重复角色之间的优先级：**肉 > 素 > 其他 > 汤**。
 *
 * 只用在"剩下的全是重复角色"那一步（见 `pickSpread`）：库里品类齐的时候走的是 `fresh` 那支，
 * 这张表根本用不上。两道肉很家常，**两道汤最怪**。
 */
const DUPLICATE_ORDER: Record<SpreadRole, number> = { meat: 0, veg: 1, other: 2, soup: 3 }

/**
 * 每个角色从候选里抽的范围：**前 6 名**。
 *
 * 比 `PICK_WINDOW`（5）略宽、比 `recommend` 的池子（3 倍）窄——一桌菜的荤菜只有一道，
 * 抽太宽就会把"冰箱里正好能做"换成"差三样"，而用户是点了按钮就准备去做饭的人。
 */
export const ROLE_WINDOW = 6

/** 在候选里抽一个（复用 `recommend.rules` 的手法是刻意的：同一套抽样语义，别处已验过） */
function sampleFrom(pool: readonly SpreadCandidate[], window: number, random: () => number): SpreadCandidate[] {
  const limit = Math.min(window, pool.length)
  if (limit === 0) return []
  const index = Math.max(0, Math.min(Math.floor(random() * limit), limit - 1))
  return [pool[index]]
}

/** 一道菜那一句短理由（后端拼，前端只照搬——与 `decideReason` 同一条规矩） */
export function spreadReason(candidate: SpreadCandidate): string {
  const parts: string[] = []
  if (candidate.have.length > 0 && candidate.missing.length === 0) {
    const names = candidate.have.slice(0, 2)
    parts.push(`冰箱里的 ${names.join('、')} 正好能做`)
  } else if (candidate.missing.length > 0) {
    parts.push(`要买 ${candidate.missing.slice(0, 2).join('、')}`)
  }
  if (candidate.cooked > 0) parts.push(`做过 ${candidate.cooked} 次`)
  // 一句真事都没有时不编：留空，界面只显示菜名与品类
  return parts.join(' · ')
}

/**
 * 整桌的一句话（抽屉头部那句）：**说清几个人、配了几道**。
 *
 * 为什么由后端拼：与采购清单那句同一条规矩（D-059 四）——这类句子两边各拼一遍必然漂移，
 * 而"我按几个人配的"正是用户用来判断要不要信这一桌的依据。
 * `dinersFromMeal === false` 时要说清这是**默认值**：用户没填过人数，
 * 我们按两口之家配的，他可以说一句"其实六个"再摇。
 */
export function spreadSummary(diners: number, count: number, fromMeal: boolean): string {
  const who = fromMeal ? `${diners} 个人吃` : `按 ${diners} 个人算`
  return `${who}，配了 ${count} 道`
}
