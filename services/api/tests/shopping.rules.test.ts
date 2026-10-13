import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateIngredients,
  applyStock,
  compareWithStock,
  stockLabel,
  mergeAmounts,
  normalizeIngredientName,
  parseAmount,
} from '../src/modules/shopping/shopping.rules'

/**
 * 采购清单的纯规则单测（M7 / F7-01）。口径见 D-039。
 *
 * 要盯住的四件事：
 * ① **能加的时候才加**——同单位求和（`2朵` + `3朵` → `5朵`）；
 * ② **不能加就照原样列**——不跨单位求和、不把"适量"折算成数字、不假装区间求平均；
 * ③ **一处都没写用量 = null**（"不知道要多少"，不是"适量"）；
 * ④ 同名食材**跨菜合并**，且保留"哪道菜要用它"。
 */

describe('食材名归一', () => {
  it('只去首尾空白，不做同义词归并（生抽/酱油是两样东西，归并错了会让人少买东西）', () => {
    assert.equal(normalizeIngredientName('  银耳 '), '银耳')
    assert.equal(normalizeIngredientName('生抽'), '生抽')
    assert.notEqual(normalizeIngredientName('生抽'), normalizeIngredientName('酱油'))
  })
})

describe('用量拆成数字与单位', () => {
  it('认得的形状：数字 + 单位，中间的空格吃掉', () => {
    assert.deepEqual(parseAmount('2朵'), { value: 2, unit: '朵' })
    assert.deepEqual(parseAmount('100 g'), { value: 100, unit: 'g' })
    assert.deepEqual(parseAmount('0.5勺'), { value: 0.5, unit: '勺' })
    // 没有单位的纯数字也认（"鸡蛋 2"）
    assert.deepEqual(parseAmount('2'), { value: 2, unit: '' })
  })

  it('认不得的一律返回 null，不猜', () => {
    for (const raw of ['适量', '少许', '', '一大把', '半个', '3-4颗', '2~3个', '5—6片', '3到4个']) {
      assert.equal(parseAmount(raw), null, `"${raw}" 不该被当成数字`)
    }
  })
})

describe('用量合并', () => {
  it('同单位求和', () => {
    assert.equal(mergeAmounts(['2朵', '3朵']), '5朵')
    assert.equal(mergeAmounts(['100g', '50g']), '150g')
  })

  it('求和结果不带多余小数（浮点加法的尾巴要收掉）', () => {
    assert.equal(mergeAmounts(['0.1勺', '0.2勺']), '0.3勺')
    assert.equal(mergeAmounts(['1.5勺', '1.5勺']), '3勺')
  })

  it('单位不一致：各自原样列出，**不跨单位求和**', () => {
    const merged = mergeAmounts(['2朵', '1袋'])
    assert.equal(merged, '2朵、1袋')
    assert.ok(!merged.includes('3'), '不该出现 3（2 朵 + 1 袋不是 3 什么）')
  })

  it('含认不出的写法：能合的合，认不出的照原样列', () => {
    assert.equal(mergeAmounts(['2g', '适量']), '2g、适量')
    assert.equal(mergeAmounts(['适量', '适量']), '适量')
    assert.equal(mergeAmounts(['3-4颗']), '3-4颗')
  })

  it('一处都没写用量 → null（不是"适量"，也不是"0"）', () => {
    assert.equal(mergeAmounts(['', '  ']), null)
    assert.equal(mergeAmounts([]), null)
  })

  it('区间写法原样保留，不假装求平均（"3-4颗"不是 3.5 颗）', () => {
    assert.equal(mergeAmounts(['3-4颗', '3-4颗']), '3-4颗')
    assert.equal(mergeAmounts(['2~3个']), '2~3个')
  })

  it('同样的认不出写法去重（"适量"写三遍还是一次）', () => {
    assert.equal(mergeAmounts(['适量', '适量', '少许', '少许']), '适量、少许')
  })
})

