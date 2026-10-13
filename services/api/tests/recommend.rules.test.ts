import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  POOL_FACTOR,
  RECOMMEND_COUNT_DEFAULT,
  fillWithExtras,
  parseRecommendCount,
  pickRecommendations,
  sample,
  scoreCandidates,
  type RecommendCandidate,
} from '../src/modules/discover/recommend.rules'

/**
 * 首页「菜谱推荐」的纯规则单测（用户 2026-10-14：「现在固定那几样了，能不能随机一些呢，
 * 根据个人习惯、口味等进行推荐」）。口径见 D-071。
 *
 * 要盯住的四件事：
 * ① 有信号的往前排（做过 > 收藏 ≈ 临期 > 没信号）；
 * ② **每次取的不完全一样**——这一条正是用户报的那个毛病，必须钉死；
 * ③ 但也不能随机到"库里随便几道"：只在**分数靠前的那一池**里抽；
 * ④ 新家庭（全部 0 分并列）也得随机，不能又退化成"永远同样六道"。
 */

/** 造一道候选：默认没做过、没人收藏、冰箱里凑不上 */
function candidate(id: string, over: Partial<RecommendCandidate> = {}): RecommendCandidate {
  return { id, cooked: 0, favorites: 0, lastCookedOn: null, ready: 0, ...over }
}

/** 固定序列的伪随机：随机那几条要能复现才验得下去 */
function seq(values: number[]): () => number {
  let index = 0
  return () => values[index++ % values.length]
}

describe('打分与排序', () => {
  it('做过与收藏都加分，做过的权重更高', () => {
    const ranked = scoreCandidates([
      candidate('没做过'),
      candidate('收藏过', { favorites: 1 }),
      candidate('做过一次', { cooked: 1 }),
    ])
    assert.deepEqual(ranked.map((row) => row.id), ['做过一次', '收藏过', '没做过'])
  })

  it('冰箱里正好有临期的加 1 分，但压不过"做过"', () => {
    const ranked = scoreCandidates([
      candidate('临期的', { ready: 1 }),
      candidate('做过一次', { cooked: 1 }),
      candidate('没信号'),
    ])
    // 临期(1) 与 收藏(1) 同档，比做过(2) 轻——那个位置是刻意的（"今天就能做"的强信号，
    // 但不该盖过"他家常做这道"）
    assert.deepEqual(ranked.map((row) => row.id), ['做过一次', '临期的', '没信号'])
  })

  it('同分给确定顺序（id 兜底）：同一份数据两次请求结果一致', () => {
    const once = scoreCandidates([candidate('b'), candidate('a'), candidate('c')])
    const twice = scoreCandidates([candidate('c'), candidate('a'), candidate('b')])
    assert.deepEqual(once.map((row) => row.id), ['a', 'b', 'c'])
    assert.deepEqual(twice.map((row) => row.id), once.map((row) => row.id))
  })
})

describe('在靠前的那一池里随机', () => {
  it('不同的随机数取到不同的几道（这就是用户要的"随机一些"）', () => {
    const ranked = scoreCandidates(Array.from({ length: 30 }, (_, index) => candidate(`r${index}`)))
    const first = pickRecommendations(ranked, 6, seq([0])).map((row) => row.id)
    const second = pickRecommendations(ranked, 6, seq([0.9])).map((row) => row.id)
    assert.notDeepEqual(first, second)
  })

  it('但**只在靠前的那一池里**取，不会捞到库里最冷门的', () => {
    // 前 20 道有信号、后面 100 道 0 分：取 6 道（池子 = 18）时一个都不该越界
    const hot = Array.from({ length: 20 }, (_, index) => candidate(`hot${index}`, { cooked: 3 }))
    const cold = Array.from({ length: 100 }, (_, index) => candidate(`cold${index}`))
    const ranked = scoreCandidates([...hot, ...cold])
    const pool = new Set(ranked.slice(0, 6 * POOL_FACTOR).map((row) => row.id))
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      for (const row of pickRecommendations(ranked, 6, seq([roll]))) {
        assert.ok(pool.has(row.id), `${row.id} 不该出现在池子里`)
      }
    }
  })

  it('库里比要的还少时全给出来，不重复也不报错', () => {
    const ranked = scoreCandidates([candidate('a'), candidate('b')])
    assert.deepEqual(pickRecommendations(ranked, 6).map((row) => row.id).sort(), ['a', 'b'])
    assert.deepEqual(pickRecommendations([], 6), [])
  })

  it('抽到的每一道都不重复（不放回）', () => {
    const ranked = scoreCandidates(Array.from({ length: 12 }, (_, index) => candidate(`r${index}`)))
    for (const roll of [0, 0.3, 0.7, 0.99]) {
      const ids = pickRecommendations(ranked, 6, seq([roll])).map((row) => row.id)
      assert.equal(new Set(ids).size, ids.length)
    }
  })
})

