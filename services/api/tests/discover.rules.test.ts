import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COOKED_WEIGHT,
  FAVORITE_WEIGHT,
  PICKS_LIMIT_DEFAULT,
  PICKS_LIMIT_MAX,
  cookedLabel,
  countCooked,
  countFavorites,
  recentDayLabel,
  parsePicksLimit,
  rankPicks,
} from '../src/modules/discover/discover.rules'

/**
 * 家人最爱 / 家人常点（M5 / F5-02）的纯规则单测。口径见 D-038。
 *
 * 要盯住的四件事：
 * ① **同一餐里的多份只算做过一次**（否则榜单变成"谁点的人多"）；
 * ② 做过比收藏重（做一次 > 收一次）；
 * ③ 没信号的菜不进榜（不许拿 0 分的菜凑数）；
 * ④ 同分有确定顺序（否则两次请求顺序可能不一样，界面像在跳）。
 */

describe('一页几道', () => {
  it('不给就用默认值', () => {
    assert.equal(parsePicksLimit(undefined), PICKS_LIMIT_DEFAULT)
    assert.equal(parsePicksLimit(''), PICKS_LIMIT_DEFAULT)
  })

  it('给了就校验：0、负数、超过上限、非整数都拒', () => {
    assert.equal(parsePicksLimit('12'), 12)
    for (const bad of [0, -1, PICKS_LIMIT_MAX + 1, 2.5, '很多']) {
      assert.throws(() => parsePicksLimit(bad), /一页要在/)
    }
  })
})

describe('做过几次：按餐去重', () => {
  it('同一餐里两个人各点一份，只算做过一次', () => {
    const counted = countCooked([
      { recipeId: 'r1', mealOrderId: 'm1', cookedOn: '2026-10-01' },
      { recipeId: 'r1', mealOrderId: 'm1', cookedOn: '2026-10-01' },
    ])
    assert.equal(counted.get('r1')?.cooked, 1)
  })

  it('两餐各做过一次就是两次', () => {
    const counted = countCooked([
      { recipeId: 'r1', mealOrderId: 'm1', cookedOn: '2026-10-01' },
      { recipeId: 'r1', mealOrderId: 'm2', cookedOn: '2026-10-05' },
    ])
    assert.equal(counted.get('r1')?.cooked, 2)
  })

  it('"最近做过"取最近那一餐，与写入顺序无关', () => {
    const counted = countCooked([
      { recipeId: 'r1', mealOrderId: 'm2', cookedOn: '2026-10-05' },
      { recipeId: 'r1', mealOrderId: 'm1', cookedOn: '2026-10-01' },
      { recipeId: 'r1', mealOrderId: 'm3', cookedOn: '2026-09-28' },
    ])
    assert.equal(counted.get('r1')?.lastCookedOn, '2026-10-05')
  })

  it('没做过的那道不在表里（不是 0 次，是没有）', () => {
    const counted = countCooked([{ recipeId: 'r1', mealOrderId: 'm1', cookedOn: '2026-10-01' }])
    assert.equal(counted.get('r2'), undefined)
  })
})

describe('喜欢数', () => {
  it('一个人只算一次，两个人就是两次', () => {
    const counts = countFavorites([
      { recipeId: 'r1', userId: 'u1' },
      { recipeId: 'r1', userId: 'u2' },
      { recipeId: 'r2', userId: 'u1' },
    ])
    assert.equal(counts.get('r1'), 2)
    assert.equal(counts.get('r2'), 1)
  })
})

