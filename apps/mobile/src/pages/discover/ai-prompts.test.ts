import { expect, it } from 'vitest'
import { EXAMPLE_COUNT, EXAMPLE_POOL, HINT_COUNT, HINT_POOL, pickExamples, pickHints } from './ai-prompts'
import { sample } from './random-sample'

// 示例提示的随机抽取（M16 / D-026）。要盯住的事：
// ① 抽出来的**不重复**（重复同一句在界面上是明显的 bug）；
// ② 数量对得上，且不越过池子；
// ③ 真的会变（固定一批等于没随机——那是用户提的问题）；
// ④ 边界安全：random() 返回 0 或 1 都不能取到 undefined（越界会让界面上出现空白标签）。

const pool = ['a', 'b', 'c', 'd', 'e'] as const

it('抽出来不重复、数量对', () => {
  for (let round = 0; round < 200; round += 1) {
    const picked = sample(pool, 3)
    expect(picked).toHaveLength(3)
    expect(new Set(picked).size).toBe(3)
    for (const item of picked) expect(pool).toContain(item)
  }
})

it('要的比池子多时只给池子那么多（不重复、不补 undefined）', () => {
  expect(sample(pool, 99)).toHaveLength(pool.length)
  expect(sample(pool, 99).every((item) => item !== undefined)).toBe(true)
  expect(sample([], 3)).toEqual([])
  expect(sample(pool, 0)).toEqual([])
})

it('真会变：连抽多次至少出现两种不同的组合', () => {
  // 固定种子的洗牌会永远给同一组——那正是用户要修的问题，所以这条必须验"会变"。
  // 用足够多的轮次：只有 5 选 3 时不同组合很少，轮次太少会偶发地假红。
  const seen = new Set(Array.from({ length: 60 }, () => sample(pool, 3).join('')))
  expect(seen.size).toBeGreaterThan(1)
})

it('random 越界（0 或 1）也不会取到 undefined', () => {
  // random() 被桩成 1 时，不做夹取就会索引到数组外 → undefined 会一路显示成空白标签
  const low = sample(pool, 3, () => 0)
  const high = sample(pool, 3, () => 1)
  expect(low.every((item) => item !== undefined)).toBe(true)
  expect(high.every((item) => item !== undefined)).toBe(true)
  expect(new Set(low).size).toBe(3)
  expect(new Set(high).size).toBe(3)
})

it('可注入的 random 让"随机"能被确定地验（传 0 = 保持原序）', () => {
  expect(sample(pool, 3, () => 0)).toEqual(['a', 'b', 'c'])
})

it('两个入口各自抽对数量，且都是池子里的真句子', () => {
  const hints = pickHints()
  expect(hints).toHaveLength(HINT_COUNT)
  expect(new Set(hints).size).toBe(HINT_COUNT)
  for (const hint of hints) expect(HINT_POOL).toContain(hint)

  const examples = pickExamples()
  expect(examples).toHaveLength(EXAMPLE_COUNT)
  expect(new Set(examples).size).toBe(EXAMPLE_COUNT)
  for (const example of examples) expect(EXAMPLE_POOL).toContain(example)
})

it('池子比一次显示的多（否则"换一批"永远换不出新东西）', () => {
  expect(HINT_POOL.length).toBeGreaterThan(HINT_COUNT * 2)
  expect(EXAMPLE_POOL.length).toBeGreaterThan(EXAMPLE_COUNT * 2)
})