describe('按菜单汇总', () => {
  it('同名食材跨菜合并，并保留"哪道菜要用它"', () => {
    const items = aggregateIngredients([
      { dish: '番茄炒蛋', ingredients: [{ name: '鸡蛋', amount: '2个' }, { name: '葱', amount: '1根' }] },
      { dish: '蛋花汤', ingredients: [{ name: '鸡蛋', amount: '3个' }, { name: '盐', amount: '适量' }] },
    ])
    const egg = items.find((item) => item.name === '鸡蛋')
    assert.equal(egg?.amount, '5个')
    assert.deepEqual(egg?.from, ['番茄炒蛋', '蛋花汤'])
    const onion = items.find((item) => item.name === '葱')
    assert.deepEqual(onion?.from, ['番茄炒蛋'])
  })

  it('顺序按食材名排（改一餐的顺序，单子的位置不变）', () => {
    const first = aggregateIngredients([
      { dish: '甲', ingredients: [{ name: '猪肉', amount: '100g' }, { name: '白菜', amount: '1棵' }] },
    ])
    const second = aggregateIngredients([
      { dish: '甲', ingredients: [{ name: '白菜', amount: '1棵' }, { name: '猪肉', amount: '100g' }] },
    ])
    assert.deepEqual(first.map((item) => item.name), second.map((item) => item.name))
  })

  it('空名被丢掉（脏数据不该变成一张"要买的东西没名字"的单子）', () => {
    const items = aggregateIngredients([{ dish: '甲', ingredients: [{ name: '  ', amount: '1' }] }])
    assert.deepEqual(items, [])
  })

  it('一道菜多点了几份不影响配料（清单按"做哪几道菜"算，不按份数）', () => {
    // 卡片合并（D-029）已经保证同一餐同一道菜只出现一次，这里验的是"汇总不依赖份数"
    const items = aggregateIngredients([
      { dish: '红烧肉', ingredients: [{ name: '五花肉', amount: '500g' }] },
    ])
    assert.equal(items.find((item) => item.name === '五花肉')?.amount, '500g')
  })

  it('没写用量的食材照样列出（买菜的人至少知道要买这一样）', () => {
    const items = aggregateIngredients([{ dish: '甲', ingredients: [{ name: '白糖', amount: '' }] }])
    assert.deepEqual(items, [{ name: '白糖', amount: null, from: ['甲'] }])
  })
})

/**
 * 与库存比对（M7 / F7-02「只买缺的」）。
 *
 * 这一组盯的是**"算不清就不算"**这条线：说"够了"会让用户不买、站到灶台前才发现少一样；
 * 说"不知道"只是让他自己看一眼冰箱。所以下面有一半用例是钉"什么情况下**不许**给结论"。
 *
 * 匹配那半（别名/切法/不做品类推断）在 `pantry.rules.test.ts` 里已经逐条验过——
 * 这里只验"确实调的是那一套"（不然采购清单会与手边食材选菜给出不同答案）。
 */
