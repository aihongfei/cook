import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AISLE_ORDER,
  aisleOf,
  aisleZone,
  checkFresh,
  isBuyable,
  parseExtraAmount,
  parseExtraName,
  SHOPPING_CHECK_TTL_DAYS,
} from '../src/modules/shopping/shopping.rules'

/**
 * 采购清单编辑的纯规则单测（M7 / F7-03、F7-05）。口径见 D-064。
 *
 * 要盯住的四件事：
 * ① **水不是商品**（没人去超市买温水）——但要滤得准，别把高汤/鸡汤也滤掉；
 * ② **归类认识就说、不认识就说不知道**——"其他"是安全默认，不许硬塞；
 * ③ **勾选有保质期**（上周勾的"葱"不能这周还亮着）；
 * ④ **补货的分区是推出来的默认值**，不是答案（用户能改）。
 */

describe('水不是商品（F7-03 过滤）', () => {
  it('水的各种写法都滤掉——没人去超市买"温水"', () => {
    for (const name of ['水', '清水', '温水', '开水', '热水', '凉水', '凉开水', '纯净水', '冰水', ' 水 ']) {
      assert.equal(isBuyable(name), false, `${name} 不该出现在采购清单上`)
    }
  })

  it('**高汤/鸡汤/骨头汤不能一起滤掉**——那几样是真的要买（或要自己煮）', () => {
    /*
     * 这一条钉住"别顺手把"汤"字都滤了"。它们与"水龙头里就有"不是一回事：
     * 高汤要么买现成的汤块，要么自己熬——总之不是自来水。
     */
    for (const name of ['高汤', '鸡汤', '骨头汤', '清汤']) {
      assert.equal(isBuyable(name), true, `${name} 是真要买的，不该被滤掉`)
    }
  })

  it('空名字不算商品（聚合时出现空名应该已经被跳过了）', () => {
    assert.equal(isBuyable(''), false)
    assert.equal(isBuyable('   '), false)
  })
})

describe('货架归类（F7-03 分组）', () => {
  it('认识的名字归到对应货架', () => {
    assert.equal(aisleOf('胡萝卜'), '蔬菜水果')
    assert.equal(aisleOf('五花肉'), '肉蛋水产')
    assert.equal(aisleOf('鸡蛋'), '蛋奶豆制品')
    assert.equal(aisleOf('大米'), '米面粮油')
    assert.equal(aisleOf('生抽'), '调味干货')
  })

  it('**葱姜蒜香菜算蔬菜水果**，不算调料——它们确实在菜摊上（两张表回答两个问题）', () => {
    /*
     * `pantry.rules` 的 SEASONINGS 里有葱姜蒜（那是"做菜时默认家里有"），
     * 但买菜的时候它们**就在菜摊上**，所以货架归"蔬菜水果"。
     * 判据顺序不能换：先查货架表，再查调料表。
     */
    for (const name of ['葱', '姜', '蒜', '香菜', '小葱', '大蒜']) {
      assert.equal(aisleOf(name), '蔬菜水果', `${name} 买菜时在菜摊上`)
    }
  })

  it('别名跟着主名走（西红柿→番茄、马铃薯→土豆）', () => {
    assert.equal(aisleOf('番茄'), aisleOf('西红柿'))
    assert.equal(aisleOf('马铃薯'), aisleOf('土豆'))
    assert.equal(aisleOf('青豆'), aisleOf('豌豆'))
  })

  it('**不认识就说"其他"，不硬塞**——塞进最像的那组会让用户在错的货架里找', () => {
    /*
     * 这条是"允许容错、但不许假装认识"的判据（与 `pantry.rules` 拒绝品类推断不同：
     * 那个判错用户会少买，这个判错只是多扫一眼）。所以长尾写法应该老实落到「其他」。
     */
    assert.equal(aisleOf('某个不存在的食材名字'), '其他')
    assert.equal(aisleOf(''), '其他')
  })

  it('每组都不该重复：同一样东西只能在一个货架上（别名展开时尤其要防）', () => {
    // 抽查几个容易重复的：它们同时出现在别名组与货架表里
    for (const name of ['西红柿', '番茄', '土豆', '马铃薯', '豌豆', '青豆', '银耳', '雪耳']) {
      const aisle = aisleOf(name)
      assert.notEqual(aisle, '其他', `${name} 应该有明确归属`)
    }
  })

  it('显示顺序是"逛超市的动线"：生鲜在前、调料垫底、其他最后', () => {
    assert.deepEqual([...AISLE_ORDER], ['蔬菜水果', '肉蛋水产', '蛋奶豆制品', '米面粮油', '调味干货', '其他'])
  })
})

describe('补货的分区（F7-05）', () => {
  it('按货架推默认存放区：冷冻的进冷冻、生鲜进冷藏、干货进常温', () => {
    assert.equal(aisleZone('肉蛋水产'), '冷冻')
    assert.equal(aisleZone('蔬菜水果'), '冷藏')
    assert.equal(aisleZone('蛋奶豆制品'), '冷藏')
    assert.equal(aisleZone('米面粮油'), '常温')
    assert.equal(aisleZone('调味干货'), '常温')
    assert.equal(aisleZone('其他'), '常温')
  })

  it('**"其他"进常温**（不确定就往最不伤的那个走）：放常温最多是不会坏，放冷冻会毁掉干货', () => {
    /*
     * 推错分区只是让用户改一下（补完能去冰箱页编辑），但两个方向代价不对等：
     * 把不该冷冻的东西放冷冻（比如干香菇）会**真的坏掉**，而放到常温最多是不最优。
     */
    assert.equal(aisleZone(aisleOf('某个不认识的东西')), '常温')
  })
})

describe('勾选的保质期（F7-03）', () => {
  const now = new Date('2026-10-13T12:00:00')

  it('刚勾的有效；超过期限的算过期（当作没勾）', () => {
    assert.equal(checkFresh(new Date('2026-10-13T11:00:00'), now), true)
    assert.equal(checkFresh(new Date('2026-10-12T12:00:00'), now), true)
    assert.equal(checkFresh(new Date('2026-10-06T12:00:00'), now), false)
  })

  it('期限是 7 天：上周勾的"葱"不能这周还亮着', () => {
    assert.equal(SHOPPING_CHECK_TTL_DAYS, 7)
    const justInside = new Date(now.getTime() - 6.9 * 86_400_000)
    const justOutside = new Date(now.getTime() - 7.1 * 86_400_000)
    assert.equal(checkFresh(justInside, now), true)
    assert.equal(checkFresh(justOutside, now), false)
  })
})

describe('自加条目的输入校验（F7-03）', () => {
  it('名字必填、去首尾空白', () => {
    assert.equal(parseExtraName('  垃圾袋 '), '垃圾袋')
    assert.throws(() => parseExtraName('   '), /写个名字/)
    assert.throws(() => parseExtraName(undefined), /写个名字/)
    assert.throws(() => parseExtraName('x'.repeat(41)), /最多 40 个字/)
  })

  it('数量可空（逼人填数字会让人干脆不记），但填了要认真', () => {
    assert.equal(parseExtraAmount(undefined), null)
    assert.equal(parseExtraAmount(null), null)
    assert.equal(parseExtraAmount('   '), null)
    assert.equal(parseExtraAmount(' 两卷 '), '两卷')
    assert.throws(() => parseExtraAmount('x'.repeat(25)), /最多 24 个字/)
    assert.throws(() => parseExtraAmount(123), /得是一句话/)
  })
})
