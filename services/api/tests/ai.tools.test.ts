import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_TOOLS,
  PROPOSALS_MAX,
  SEARCH_RESULTS_MAX,
  TOOL_PROPOSE_MENU_ITEMS,
  TOOL_READ_PLAN,
  TOOL_ROUNDS_MAX,
  TOOL_SEARCH_DISHES,
  allowedDates,
  clampMealDate,
  describeWhen,
  readProposals,
  searchResult,
  todayKey,
} from '../src/modules/ai/ai.tools'

// AI 的内置工具（用户 2026-10-12 第③项；口径见 D-026 第三次补充）。不碰网络也不碰数据库：
// 参数校验、日期收敛、结果形状都是纯函数，直接验。
//
// 这一组测试盯的是**模型的输出是不可信输入**这条：它会编 id、写乱日期、给重复项、回非法 JSON。
// 每一条都要有确定的处置，且处置方式必须与"推荐"那条路一致（编造的 id 一律丢掉，
// 不然界面上会长出一道库里没有的菜）。

const TODAY = '2026-10-12'
const LIBRARY = new Map([
  ['r-tomato', '番茄炒蛋'],
  ['r-bokchoy', '清炒小白菜'],
])

test('工具声明本身要合法：名字、必填、additionalProperties', () => {
  assert.equal(AI_TOOLS.length, 3)
  const names = AI_TOOLS.map((tool) => tool.function.name)
  assert.deepEqual(names, [TOOL_SEARCH_DISHES, TOOL_PROPOSE_MENU_ITEMS, TOOL_READ_PLAN])
  for (const tool of AI_TOOLS) {
    // 模型按 description 决定调不调；空描述等于这个工具不存在
    assert.ok(tool.function.description.length > 10, `${tool.function.name} 的描述太短`)
    assert.equal(tool.function.parameters.type, 'object')
    // strict 风格：不让模型自由加字段，否则参数形状不确定，执行前得多写一堆防御
    assert.equal(tool.function.parameters.additionalProperties, false)
  }
})

test('模型编造的 id 一律丢掉，并在工具结果里点名（不是静默丢）', () => {
  const args = JSON.stringify({
    items: [
      { recipeId: 'r-tomato', mealDate: TODAY, meal: 'DINNER' },
      { recipeId: 'r-made-up', mealDate: TODAY, meal: 'DINNER' },
    ],
  })
  const { proposals, rejected } = readProposals(args, LIBRARY, TODAY)
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].name, '番茄炒蛋')
  // 静默丢掉的话模型会以为一切顺利，然后跟用户说"已经帮你加好了"
  assert.deepEqual(rejected, ['r-made-up'])
})

test('日期：合法的原样留，越界/乱写的收敛到最近可选那天', () => {
  const allowed = allowedDates(TODAY, 3)
  assert.deepEqual(allowed, ['2026-10-12', '2026-10-13', '2026-10-14'])

  const pick = (mealDate: unknown) => readProposals(
    JSON.stringify({ items: [{ recipeId: 'r-tomato', mealDate, meal: 'LUNCH' }] }),
    LIBRARY, TODAY,
  ).proposals[0]?.mealDate

  assert.equal(pick('2026-10-13'), '2026-10-13', '窗口内的日期要保留')
  assert.equal(pick('2026-10-20'), '2026-10-12', '超出点菜窗口 → 收敛到最近可选')
  assert.equal(pick('2025-01-01'), '2026-10-12', '去年的日期 → 收敛')
  assert.equal(pick('明天'), '2026-10-12', '不是日期 → 收敛')
  assert.equal(pick(undefined), '2026-10-12', '没给 → 收敛到最早可选（今天）')
  // 模型会写出这种不存在的日期，不能让 Date 自己滚成别的月份
  assert.equal(clampMealDate('2026-13-45', TODAY), '2026-10-12')
})