describe('与库存比对：能算才算（F7-02）', () => {
  const buy = (name: string, amount: string | null, stock: { name: string; amount: string | null }[]) =>
    compareWithStock({ name, amount }, stock)

  it('家里没有：照买（结果里没有任何"家里有"的话）', () => {
    const result = buy('番茄', '2个', [{ name: '土豆', amount: '3个' }])
    assert.equal(result.verdict, 'missing')
    assert.equal(result.stockName, null)
    assert.equal(stockLabel(result), null, '没有的东西不该在清单上说一句话')
  })

  it('同单位且都算得清、家里够：够了，不用买', () => {
    const result = buy('鸡蛋', '2个', [{ name: '鸡蛋', amount: '6个' }])
    assert.equal(result.verdict, 'enough')
    assert.equal(stockLabel(result), '家里有 6个，够了')
  })

  it('同单位但不够：给出**还要买多少**（不是只说"不够"）', () => {
    const result = buy('鸡蛋', '5个', [{ name: '鸡蛋', amount: '3个' }])
    assert.equal(result.verdict, 'notEnough')
    assert.equal(result.remaining, '2个')
    assert.equal(stockLabel(result), '家里有 3个，还要买 2个')
  })

  it('同一样东西在冰箱里放了两处：两处的量**加起来**算', () => {
    const result = buy('鸡蛋', '5个', [
      { name: '鸡蛋', amount: '3个' },
      { name: '鸡蛋', amount: '4个' },
    ])
    assert.equal(result.verdict, 'enough')
    assert.equal(result.stockAmount, '3个、4个', '原样回显给用户核对')
  })

  it('**单位对不上就算不清**（"半盒"是几个？只有人知道）', () => {
    const result = buy('鸡蛋', '2个', [{ name: '鸡蛋', amount: '半盒' }])
    assert.equal(result.verdict, 'unknown')
    assert.equal(result.remaining, null, '算不清就不许给数字')
    assert.equal(stockLabel(result), '家里有 半盒，够不够看一眼')
  })

  it('**菜谱没说要多少（或写"适量"）就算不清**：连要多少都不知道，凭什么说够', () => {
    for (const amount of [null, '适量', '少许', '3-4颗']) {
      const result = buy('盐', amount, [{ name: '盐', amount: '一罐' }])
      assert.equal(result.verdict, 'unknown', `${amount} 时不该给结论`)
      assert.equal(stockLabel(result), '家里有 一罐，够不够看一眼')
    }
  })

  it('**冰箱那侧没写量也算不清**（"有鸡蛋"不等于"有够用的鸡蛋"）', () => {
    const result = buy('鸡蛋', '2个', [{ name: '鸡蛋', amount: null }])
    assert.equal(result.verdict, 'unknown')
    assert.equal(stockLabel(result), '家里有，够不够看一眼')
  })

  it('名字不同但确实是同一样东西：认得出（复用 pantry.rules 那一套）', () => {
    // 西红柿＝番茄；家里写"猪肉"要买"猪肉末"（切法）
    assert.equal(buy('番茄', '2个', [{ name: '西红柿', amount: '3个' }]).verdict, 'enough')
    assert.equal(buy('猪肉末', '100g', [{ name: '猪肉', amount: '200g' }]).verdict, 'enough')
  })

  it('**部位不互认**：有五花肉不算有猪肉（判错会让人少买一样肉）', () => {
    const result = buy('猪肉', '200g', [{ name: '五花肉', amount: '300g' }])
    assert.equal(result.verdict, 'missing', '五花肉不该解掉要猪肉的菜')
  })

  it('清单顺序不变（买菜时位置要稳定，分两件事看就够）', () => {
    const items = [
      { name: '番茄', amount: '2个', from: ['甲'] },
      { name: '土豆', amount: '3个', from: ['乙'] },
      { name: '猪肉', amount: '200g', from: ['丙'] },
    ]
    const stock = [{ name: '土豆', amount: '5个' }, { name: '番茄', amount: '1个' }]
    const result = applyStock(items, stock)
    assert.deepEqual(result.map((item) => item.name), ['番茄', '土豆', '猪肉'], '顺序照旧')
    assert.deepEqual(result.map((item) => item.needsBuy), [true, false, true])
  })

  it('`needsBuy` 的判定：只有"家里够"与"算不清"不用买', () => {
    const items = [
      { name: '鸡蛋', amount: '2个', from: ['甲'] },   // 够 → 不买
      { name: '牛肉', amount: '200g', from: ['乙'] },  // 没有 → 买
      { name: '盐', amount: '适量', from: ['丙'] },    // 家里有但算不清 → 不买（列在"家里有"里）
    ]
    const stock = [
      { name: '鸡蛋', amount: '6个' },
      { name: '盐', amount: '一罐' },
    ]
    const result = applyStock(items, stock)
    assert.deepEqual(result.map((item) => [item.name, item.stock.verdict, item.needsBuy]), [
      ['鸡蛋', 'enough', false],
      ['牛肉', 'missing', true],
      ['盐', 'unknown', false],
    ])
  })

  it('冰箱是空的：所有条目都是"照买"（一条"家里有"都不许编）', () => {
    const result = applyStock([{ name: '鸡蛋', amount: '2个', from: ['甲'] }], [])
    assert.deepEqual(result[0].stock, { verdict: 'missing', stockName: null, stockAmount: null, remaining: null })
  })
})
