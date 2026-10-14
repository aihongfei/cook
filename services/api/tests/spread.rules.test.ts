import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ROLE_LABEL,
  ROLE_WINDOW,
  SPREAD_DINERS_DEFAULT,
  SPREAD_MAX_DISHES,
  dishCountFor,
  parseSpreadDiners,
  pickSpread,
  roleOf,
  spreadReason,
  spreadSummary,
  type SpreadCandidate,
} from '../src/modules/discover/spread.rules'

/**
 * 「摇一桌」的纯规则单测（F5-01）。口径见 D-072。
 *
 * 要盯住的四件事：
 * ① **道数由人数与餐次决定**，且晚餐不比午餐少、封顶；
 * ② **搭配**：一桌里尽量有荤有素有汤，且不出现重复菜；
 * ③ **凑不满也要给够**（库里没汤时不能只给两道）——这是"不因为分类不认识就不摇"；
 * ④ **理由只说真事**（有冰箱才提冰箱、做过才提次数），不编。
 */

function candidate(id: string, over: Partial<SpreadCandidate> = {}): SpreadCandidate {
  return {
    recipeId: id,
    name: id,
    category: '家常',
    have: [],
    missing: [],
    soon: [],
    cooked: 0,
    lastCookedOn: null,
    ...over,
  }
}

/** 固定序列的伪随机：随机那几条要能复现才验得下去 */
function seq(values: number[]): () => number {
  let index = 0
  return () => values[index++ % values.length]
}

describe('人数与道数', () => {
  it('人数越多道数越多，但封顶（再多就不是"配一桌"了）', () => {
    const one = dishCountFor(1, 'LUNCH')
    const four = dishCountFor(4, 'LUNCH')
    const eight = dishCountFor(8, 'LUNCH')
    assert.ok(one < four, '四个人该比一个人多')
    assert.ok(four <= eight)
    assert.equal(dishCountFor(50, 'DINNER'), SPREAD_MAX_DISHES)
  })

  it('晚餐不比午餐少（晚饭是一天里最正式的一顿）', () => {
    for (const diners of [1, 2, 3, 4, 5, 6, 7]) {
      assert.ok(
        dishCountFor(diners, 'DINNER') >= dishCountFor(diners, 'LUNCH'),
        `${diners} 人时晚餐不该比午餐少`,
      )
    }
  })

  it('一个人也至少给一道（不然"摇一桌"摇出个空桌）', () => {
    assert.ok(dishCountFor(1, 'LUNCH') >= 1)
    assert.ok(dishCountFor(0, 'LUNCH') >= 1, '人数算出 0 也要兜住')
  })

  it('晚餐比午餐多的那一档真的体现出来（2 人：午 2 晚 3）', () => {
    assert.equal(dishCountFor(2, 'LUNCH'), 2)
    assert.equal(dishCountFor(2, 'DINNER'), 3)
  })
})

describe('人数校验', () => {
  it('没给就是没给（返回 null，由服务层决定回退），不是当成 0', () => {
    assert.equal(parseSpreadDiners(undefined), null)
    assert.equal(parseSpreadDiners(null), null)
    assert.equal(parseSpreadDiners(''), null)
    // 这里刻意不用 `?? null` 之外的默认值：默认值只在服务层拼，规则层不替产品做决定
    assert.notEqual(SPREAD_DINERS_DEFAULT, null)
  })

  it('给了就校验：0 / 小数 / 超上限 / 非数字一律 400', () => {
    assert.equal(parseSpreadDiners(4), 4)
    assert.equal(parseSpreadDiners('4'), 4)
    for (const bad of [0, -1, 2.5, 999, 'abc', {}]) {
      assert.throws(() => parseSpreadDiners(bad), /1～/, `${JSON.stringify(bad)} 该被拒`)
    }
  })
})

describe('搭配角色', () => {
  it('汤优先于荤素：豆腐鲫鱼汤在桌上的位置是汤', () => {
    assert.equal(roleOf({ category: '汤', name: '豆腐鲫鱼汤' }), 'soup')
    assert.equal(roleOf({ category: '家常', name: '番茄蛋汤' }), 'soup', '品类写"家常"也要认出是汤')
  })

  it('认得出荤与素', () => {
    assert.equal(roleOf({ category: '荤菜', name: '红烧排骨' }), 'meat')
    assert.equal(roleOf({ category: '素菜', name: '蒜蓉西兰花' }), 'veg')
  })

  it('认不出的归 other（不是被丢掉）', () => {
    assert.equal(roleOf({ category: '', name: '御膳私房小炒' }), 'other')
  })

  it('四种角色都有界面说法（后端下发，前端不自己维护第二份对照）', () => {
    /*
     * 这条守的是"标签没漏"：角色是联合类型，哪天加了第五种而忘了给说法，
     * 界面会渲染出一个 `undefined` 标签——那是用户能看见的空白。
     * 界面不该由前端拼："荤菜/素菜/汤"与本项目的 `mealLabel` / `statusLabel` 同一条规矩。
     */
    for (const role of ['meat', 'veg', 'soup', 'other'] as const) {
      const label = ROLE_LABEL[role]
      assert.equal(typeof label, 'string')
      assert.ok(label.length > 0, `${role} 的界面说法不能是空串`)
    }
    assert.deepEqual(Object.keys(ROLE_LABEL).sort(), ['meat', 'other', 'soup', 'veg'])
  })
})

