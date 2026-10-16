import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
  OCCASIONS,
  REPORT_MIN_MEALS,
  SEASON_TAGS,
  monthlyReport,
  occasionLabel,
  occasionReason,
  parseOccasion,
  seasonOf,
  topDishOf,
} from '../src/modules/discover/discover-page.rules'

test('季节按月份算：3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬', () => {
  assert.deepEqual([3, 4, 5].map(seasonOf), ['春', '春', '春'])
  assert.deepEqual([6, 7, 8].map(seasonOf), ['夏', '夏', '夏'])
  assert.deepEqual([9, 10, 11].map(seasonOf), ['秋', '秋', '秋'])
  assert.deepEqual([12, 1, 2].map(seasonOf), ['冬', '冬', '冬'])
  // 12 月与 1 月落在同一季：冬被跨年切成两半，但"冬天的菜"就是同一批
  assert.equal(seasonOf(12), seasonOf(1))
})

test('每个季节都有一组标签，且**不止一个**（只取最正的那个会让夏秋少掉一大半）', () => {
  for (const season of ['春', '夏', '秋', '冬']) {
    const tags = SEASON_TAGS[season]
    assert.ok(Array.isArray(tags) && tags.length >= 3, `${season} 应该有 3 个以上的标签`)
    assert.ok(tags.includes(`${season}季`), `${season} 应该首先包含最正的那个标签`)
  }
  // 2026-10-16 实测：夏季 51（只取「夏季」）vs 79（并集）——差 28 道，不是小数
  assert.ok(SEASON_TAGS['夏'].includes('夏季菜谱'))
  assert.ok(SEASON_TAGS['秋'].includes('秋季养生'))
})

test('occasion：只认表里那几个标签名，别的一律 400（不静默当没给）', () => {
  assert.equal(parseOccasion('快手菜'), '快手菜')
  assert.equal(parseOccasion(' 儿童 '), '儿童')
  for (const empty of [undefined, null, '', '   ']) assert.equal(parseOccasion(empty), null)
  // 静默忽略最坏：用户以为场合生效了，而结果其实没变——那种错查起来最费劲
  for (const bad of ['不想费劲', '早餐', '快手', 'unknown']) {
    assert.throws(() => parseOccasion(bad), BadRequestException, `${bad} 应该被拒`)
  }
})

test('四个场合词：界面上是三个字，接口上必须是**标签名**，而且都落在午饭/晚饭能成立的场合里', () => {
  assert.deepEqual(OCCASIONS.map((item) => item.label), ['不想费劲', '干饭要香', '来客人了', '做给孩子'])
  assert.deepEqual(OCCASIONS.map((item) => item.tag), ['快手菜', '下饭菜', '宴请', '儿童'])
  /*
   * 「早上吃什么」（标签「早餐」83 道）**不能进这一行**：`MealSlot` 只有 LUNCH | DINNER，
   * 点了它会挑出一道包子或粥，然后一路走到「就它了」→ 被加进晚饭。这是硬错。
   * 这条断言就是那个结论的守门人：谁想加回早餐词，得先看见这段。
   */
  assert.ok(!OCCASIONS.some((item) => item.tag === '早餐'))
  assert.ok(!OCCASIONS.some((item) => item.label.includes('早')))
})

test('说人话：标签名 → 那三个字；理由把"按你说的 X 挑的"拼在前面而不是替掉原来的理由', () => {
  assert.equal(occasionLabel('快手菜'), '不想费劲')
  assert.equal(occasionLabel('不认识的标签'), '不认识的标签')
  const base = '冰箱里的 虾、粉丝 正好能做这道'
  assert.equal(occasionReason('宴请', base), '按你说的「来客人了」挑的；冰箱里的 虾、粉丝 正好能做这道')
  // 原句必须原样还在：冰箱与家人信号那几句是真事，场合那句是另一件事
  assert.ok(occasionReason('宴请', base).includes(base))
})

test('topDishOf：真分出高下才给冠军，平手 / 只做过一次都返回 null', () => {
  assert.deepEqual(topDishOf([{ name: '红烧排骨', count: 3, lastOn: '10/16' }]), { name: '红烧排骨', on: '10/16' })
  // 平手：说"最常做的是红烧排骨"是假话（另一道一样多），用户会指着它问"那昨天的番茄炒蛋呢"
  assert.equal(topDishOf([
    { name: '红烧排骨', count: 2, lastOn: '10/16' },
    { name: '番茄炒蛋', count: 2, lastOn: '10/15' },
  ]), null)
  // 每道只做过一次 → 没有"最常做的"
  assert.equal(topDishOf([{ name: '红烧排骨', count: 1, lastOn: '10/16' }]), null)
  assert.equal(topDishOf([]), null)
  assert.equal(topDishOf([{ name: '红烧排骨', count: 2, lastOn: '10/16' }, { name: '番茄炒蛋', count: 1, lastOn: '10/15' }])?.name, '红烧排骨')
})

test('月报：不足 3 顿整块不画（null，不是一堆 0）', () => {
  const base = { done: 0, kinds: 0, photos: 0, topDish: null, topDishOn: null }
  assert.equal(monthlyReport({ ...base, meals: 0 }), null)
  assert.equal(monthlyReport({ ...base, meals: 2 }), null)
  assert.equal(REPORT_MIN_MEALS, 3)
  assert.ok(monthlyReport({ ...base, meals: 3 }), '刚好 3 顿就该画')
})

test('月报的脚注只说真事：有冠军才提冠军、没开火就直说、拍 0 张才提醒', () => {
  const withTop = monthlyReport({ meals: 10, done: 4, kinds: 10, photos: 6, topDish: '红烧排骨', topDishOn: '10/16' })
  assert.equal(withTop?.line, '最常做的是 红烧排骨（10/16）。')
  // 照片不为 0 时不提照片（提醒只在真的一张都没有时出现）
  assert.ok(!withTop?.line.includes('成品照'))

  const noFire = monthlyReport({ meals: 3, done: 0, kinds: 0, photos: 0, topDish: null, topDishOn: null })
  assert.ok(noFire?.line.includes('还没开火'))
  assert.ok(noFire?.line.includes('拍张成品照'))

  // 做过几顿但每道都不一样：不硬凑一个第一名，而且**这比硬凑好听**
  const allDifferent = monthlyReport({ meals: 4, done: 4, kinds: 4, photos: 2, topDish: null, topDishOn: null })
  assert.equal(allDifferent?.line, '做了 4 顿，每道都不一样。')
})

/**
 * 「季节标签」与「场合词」都会出现在 URL 上（`/recipes?tag=...`、`/discover/decide?occasion=...`）。
 * 标签里带 `,` 会把一件事拆成两件（`秋季菜谱` 不会，但导入源哪天加一个带逗号的标签就会）。
 * 这条守门人把"库里现在没有这种标签"变成一条可验的断言，而不是一句但愿。
 */
test('会进 URL 的标签里不能有逗号（有的话会被当成两个标签）', () => {
  for (const tags of Object.values(SEASON_TAGS)) {
    for (const tag of tags) assert.ok(!tag.includes(','), `${tag} 不该带逗号`)
  }
  for (const occasion of OCCASIONS) assert.ok(!occasion.tag.includes(','), `${occasion.tag} 不该带逗号`)
})
