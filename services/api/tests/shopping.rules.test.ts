import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateIngredients,
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
