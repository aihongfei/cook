/**
 * 口味与健康档案的纯规则（M8 / F8-01、F8-02；用户的原始要求见 FEATURES 里的两条批注）。
 *
 * 这一块的全部难度在**判据的保守性**上，不在代码。四个刻意的取舍：
 *
 * ① **过敏与忌口看配料表，不看菜名**。菜名会骗人：「鱼香肉丝」里没有鱼、
 *    「蚂蚁上树」里没有蚂蚁、「老婆饼」里也没有老婆。按菜名匹配会把这两道菜
 *    对鱼过敏的人拦下来（白白少两道能吃的），而真正含鱼的菜又可能名字里不带"鱼"。
 *    配料表是唯一诚实的依据。
 *
 * ② **匹配只做子串包含，且一律照关键词原样去比**。不做同义词归并（"生抽"与"酱油"
 *    是不是一回事只有人知道）——与采购清单那边同一个理由：归并错了会让用户**漏掉一个
 *    真的过敏原**，那比"多提醒一次"严重得多。所以宁可误报：误报的代价是用户看一眼
 *    就能忽略，漏报的代价是有人进医院。
 *
 * ③ **"没说过"不等于"没限制"**。档案空白的成员**不参与过滤**，但界面上要明说
 *    "还有 N 人没写"——否则用户会以为全家都被护上了，而实际上只是他自己填了。
 *
 * ④ **口味标签（清淡/少盐/偏甜）与忌口不是一回事**：前者是"怎么做更好吃"，
 *    它是给模型的**偏好信号**，不做硬过滤（"少盐"没法在配料表里匹配——
 *    真去匹配"盐"会把"盐焗鸡"以外的所有放盐的菜全排掉）；后者是**食材级**的，
 *    才走配料表匹配。辣度单独走 `spiciness` 数值——但库里那份只有 0/1 两档
 *    （导入时"源站标了辣就记 1"，见 recipe-source.ts），所以**只能分出"辣/不辣"**，
 *    "微辣"与"重辣"在数据上不可分。这一点不假装：界面上按"不吃辣"过滤时才有效。
 */

import { BadRequestException } from '@nestjs/common'

/** 辣度档位。索引即档位，0 = 不吃辣 */
export const SPICY_LEVELS = ['不吃辣', '微辣', '中辣', '重辣'] as const
export type SpicyLevel = (typeof SPICY_LEVELS)[number]

/** 荤素倾向 */
export const DIET_OPTIONS = ['无偏好', '多吃素', '全素'] as const
export type DietOption = (typeof DIET_OPTIONS)[number]

/** 最多几条过敏原 / 忌口：再多用户自己都记不住，界面上也摊不开 */
export const TAGS_MAX = 12
/** 单个词的字符上限 */
export const TAG_LENGTH_MAX = 12
/** 口味标签最多几个 */
export const FLAVORS_MAX = 6
/** 备注上限 */
export const NOTE_MAX = 60

/**
 * 建议的过敏原（界面上点一下就填，不用手打）。
 *
 * 只列**常见的、词够具体**的那几样——写得太泛（如"海鲜"）会把所有水产都拦下来，
 * 而写得太窄（如"虾仁"）又会漏掉"虾皮"。用户也可以自己写。
 */
export const ALLERGY_SUGGESTIONS = [
  '花生', '坚果', '鸡蛋', '牛奶', '小麦', '大豆', '芝麻',
  '虾', '蟹', '贝类', '鱼', '芒果', '菠萝', '香菜', '芹菜',
] as const

/** 建议的忌口（不爱吃的东西，通常比过敏更随人） */
export const DISLIKE_SUGGESTIONS = [
  '香菜', '芹菜', '胡萝卜', '苦瓜', '洋葱', '青椒', '肥肉', '内脏', '折耳根', '皮蛋',
] as const

/** 建议的口味标签 */
export const FLAVOR_SUGGESTIONS = [
  '清淡', '少盐', '少油', '少糖', '偏甜', '偏酸', '重口', '爱喝汤', '不吃香菜',
] as const

