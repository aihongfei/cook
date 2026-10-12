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

// ---------- AI 现生成的那批（用户 2026-10-12：「内置的这些不够用」） ----------

it('给了 AI 那批就从它里面抽（写死的那份只是兜底）', () => {
  const hints = ['甲甲', '甲乙', '甲丙', '甲丁', '甲戊', '甲己']
  const picked = pickHints(hints)
  expect(picked).toHaveLength(HINT_COUNT)
  for (const item of picked) expect(hints).toContain(item)
  // 兜底池里的句子一个都不该出现——混着出说明没真用上 AI 那批
  for (const item of picked) expect(HINT_POOL).not.toContain(item)
})

it('AI 那批不够一屏时退回兜底（界面不该出现半排空白）', () => {
  // 后端保证"不够一屏会判失败"，但界面这一层不该依赖对方的前提：
  // 真出现半批的话，抽出来只有两三个标签、剩下的位置空着，比用兜底难看
  const short = ['甲甲', '甲乙']
  const picked = pickHints(short)
  expect(picked).toHaveLength(HINT_COUNT)
  for (const item of picked) expect(HINT_POOL).toContain(item)
})

it('示例问题同理：AI 那批优先，不够就退回兜底', () => {
  const examples = ['甲甲问题', '甲乙问题', '甲丙问题']
  const picked = pickExamples(examples)
  expect(picked).toHaveLength(EXAMPLE_COUNT)
  for (const item of picked) expect(examples).toContain(item)

  const short = pickExamples(['只有一个'])
  expect(short).toHaveLength(EXAMPLE_COUNT)
  for (const item of short) expect(EXAMPLE_POOL).toContain(item)
})

it('没给 AI 那批（undefined / 空数组）时与以前完全一样', () => {
  expect(pickHints(undefined)).toHaveLength(HINT_COUNT)
  expect(pickHints([])).toHaveLength(HINT_COUNT)
  expect(pickExamples(undefined)).toHaveLength(EXAMPLE_COUNT)
})
