import { BadRequestException } from '@nestjs/common'
import { COOKED_WEIGHT, FAVORITE_WEIGHT } from './discover.rules'

/**
 * 首页「菜谱推荐」的纯规则（用户 2026-10-14 报的第三件事）。
 *
 * 用户的原话：「**首页的菜谱推荐现在固定那几样了，能不能随机一些呢，根据个人习惯、口味等进行推荐**」。
 *
 * 原来那一块直接调 `GET /recipes`（按 `name ASC` 的第 1 页、取前 6 条），
 * 所以**每天每次进首页都是同样六道**——用户说"固定那几样"是准确的描述，
 * 不是错觉（详见 D-071）。
 *
 * 与「家人最爱」（`rankPicks`，按分数排出**名次**）和「帮我决定」（`pickOne`，最高分里抽**一道**）
 * 都不同：这一块要的是**一屏几道、每次不同、但仍然像他家的口味**——所以
 * "分数决定**候选池**，池子里随机取"是这一块的形状。三者共用同一套信号与权重
 * （`COOKED_WEIGHT` / `FAVORITE_WEIGHT`），不各定一套。
 */

/** 一屏给几道（首页那一行横向滑，超过这个数没人滑到最后） */
export const RECOMMEND_COUNT_DEFAULT = 6
export const RECOMMEND_COUNT_MAX = 18

/**
 * 候选池是"要几道"的几倍。
 *
 * 1 倍 = 没有随机余地（每次都一样，就是原来那个毛病）；全库随机 = 与口味无关。
 * 3 倍是个折中：6 道时池子里 18 道，够换样子，又都还在"他家会吃"的范围内。
 */
export const POOL_FACTOR = 3

/**
 * 多久之内做过的往后放。
 *
 * 反复推同一道家常菜是这一块最容易犯的错——用户刚做过，点开首页又看见它排第一，
 * 会觉得"这推荐没用"。**只是往后放、不是排除**：家里就爱吃这几道时，
 * 池子本来就小，排掉它们会把推荐变成"没做过但也不想吃"的菜。
 */
export const RECENT_DAYS = 7

/** 一页要几道（可选，给了就校验） */
export function parseRecommendCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return RECOMMEND_COUNT_DEFAULT
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > RECOMMEND_COUNT_MAX) {
    throw new BadRequestException(`推荐要在 1～${RECOMMEND_COUNT_MAX} 道之间`)
  }
  return value
}

/** 一道候选菜带着它的信号（由 service 填，`spice` 与"是否刚做过"也已判好） */
export interface RecommendCandidate {
  id: string
  /** 做过几次（不同的餐） */
  cooked: number
  /** 几个人收着（family 口径）或我收着（0/1） */
  favorites: number
  /** 最近一次做的日期；没做过为 null */
  lastCookedOn: string | null
  /**
   * 冰箱里"能凑上"的程度：有临期的或能凑齐的料 → 高。
   *
   * 它**加进分数但不主导**：一道家里没做过、冰箱里正好有临期菜的菜，
   * 值得排在"做过很多次但今天料不齐"的前面——那正是"今天就能做"的意思。
   */
  ready: number
}

export interface RecommendScore extends RecommendCandidate {
  score: number
}

/**
 * 打分并排序。**同分给确定顺序**（与 `rankPicks` 同一条规矩）：
 * 没有这一层，同分项的顺序由数据库返回顺序决定，同一份数据两次请求可能不一样，
 * 测试也就无法稳定断言。
 */
export function scoreCandidates(candidates: readonly RecommendCandidate[]): RecommendScore[] {
  return [...candidates]
    .map((row) => ({
      ...row,
      score: row.cooked * COOKED_WEIGHT + row.favorites * FAVORITE_WEIGHT + row.ready,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.cooked - a.cooked ||
        b.favorites - a.favorites ||
        a.id.localeCompare(b.id),
    )
}

/**
 * 从排好序的候选里取 `count` 道，**在分数靠前的那一池里随机**。
 *
 * 两件事刻意的：
 * - **只在池子里随机，不整表随机**：整表随机等于「摇一道」，与"根据个人习惯、口味"相悖。
 *   这一块的承诺是"像你家会吃的"，只不过不再每次一样；
 * - **"刚做过的"已经在排序里靠后**（由 `preferFresh` 那一类先做），所以
 *   池子（前 `count * POOL_FACTOR` 名）天然避开最近做过的——除非可选的本来就少。
 */
export function pickRecommendations(
  ranked: readonly RecommendScore[],
  count: number,
  random: () => number = Math.random,
): RecommendScore[] {
  const limit = Math.min(Math.max(0, Math.floor(count)), ranked.length)
  if (limit === 0) return []
  const poolSize = Math.min(ranked.length, Math.max(limit, limit * POOL_FACTOR))
  const pool = ranked.slice(0, poolSize)
  return sample(pool, limit, random)
}

/**
 * 不放回地抽 `count` 个（Fisher-Yates 的前 `count` 步）。
 *
 * 与 `ai.rules` 的 `sampleList` 同一个手法（那里给模型抽候选），
 * 但**刻意不 import 它**：那是 AI 模块的规则，首页推荐依赖 AI 模块会绕出一个
 * 与"推荐不调 AI"相冲突的依赖（D-071）。这段只有十来行，重复比耦合划算。
 */
export function sample<T>(list: readonly T[], count: number, random: () => number = Math.random): T[] {
  const copy = [...list]
  const limit = Math.min(Math.max(0, Math.floor(count)), copy.length)
  for (let i = 0; i < limit; i += 1) {
    // 夹在 [0, 剩余长度-1]：random() 理论上可能是 0 或（被桩成）1，越界会取到 undefined
    const offset = Math.max(0, Math.min(Math.floor(random() * (copy.length - i)), copy.length - i - 1))
    const j = i + offset
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy.slice(0, limit)
}

/**
 * 池子里凑不够时，用"没信号的"补到 `count`。
 *
 * 为什么要有这一支：新家庭一道菜都没做过、一个收藏也没有，`scoreCandidates` 的结果
 * 全是 0 分（都并列）。那时若直接取前 `count` 个，又会**按 id 排出固定的一屏**——
 * 正是用户报的那个毛病换了个地方复现。所以补位这一段也必须随机。
 *
 * 补位**排在个性化结果之后**：分数 > 0 的先上，0 分的填满剩下的位置。
 */
export function fillWithExtras(
  chosen: readonly RecommendScore[],
  others: readonly RecommendScore[],
  count: number,
  random: () => number = Math.random,
): RecommendScore[] {
  const taken = new Set(chosen.map((row) => row.id))
  const rest = others.filter((row) => !taken.has(row.id))
  const need = Math.max(0, Math.floor(count) - chosen.length)
  if (need === 0) return [...chosen]
  return [...chosen, ...sample(rest, need, random)]
}