/** 一条解析好的档案（**空白档案是合法的**：什么都没说过就是什么都没说过） */
export interface TasteProfile {
  spicyLevel: number | null
  flavors: string[]
  diet: DietOption | null
  allergies: string[]
  dislikes: string[]
  note: string | null
}

/** 界面上的档案（带成员信息，供"全家"那份用） */
export interface TasteProfileView extends TasteProfile {
  userId: string
  nickname: string
  avatar: string
  /** 这条档案改过没有：全空 = 还没说过（界面上要说"他还没写"） */
  filled: boolean
  updatedAt: string | null
}

/** 解析一个词表：去空白、去重（忽略大小写）、限长、限量 */
function parseTags(raw: unknown, label: string): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new BadRequestException(`${label}要写成一组词`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const text = typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : ''
    if (!text) continue
    if (text.length > TAG_LENGTH_MAX) {
      throw new BadRequestException(`${label}里「${text.slice(0, 6)}…」太长了，最多 ${TAG_LENGTH_MAX} 个字`)
    }
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length > TAGS_MAX) throw new BadRequestException(`${label}最多 ${TAGS_MAX} 条`)
  }
  return out
}

/** 解析辣度：可空（没说过就是 null，**不默认成"不吃辣"**——那会凭空替人排掉一堆菜） */
export function parseSpicyLevel(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === '不限' || raw === '都可以') return null
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(value) || value < 0 || value >= SPICY_LEVELS.length) {
    throw new BadRequestException(`辣度只能是 ${SPICY_LEVELS.join(' / ')}，或者留空表示不限`)
  }
  return value
}

/** 解析荤素倾向：可空 */
export function parseDiet(raw: unknown): DietOption | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (raw === '无偏好') return null
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!(DIET_OPTIONS as readonly string[]).includes(text)) {
    throw new BadRequestException(`荤素倾向只能是 ${DIET_OPTIONS.join(' / ')}`)
  }
  return text as DietOption
}

/**
 * 解析一份档案。
 *
 * **四个字段都能单独改**（`undefined` = 这次不动它，与菜谱 patch 同一个口径）：
 * 用户在设置页只改了"不吃香菜"，不该把辣度也一起冲掉。
 * 传空数组是**有意义的**（明确表示"这些都没有了"），与不传不是一回事。
 */
export function parseTasteProfile(raw: unknown): Partial<TasteProfile> {
  const body = (raw ?? {}) as Record<string, unknown>
  const out: Partial<TasteProfile> = {}

  if ('spicyLevel' in body) out.spicyLevel = parseSpicyLevel(body.spicyLevel)
  if ('diet' in body) out.diet = parseDiet(body.diet)
  if ('flavors' in body) {
    const flavors = parseTags(body.flavors, '口味偏好')
    if (flavors.length > FLAVORS_MAX) throw new BadRequestException(`口味偏好最多 ${FLAVORS_MAX} 条`)
    out.flavors = flavors
  }
  if ('allergies' in body) out.allergies = parseTags(body.allergies, '过敏')
  if ('dislikes' in body) out.dislikes = parseTags(body.dislikes, '忌口')
  if ('note' in body) {
    const text = typeof body.note === 'string' ? body.note.trim() : ''
    if (text.length > NOTE_MAX) throw new BadRequestException(`备注最多 ${NOTE_MAX} 个字`)
    out.note = text || null
  }

  if (Object.keys(out).length === 0) throw new BadRequestException('没有要改的内容')
  return out
}

/** 这份档案说没说过话（全空 = 还没写） */
export function isFilled(profile: TasteProfile): boolean {
  return profile.spicyLevel !== null
    || profile.diet !== null
    || profile.allergies.length > 0
    || profile.dislikes.length > 0
    || profile.flavors.length > 0
    || Boolean(profile.note)
}