describe('凑一桌', () => {
  const pool: SpreadCandidate[] = [
    candidate('红烧排骨', { category: '荤菜' }),
    candidate('红烧肉', { category: '荤菜' }),
    candidate('蒜蓉西兰花', { category: '素菜' }),
    candidate('清炒时蔬', { category: '素菜' }),
    candidate('番茄蛋汤', { category: '汤' }),
    candidate('小米粥', { category: '主食' }),
  ]

  it('一桌里有荤有素有汤（搭配是这一块的卖点之一）', () => {
    const picked = pickSpread(pool, 3, seq([0, 0, 0]))
    const roles = picked.map(roleOf)
    assert.deepEqual(roles, ['meat', 'veg', 'soup'])
  })

  it('同一道菜不会出现两次', () => {
    const picked = pickSpread(pool, 6, seq([0.3, 0.5, 0.1, 0.9, 0.2]))
    const ids = picked.map((row) => row.recipeId)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('要几道给几道（够的情况下）', () => {
    for (const count of [1, 2, 3, 4, 5]) {
      assert.equal(pickSpread(pool, count, seq([0])).length, Math.min(count, pool.length))
    }
  })

  it('**库里没有汤也要给够**：不能因为凑不出搭配就少给几道', () => {
    const noSoup = pool.filter((row) => roleOf(row) !== 'soup')
    const picked = pickSpread(noSoup, 4, seq([0]))
    assert.equal(picked.length, 4, '没有汤时仍应按数量补满，而不是只给荤素两道')
  })

  it('认不出品类的菜也能被选中（other 只是排最后，不是排除）', () => {
    const odd = [candidate('认不出的一道', { category: '' }), candidate('红烧排骨', { category: '荤菜' })]
    const picked = pickSpread(odd, 2, seq([0]))
    assert.equal(picked.length, 2)
    assert.ok(picked.some((row) => row.recipeId === '认不出的一道'))
  })

  it('补位不补重复角色：6 人一桌不该出现两道汤（除非库里只剩汤）', () => {
    const many: SpreadCandidate[] = [
      candidate('红烧排骨', { category: '荤菜' }),
      candidate('红烧肉', { category: '荤菜' }),
      candidate('番茄蛋汤', { category: '汤' }),
      candidate('冬瓜汤', { category: '汤' }),
      candidate('蒜蓉西兰花', { category: '素菜' }),
      candidate('红烧鲫鱼', { category: '荤菜' }),
    ]
    const picked = pickSpread(many, 5, seq([0, 0, 0]))
    const soups = picked.filter((row) => roleOf(row) === 'soup')
    assert.equal(soups.length, 1, `一桌里汤出现了 ${soups.length} 次`)
  })

  it('库里只剩同一类时，宁可重复角色也要给够（不能少给菜）', () => {
    const soupsOnly = [
      candidate('番茄蛋汤', { category: '汤' }),
      candidate('冬瓜汤', { category: '汤' }),
      candidate('紫菜汤', { category: '汤' }),
    ]
    assert.equal(pickSpread(soupsOnly, 3, seq([0])).length, 3)
  })

  it('要的比有的多时，有几道给几道（不编）', () => {
    const two = [candidate('A', { category: '荤菜' }), candidate('B', { category: '素菜' })]
    assert.equal(pickSpread(two, 5, seq([0])).length, 2)
  })

  it('要 0 道给空桌（不是给一道）', () => {
    assert.deepEqual(pickSpread(pool, 0, seq([0])), [])
  })

  it('槽位内部**也在抽**：连摇两次荤菜不会永远是同一道', () => {
    const first = pickSpread(pool, 3, seq([0, 0, 0]))
    const second = pickSpread(pool, 3, seq([0.9, 0, 0]))
    assert.notEqual(first[0].recipeId, second[0].recipeId, '同一个槽位连抽两次该可能不同')
  })

  it('抽的范围被 ROLE_WINDOW 夹住（不会抽到排得很后、冰箱完全凑不上的那道）', () => {
    const many: SpreadCandidate[] = Array.from({ length: 20 }, (_, index) =>
      candidate(`荤菜${String(index).padStart(2, '0')}`, { category: '荤菜' }),
    )
    // 无论随机数多大，取到的都必须是前 ROLE_WINDOW 名之内
    const picked = pickSpread(many, 1, seq([0.999_999]))
    const index = many.findIndex((row) => row.recipeId === picked[0].recipeId)
    assert.ok(index < ROLE_WINDOW, `取到第 ${index} 名，超出窗口 ${ROLE_WINDOW}`)
  })
})

describe('理由与那句话', () => {
  it('冰箱里一样不缺才说"正好能做"', () => {
    assert.match(spreadReason(candidate('A', { have: ['排骨', '土豆'] })), /正好能做/)
  })

  it('要买什么就说要买什么（不假装能做）', () => {
    const text = spreadReason(candidate('A', { have: ['排骨'], missing: ['土豆'] }))
    assert.match(text, /要买 土豆/)
    assert.doesNotMatch(text, /正好能做/, '还差一样就不能说"正好能做"')
  })

  it('做过才提做过；一条真事都没有时不留编造的理由', () => {
    assert.match(spreadReason(candidate('A', { cooked: 3 })), /做过 3 次/)
    assert.equal(spreadReason(candidate('A')), '', '没有真事就留空，界面只显示菜名')
  })

  it('头部那句说清几个人、几道菜；是默认值时如实说明', () => {
    assert.equal(spreadSummary(4, 3, true), '4 个人吃，配了 3 道')
    assert.match(spreadSummary(SPREAD_DINERS_DEFAULT, 3, false), /^按 2 个人算/)
  })
})