describe('榜单排序', () => {
  const cookedOf = (rows: [string, string, string][]) =>
    countCooked(rows.map(([recipeId, mealOrderId, cookedOn]) => ({ recipeId, mealOrderId, cookedOn })))

  it('做过比收藏重：做一次（2 分）压过被一个人收藏（1 分）', () => {
    const ranked = rankPicks(
      cookedOf([['做过的', 'm1', '2026-10-01']]),
      countFavorites([{ recipeId: '只被收藏的', userId: 'u1' }]),
    )
    assert.deepEqual(ranked.map((pick) => pick.recipeId), ['做过的', '只被收藏的'])
    assert.equal(ranked[0]?.score, COOKED_WEIGHT)
    assert.equal(ranked[1]?.score, FAVORITE_WEIGHT)
  })

  it('做得越多越靠前；做两次 + 一人收藏（5 分）压过做两次（4 分）', () => {
    const ranked = rankPicks(
      cookedOf([
        ['常做的', 'm1', '2026-09-01'],
        ['常做的', 'm2', '2026-09-08'],
        ['也常做但没人收的', 'm1', '2026-09-01'],
        ['也常做但没人收的', 'm2', '2026-09-08'],
      ]),
      countFavorites([{ recipeId: '常做的', userId: 'u1' }]),
    )
    assert.equal(ranked[0]?.recipeId, '常做的')
    assert.equal(ranked[0]?.score, 2 * COOKED_WEIGHT + FAVORITE_WEIGHT)
  })

  it('没信号的菜不进榜（不许拿 0 分的凑数）', () => {
    const ranked = rankPicks(countCooked([]), countFavorites([]))
    assert.deepEqual(ranked, [])
  })

  it('同分时顺序确定：按做过、收藏、id 依次比，两次调用结果一致', () => {
    const cooked = cookedOf([
      ['b菜', 'm1', '2026-10-01'],
      ['a菜', 'm1', '2026-10-01'],
      ['c菜', 'm1', '2026-10-01'],
    ])
    const favorites = countFavorites([])
    const first = rankPicks(cooked, favorites).map((pick) => pick.recipeId)
    const second = rankPicks(new Map([...cooked].reverse()), favorites).map((pick) => pick.recipeId)
    assert.deepEqual(first, ['a菜', 'b菜', 'c菜'])
    assert.deepEqual(first, second)
  })

  it('收藏多但没做过的，排在做过一次的后面，且各自分数对得上', () => {
    const ranked = rankPicks(
      cookedOf([['做过一次的', 'm1', '2026-10-01']]),
      countFavorites([
        { recipeId: '三个人收着的', userId: 'u1' },
        { recipeId: '三个人收着的', userId: 'u2' },
        { recipeId: '三个人收着的', userId: 'u3' },
      ]),
    )
    // 3 人收藏 = 3 分 > 做过一次 = 2 分
    assert.deepEqual(ranked.map((pick) => pick.recipeId), ['三个人收着的', '做过一次的'])
  })
})

describe('「我做过」那行字（F9-01 / D-075）', () => {
  it('次数与最近日期都写出来', () => {
    assert.equal(cookedLabel(3, '2026-10-12', '2026-10-15'), '做过 3 次 · 最近 3 天前')
  })

  it('当天/昨天/前天用相对说法（用户判断"上次做"用的是日历，不是秒表）', () => {
    assert.equal(recentDayLabel('2026-10-15', '2026-10-15'), '今天')
    assert.equal(recentDayLabel('2026-10-14', '2026-10-15'), '昨天')
    assert.equal(recentDayLabel('2026-10-13', '2026-10-15'), '前天')
  })

  it('一周以上直接给月日（"13 天前"要用户自己再算一遍，而 10-02 一眼对得上日历）', () => {
    assert.equal(recentDayLabel('2026-10-02', '2026-10-15'), '10-02')
    assert.equal(cookedLabel(1, '2026-09-20', '2026-10-15'), '做过 1 次 · 最近 09-20')
  })

  it('跨年时补上年份（不补的话"12-30"是哪个冬天说不清）', () => {
    // 16 天前，落在"给月日"那一档；跨了年，所以要连年份一起给
    assert.equal(recentDayLabel('2025-12-20', '2026-01-05'), '2025-12-20')
    // 同年则只给月日
    assert.equal(recentDayLabel('2026-03-20', '2026-04-05'), '03-20')
  })

  it('未来的日期当"今天"（服务器与库的时钟差几秒会造出"未来"，而"后天做的"是句胡话）', () => {
    assert.equal(recentDayLabel('2026-10-16', '2026-10-15'), '今天')
  })

  it('日期串坏掉时如实回原文，**不编"今天"**（编一个假的比不精确更糟）', () => {
    assert.equal(recentDayLabel('不是日期', '2026-10-15'), '不是日期')
  })

  it('没有最近日期时只说次数（有记录才有这一行，但真缺了也不编一个日期）', () => {
    assert.equal(cookedLabel(2, null, '2026-10-15'), '做过 2 次')
  })
})