/**
 * **名字里带它、其实不含它**的复合词（匹配前先挖掉）。
 *
 * 这一条是**真机验收抓出来的**，不是想出来的：对鱼过敏的人被「鱼香大虾」拦住了，
 * 而拦他的理由是配料里的「鱼香汁」——那是糖醋蒜姜调出来的味型，**没有鱼**。
 * 子串匹配在这里不是"偶尔误报"：鱼是最常见的过敏原之一，而鱼香菜是最常见的一类菜，
 * 于是这个人会**系统地**看不到一整类本该能吃的菜（比"偶尔误报"严重得多）。
 *
 * 做法是"先把这些词从被查文本里挖掉，再匹配"：
 * - 「鱼香汁」→ 挖掉「鱼香」→ 剩下"汁"，不再命中；
 * - 而同一道菜里真有一条「草鱼」时，它不受影响（挖的是"鱼香"这两个字）。
 *
 * ⚠️ 只收**有证据的**词：加一个进来要有"某道真实菜被它误伤"的实测。
 * 凭感觉补（"螃蟹味"之类）会把真阳性一起吃掉——那是漏报，后果比误报重。
 */
const DECEPTIVE_COMPOUNDS = ['鱼香']

/**
 * 一个词命中一段文本没有。
 *
 * **只看配料表，不看菜名**（见文件头 ①）。两边都做归一（去空白、小写）后子串包含：
 * 关键词"花生"命中"花生米"、"去皮花生"；关键词"虾"命中"虾仁"、"虾皮"。
 *
 * 单字关键词仍会误报（"牛"会命中"牛奶"），这是**刻意接受的**：见文件头 ②。
 * 界面上给的建议词都是两三个字的具体词，用户照着点就不会踩到。
 * 唯一例外的处理是 `DECEPTIVE_COMPOUNDS`（名字带它、其实不含它），见那里的说明。
 */
export function hitsKeyword(text: string, keyword: string): boolean {
  let hay = text.trim().toLowerCase()
  for (const compound of DECEPTIVE_COMPOUNDS) hay = hay.split(compound.toLowerCase()).join('')
  const needle = keyword.trim().toLowerCase()
  if (!hay || !needle) return false
  return hay.includes(needle)
}

/** 一道菜的配料名（去空）。判据只认这些，不认菜名 */
export function ingredientNames(ingredients: readonly { name: string }[]): string[] {
  return ingredients.map((item) => item.name.trim()).filter(Boolean)
}

/** 命中详情（要说清"是谁、因为什么词"——否则用户只看到"有不合适的菜"没法判断） */
export interface TasteHit {
  /** 谁的档案 */
  userId: string
  nickname: string
  /** 命中的词，如"花生" */
  keyword: string
  /** 命中的配料，如"花生米" */
  ingredient: string
  kind: 'allergy' | 'dislike'
}

export type TasteVerdict = 'ok' | 'warn' | 'block'

export interface TasteJudgement {
  verdict: TasteVerdict
  /** 过敏命中（硬拦：推荐里排除、点菜时明确警告） */
  blocked: TasteHit[]
  /** 忌口命中（软提醒） */
  warned: TasteHit[]
  /** 辣度不合（"谁不吃辣"+这道菜的辣度） */
  spicyConflict: { userId: string; nickname: string; level: number } | null
  /** 给界面/模型看的一句话（无事时为空串） */
  text: string
}

/** 判据要用的那道菜的最小形状 */
export interface TastyDish {
  name: string
  spiciness: number
  ingredients: readonly { name: string }[]
}

/**
 * 判一道菜合不合适这一家人。
 *
 * 三个层次的结论：
 * - `block`：有人**过敏**——推荐里排除，点菜时明确警告（不禁止：他自己的选择，
 *   但要说清是谁、因为哪样配料）；
 * - `warn`：有人**忌口**命中，或者**不吃辣**的人遇上了辣菜；
 * - `ok`：都没命中。
 *
 * **不过滤荤素倾向**（"多吃素"不是禁忌）：它不是"不能吃"，只是偏好，
 * 硬拦会把一整排肉菜从他的推荐里抽掉，而人是有权今天就想吃红烧肉的。
 * 荤素只作为**推荐提示词里的偏好**与排序偏置用（见 ai.service 的候选说明）。
 */