test('餐次只认午/晚；给了别的值按晚餐算（不崩、不丢整条）', () => {
  const meal = (value: unknown) => readProposals(
    JSON.stringify({ items: [{ recipeId: 'r-tomato', mealDate: TODAY, meal: value }] }),
    LIBRARY, TODAY,
  ).proposals[0]?.meal

  assert.equal(meal('LUNCH'), 'LUNCH')
  assert.equal(meal('DINNER'), 'DINNER')
  assert.equal(meal('BREAKFAST'), 'DINNER', '库里的餐次只有午/晚（MEAL_SLOTS）')
  assert.equal(meal(undefined), 'DINNER')
})

test('重复的菜不重复提，超过上限的截断', () => {
  const many = Array.from({ length: PROPOSALS_MAX + 4 }, () => ({
    recipeId: 'r-tomato', mealDate: TODAY, meal: 'DINNER',
  }))
  assert.equal(readProposals(JSON.stringify({ items: many }), LIBRARY, TODAY).proposals.length, 1,
    '同一道菜同一餐次只提一次')

  const mixed = [
    { recipeId: 'r-tomato', mealDate: TODAY, meal: 'DINNER' },
    { recipeId: 'r-tomato', mealDate: TODAY, meal: 'LUNCH' },
    { recipeId: 'r-bokchoy', mealDate: TODAY, meal: 'DINNER' },
  ]
  assert.equal(readProposals(JSON.stringify({ items: mixed }), LIBRARY, TODAY).proposals.length, 3,
    '换了餐次就是另一条建议，不算重复')
})

test('参数不是合法 JSON / 缺 items：返回空 + 原因，不抛异常', () => {
  for (const bad of ['not json', '{', '{"items": "nope"}', '[]']) {
    const out = readProposals(bad, LIBRARY, TODAY)
    assert.deepEqual(out.proposals, [], `坏参数应当得到空建议：${bad}`)
    assert.ok(out.rejected.length >= 1, '要给出原因，好让模型换个说法重来')
  }
})

test('「哪一餐」的人话：今/明/后 + 餐次，更远的用月-日', () => {
  assert.equal(describeWhen('2026-10-12', TODAY, 'DINNER'), '今天晚餐')
  assert.equal(describeWhen('2026-10-13', TODAY, 'LUNCH'), '明天午餐')
  assert.equal(describeWhen('2026-10-14', TODAY, 'DINNER'), '后天晚餐')
  assert.equal(describeWhen('2026-10-20', TODAY, 'DINNER'), '10-20晚餐')
})

test('搜索结果给模型的形状：真实 id + 少量标签，空结果给的是"换个词"而不是空数组', () => {
  const hits = [
    { id: 'r-tomato', name: '番茄炒蛋', category: '家常菜', tags: ['快手', '清淡', '下饭', '儿童', '早餐'] },
  ]
  const parsed = JSON.parse(searchResult(hits, '番茄'))
  assert.equal(parsed.dishes[0].recipeId, 'r-tomato')
  assert.equal(parsed.dishes[0].tags.length, 4, '标签只给 4 个（多余的挤上下文）')

  const empty = JSON.parse(searchResult([], '不存在'))
  assert.deepEqual(empty.dishes, [])
  assert.ok(empty.hint.includes('换个关键词'), '空结果要让模型换词，而不是让它自己编')

  const many = Array.from({ length: SEARCH_RESULTS_MAX + 5 }, (_, index) => ({
    id: `r-${index}`, name: `菜${index}`, category: '家常菜', tags: [],
  }))
  assert.equal(JSON.parse(searchResult(many, '菜')).dishes.length, SEARCH_RESULTS_MAX)
})

test('日期键按服务器本地日历算，且补零', () => {
  assert.equal(todayKey(new Date(2026, 0, 5, 9, 0, 0)), '2026-01-05')
  assert.equal(todayKey(new Date(2026, 11, 31, 23, 59, 0)), '2026-12-31')
})

test('轮数上限是个小数字（防止模型来回打转烧额度）', () => {
  assert.ok(TOOL_ROUNDS_MAX >= 2, '至少要有"搜一次 → 提一次 → 收尾"的余量')
  assert.ok(TOOL_ROUNDS_MAX <= 5, '上限太宽松就等于没有上限')
})
