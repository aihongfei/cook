import { BadRequestException } from '@nestjs/common'
import { RecipeQuery } from './recipe.types'

/**
 * 一次能给几个标签：**给的是"其中一个命中"（并集）**，不是交集。
 *
 * 上限不是为了性能（几百道菜的表扫得起），是为了**别让 URL 变成一个查询语言**：
 * 界面上的入口最多同时用 4 个（一个季节的几种叫法），给到 5 就够，再多说明调用方在拿它拼业务。
 */
export const QUERY_TAGS_MAX = 5

/** 单个标签的长短上限：库里最长的是「夏季菜谱」这类 4 个字，10 与写菜谱时那一套同源 */
export const QUERY_TAG_MAX = 10

/**
 * `tag=秋季,秋季菜谱`：按**标签精确命中**（可给多个，命中其中一个就算）。
 *
 * 为什么要有这个参数，而不是让调用方用 `q` 搜：`q` 走的是 `searchText contains`
 * （菜名 + 别名 + 标签 + 食材名拼一起），**命中的是"文本里出现过这两个字"**，
 * 而这里要的是"打了这个标签"。
 *
 * ⚠️ 一个必须说清的事实：**2026-10-16 实测，四个季节的搜索结果与标签并集恰好完全一致**
 * （春 21 / 夏 81 / 秋 38 / 冬 50，逐个 id 比过，一个不差）。也就是说这一条**现在看不出差别**。
 * 它仍然是必需的，理由是判据不同而不是眼下有差：
 * ① 搜索会命中菜名与食材名——库里哪天出现一道名字里带"夏"的凉糕而没打季节标签，
 *    它就会混进「夏日时令」那个数字里；
 * ② 反过来，一道打了「秋季养生」却名字里没有秋的菜（现在有 3 道：猪肉萝卜灌汤包、
 *    红枣发糕、花生红枣焖猪手），**只靠搜索是找不到的**——它们正是 `tag` 必须支持
 *    多个标签的原因（见下面 tagList）；
 * ③ 界面上那个数字（「秋日时令 · 38 道」）是用户拿来判断"值不值得点进去"的，
 *    它只能由"标签"这个稳定判据给出，不能由"今天恰好对得上"给出。
 *
 * 多个标签是**并集**而不是交集，这一条差得**很大**（2026-10-16 实测）：
 * 只取最正的那个标签 vs 并集 —— 春 20→21、夏 **51→81**、秋 35→38、冬 47→50。
 * 夏天少掉 30 道不是小数：那块写着"夏日时令 · 51 道"，而库里明明有 81 道应季的。
 * 交集在这里没有任何用法。
 */
function tagList(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new BadRequestException('tag must be a comma-separated string')
  const tags = raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
  if (tags.length === 0) return undefined
  if (tags.length > QUERY_TAGS_MAX) throw new BadRequestException(`tag 最多 ${QUERY_TAGS_MAX} 个`)
  for (const tag of tags) {
    if (tag.length > QUERY_TAG_MAX) throw new BadRequestException(`单个 tag 最多 ${QUERY_TAG_MAX} 个字符`)
  }
  // 去重：同一个标签给两遍不该变成两个 AND 条件（也会让"最多 5 个"变成假上限）
  return [...new Set(tags)]
}

export function parseRecipeQuery(query: Record<string, unknown>): RecipeQuery {
  /*
   * `mine=1`：只看自己家传的（F1-12 的「我的菜谱」入口用）。
   * 它是个**筛选开关而不是权限**——登录了才有"我的"，未登录时它匹配不到任何东西
   * （自建菜谱都挂在某个家庭上），所以不必额外报错。
   */
  const allowed = new Set(['q', 'category', 'cuisine', 'tag', 'page', 'pageSize', 'mine'])
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw new BadRequestException(`Unknown query parameter: ${key}`)
  function text(key: string): string | undefined {
    const value = query[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length > 100) throw new BadRequestException(`${key} must be a string of at most 100 characters`)
    return value.trim() || undefined
  }
  function integer(key: string, fallback: number, max: number): number {
    const value = query[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new BadRequestException(`${key} must be an integer from 1 to ${max}`)
    return Number(value)
  }
  function flag(key: string): boolean {
    const value = query[key]
    if (value === undefined) return false
    if (value !== '1' && value !== 'true') throw new BadRequestException(`${key} 只接受 1`)
    return true
  }
  return { q: text('q'), category: text('category'), cuisine: text('cuisine'), tags: tagList(query.tag), page: integer('page', 1, 10000), pageSize: integer('pageSize', 12, 100), mine: flag('mine') }
}