export function judgeDish(
  dish: TastyDish,
  profiles: readonly { userId: string; nickname: string; profile: TasteProfile }[],
): TasteJudgement {
  const names = ingredientNames(dish.ingredients)
  const blocked: TasteHit[] = []
  const warned: TasteHit[] = []
  let spicyConflict: TasteJudgement['spicyConflict'] = null

  for (const entry of profiles) {
    for (const keyword of entry.profile.allergies) {
      const hit = names.find((name) => hitsKeyword(name, keyword))
      // 同一个人同一道菜只报一次（他的过敏词可能有好几个都命中同一样配料）
      if (hit && !blocked.some((item) => item.userId === entry.userId)) {
        blocked.push({ userId: entry.userId, nickname: entry.nickname, keyword, ingredient: hit, kind: 'allergy' })
      }
    }
    for (const keyword of entry.profile.dislikes) {
      const hit = names.find((name) => hitsKeyword(name, keyword))
      if (hit && !warned.some((item) => item.userId === entry.userId)) {
        warned.push({ userId: entry.userId, nickname: entry.nickname, keyword, ingredient: hit, kind: 'dislike' })
      }
    }
    /*
     * 辣度：`spicyLevel` 是这个人**能接受到哪一档**。菜的 `spiciness` 只有 0/1，
     * 所以"不吃辣"(0) 遇上辣菜(1) 才冲突，"微辣及以上"一律放行——不假装能分清微辣与重辣
     * （见文件头 ④）。同一个人只取第一个冲突的人来提示。
     */
    if (!spicyConflict && entry.profile.spicyLevel !== null && dish.spiciness > entry.profile.spicyLevel) {
      spicyConflict = { userId: entry.userId, nickname: entry.nickname, level: entry.profile.spicyLevel }
    }
  }

  const verdict: TasteVerdict = blocked.length > 0 ? 'block' : warned.length > 0 || spicyConflict ? 'warn' : 'ok'
  return { verdict, blocked, warned, spicyConflict, text: judgeText(dish, { blocked, warned, spicyConflict }) }
}

/** 把判据翻成人话（点菜提醒与验收都直接用它，前端不自己拼） */
export function judgeText(
  dish: { name: string },
  judgement: Pick<TasteJudgement, 'blocked' | 'warned' | 'spicyConflict'>,
): string {
  const parts: string[] = []
  for (const hit of judgement.blocked) {
    parts.push(`${hit.nickname}对「${hit.keyword}」过敏，这道菜里有${hit.ingredient}`)
  }
  for (const hit of judgement.warned) {
    parts.push(`${hit.nickname}不吃${hit.keyword}（这道菜里有${hit.ingredient}）`)
  }
  if (judgement.spicyConflict) {
    parts.push(`${judgement.spicyConflict.nickname}吃不了辣`)
  }
  return parts.join('；')
}

/** 一个人对某道菜的判据（不吃辣的人自己点辣菜时用） */
export function judgementForOne(
  dish: TastyDish,
  one: { userId: string; nickname: string; profile: TasteProfile },
): TasteJudgement {
  return judgeDish(dish, [one])
}

/**
 * 谁的档案还是空的——界面上要明说（见文件头 ③）。
 *
 * 返回昵称列表而不是数字：用户看到"妈妈、爸爸还没写"才会去催，
 * 看到"还有 2 人没写"通常只会想"哦"。
 */
export function missingProfiles(
  members: readonly { userId: string; nickname: string; profile: TasteProfile | null }[],
): string[] {
  return members.filter((member) => !member.profile || !isFilled(member.profile)).map((member) => member.nickname)
}