describe('0 分的那一大堆也要随机（新家庭不能又变成固定六道）', () => {
  it('个性化结果不够时用 0 分的补，且补位也是随机的', () => {
    /*
     * 新家庭一道没做过、一个收藏也没有：全部 0 分并列。
     * 若按 id 取前几个，用户看到的又是**永远同样六道**——正是他报的那个毛病换了个地方复现。
     */
    const ranked = scoreCandidates(
      Array.from({ length: 30 }, (_, index) => candidate(`r${String(index).padStart(2, '0')}`)),
    )
    const first = fillWithExtras([], ranked, 6, seq([0])).map((row) => row.id)
    const second = fillWithExtras([], ranked, 6, seq([0.9])).map((row) => row.id)
    assert.notDeepEqual(first, second)
    assert.equal(first.length, 6)
    assert.equal(second.length, 6)
  })

  it('个性化的那几道**一定排在补位前面**（不能让 0 分的挤掉有信号的）', () => {
    const ranked = scoreCandidates([
      candidate('最爱', { cooked: 5 }),
      candidate('次爱', { cooked: 2 }),
      ...Array.from({ length: 10 }, (_, index) => candidate(`z${index}`)),
    ])
    const picked = pickRecommendations(ranked, 2, seq([0]))
    const filled = fillWithExtras(picked, ranked, 6, seq([0.5]))
    assert.deepEqual(filled.slice(0, 2).map((row) => row.id), ['最爱', '次爱'])
    assert.equal(filled.length, 6)
  })

  it('已经取够时一个都不补', () => {
    const ranked = scoreCandidates([candidate('a'), candidate('b')])
    assert.equal(fillWithExtras(ranked, ranked, 2).length, 2)
  })

  it('补位不会把已经选中的再拿一遍', () => {
    const ranked = scoreCandidates(Array.from({ length: 8 }, (_, index) => candidate(`r${index}`)))
    const picked = pickRecommendations(ranked, 4, seq([0]))
    const filled = fillWithExtras(picked, ranked, 6, seq([0.5]))
    assert.equal(new Set(filled.map((row) => row.id)).size, filled.length)
  })
})

describe('要几道', () => {
  it('不给就用默认（6 道）', () => {
    assert.equal(parseRecommendCount(undefined), RECOMMEND_COUNT_DEFAULT)
    assert.equal(parseRecommendCount(''), RECOMMEND_COUNT_DEFAULT)
    assert.equal(RECOMMEND_COUNT_DEFAULT, 6)
  })

  it('合法区间照收', () => {
    assert.equal(parseRecommendCount('1'), 1)
    assert.equal(parseRecommendCount(18), 18)
  })

  it('越界与非法值给中文话术（不是 500）', () => {
    for (const bad of ['0', '-1', '19', 'abc', '1.5', 100]) {
      assert.throws(() => parseRecommendCount(bad), /1～18/)
    }
  })
})

describe('sample：越界的随机数也不该取到 undefined', () => {
  it('random 返回 1 或负数时不越界', () => {
    const list = ['a', 'b', 'c']
    assert.equal(sample(list, 3, () => 1).length, 3)
    assert.equal(sample(list, 3, () => 0).length, 3)
    assert.ok(sample(list, 3, () => -5).every((item) => item !== undefined))
    assert.deepEqual(sample(list, 9).sort(), ['a', 'b', 'c'])
    assert.deepEqual(sample(list, 0), [])
  })
})
