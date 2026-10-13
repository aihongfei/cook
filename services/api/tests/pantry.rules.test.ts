import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALIAS_GROUPS,
  baseName,
  canonicalName,
  isSeasoning,
  matchDish,
  parseMaxMissing,
  parsePantry,
  rankMatches,
  satisfies,
} from '../src/modules/fridge/pantry.rules'

/**
 * 手边食材 × 菜谱配料 的匹配规则（F5-04 / F6-07 / F7-02）。
 *
 * 这一组盯的是**误差方向**：说错"你有了"会让用户少买一样、站到灶台前才发现做不成菜，
 * 说错"你没有"只是多买一根葱。所以下面有一半用例是**反着写的**——
 * 钉住"什么情况下**不许**说匹配"，与 `shopping.rules` 拒绝合并同义词是同一件事。
 */

const dish = (ingredients: string[]) => ingredients.map((name) => ({ name, amount: '适量' }))

describe('清理脏配料名（公开菜谱导进来的名字很不干净）', () => {
  it('去括号注释、数量、尾部的"少许/适量"', () => {
    assert.equal(baseName('五花肉（带皮）'), '五花肉')
    assert.equal(baseName('鸡蛋1个'), '鸡蛋')
    assert.equal(baseName('000面粉'), '面粉')
    assert.equal(baseName('生姜 少许'), '生姜')
    assert.equal(baseName('盐 少许'), '盐')
    assert.equal(baseName('葱 适量'), '葱')
  })

  it('**逐个整词**去"少许/适量"，不是按字去（否则「豆干」会被剥成「豆」）', () => {
    assert.equal(baseName('豆干'), '豆干')
    assert.equal(baseName('香肠'), '香肠')
  })

  it('切法词可以剥：猪肉末/猪肉丝/去皮土豆/生姜片 都归到本体', () => {
    assert.equal(canonicalName('猪肉末'), '猪肉')
    assert.equal(canonicalName('猪肉丝'), '猪肉')
    assert.equal(canonicalName('去皮土豆'), '土豆')
    assert.equal(canonicalName('土豆块'), '土豆')
    assert.equal(canonicalName('生姜片'), '姜')
  })

  it('葱姜蒜的形态归到本体（**靠调料表列举，不靠剥「花」字**）', () => {
    // 剥「花」会把 西兰花 剥成「西兰」、把 韭菜花 剥成「韭菜」（那是另一样东西）
    assert.equal(isSeasoning('葱花'), true)
    assert.equal(isSeasoning('蒜末'), true)
    assert.equal(canonicalName('西兰花'), '西兰花')
    assert.equal(canonicalName('韭菜花'), '韭菜花')
  })

  it('**「皮」不算切法词**：豆腐皮不能被剥成豆腐', () => {
    // 这条是写实现时差点犯的错：PREP_SUFFIX 里放"皮"，"有豆腐"就满足了"要豆腐皮"
    assert.equal(canonicalName('豆腐皮'), '豆腐皮')
    assert.equal(satisfies('豆腐', '豆腐皮'), false)
  })

  it('别名归到代表名（番茄=西红柿、马铃薯=土豆）', () => {
    assert.equal(canonicalName('西红柿'), '番茄')
    assert.equal(canonicalName('马铃薯'), '土豆')
    assert.equal(canonicalName('黑木耳'), '木耳')
  })

  it('**一个名字不许出现在两个组里**（组是顺序生效的，重复会让代表名取决于谁写在后面）', () => {
    /*
     * 这条是反证跑出来的真事：我把「五花肉」加进「猪肉」那一组做反证，
     * 结果 `canonicalName('五花肉')` 仍然返回 `五花肉`——因为后面还有一条
     * `['五花肉','猪五花肉',...]`，**后写的把先写的覆盖了**。
     * 当时的表现是"改了代码却没生效"，查了半天才发现是表本身的顺序问题。
     * 重叠的组不一定都是 bug（可能是想改代表名），但它必然是**没想清楚**的，
     * 所以这里直接禁掉；真要改代表名就改原组，不要新开一条。
     */
    const owner = new Map<string, number>()
    const clashes: string[] = []
    ALIAS_GROUPS.forEach((group, index) => {
      for (const name of group) {
        const previous = owner.get(name)
        if (previous !== undefined && previous !== index) clashes.push(`${name}（第 ${previous} 组与第 ${index} 组）`)
        else owner.set(name, index)
      }
    })
    assert.deepEqual(clashes, [], `别名组有重叠：${clashes.join('、')}`)
  })

  it('组内每个名字都归到本组的代表名（代表名自己也稳定）', () => {
    for (const group of ALIAS_GROUPS) {
      for (const name of group) {
        assert.equal(canonicalName(name), group[0], `${name} 应归到 ${group[0]}`)
      }
      // 代表名再查一次还是它自己（otherwise 会出现 A→B→C 的链）
      assert.equal(canonicalName(group[0]), group[0], `${group[0]} 应对自己稳定`)
    }
  })
})

describe('匹配只做等值/别名/切法，**不做品类推断**', () => {
  it('切法不同照样满足（家里有猪肉就能做要猪肉末的菜）', () => {
    assert.equal(satisfies('猪肉', '猪肉末'), true)
    assert.equal(satisfies('土豆', '去皮土豆'), true)
  })

  it('**蛋清是另一样东西**：有整蛋不算有蛋清、有蛋清更不算有整蛋', () => {
    // 有整蛋确实能磕出蛋清，反过来不行——匹配是无方向的等值比较，那就两个方向都不认。
    // 代价是要蛋清的菜会多显示"差一样"，比"有蛋清就以为够做整蛋的菜"小得多。
    assert.equal(satisfies('鸡蛋', '鸡蛋清'), false)
    assert.equal(satisfies('鸡蛋清', '鸡蛋'), false)
  })

  it('**部位不互认**：五花肉 ≠ 猪肉，猪瘦肉 ≠ 猪肉（少买一样肉比多买严重得多）', () => {
    assert.equal(satisfies('五花肉', '猪肉'), false)
    assert.equal(satisfies('猪肉', '五花肉'), false)
    assert.equal(satisfies('瘦肉', '五花肉'), false)
  })

  it('**品种不互认**：白菜 ≠ 小白菜、木耳 ≠ 银耳、糯米 ≠ 大米', () => {
    assert.equal(satisfies('白菜', '小白菜'), false)
    assert.equal(satisfies('木耳', '银耳'), false)
    assert.equal(satisfies('糯米', '大米'), false)
    assert.equal(satisfies('洋葱', '葱'), false, '同科不同种，不能因为都有"葱"字就互认')
  })

  it('**酱料不互认**：生抽 ≠ 老抽（各是各的味，做出来不是一个菜）', () => {
    assert.equal(satisfies('生抽', '老抽'), false)
  })

  it('同一样东西自己跟自己永远满足（基本的自反性）', () => {
    for (const name of ['盐', '鸡蛋', '五花肉', '木耳', '番茄']) {
      assert.equal(satisfies(name, name), true, name)
    }
  })
})

describe('调料两边都跳过（这是这个功能能不能用的前提）', () => {
  it('库里最常见的那些都算调料', () => {
    // 出现次数排前几的：盐 400 次、油 239、姜 147、葱 116、料酒 107、生抽 99、鸡精 95
    for (const name of ['盐', '油', '姜', '葱', '料酒', '生抽', '鸡精', '白糖', '胡椒粉', '香油', '大蒜', '水', '淀粉', '清水']) {
      assert.equal(isSeasoning(name), true, name)
    }
  })

  it('剥完之后的形态也算（蒜末、生姜片、精盐、熟白芝麻）', () => {
    for (const name of ['蒜末', '生姜片', '精盐', '熟白芝麻', '干辣椒段', '水淀粉', '花椒粒']) {
      assert.equal(isSeasoning(name), true, name)
    }
  })

  it('**主角不是调料**：红枣/枸杞/桂圆/芝麻酱之外的甜品主角要留下', () => {
    // "红枣银耳羹"少了红枣就不是那道菜了，把它当调料等于骗用户"你有银耳就能做"
    for (const name of ['红枣', '枸杞', '桂圆', '葡萄干', '银耳', '莲子', '百合']) {
      assert.equal(isSeasoning(name), false, name)
    }
  })

  it('普通食材一律不算调料', () => {
    for (const name of ['鸡蛋', '土豆', '五花肉', '豆腐', '牛奶', '面粉', '大米', '虾仁']) {
      assert.equal(isSeasoning(name), false, name)
    }
  })

  it('一道菜只有调料时**不出现在结果里**（不许说"你全都有"去骗人）', () => {
    // 一碟蘸水：我们并不知道用户有没有这些调料，说"全都有"是编的
    assert.equal(matchDish(dish(['盐', '生抽', '香油', '葱花']), ['鸡蛋']), null)
  })

  it('配料表为空也不出现（自由菜品、数据缺）', () => {
    assert.equal(matchDish([], ['鸡蛋']), null)
  })
})

describe('比一道菜：用上了什么、还差什么', () => {
  it('全都有时 missing 为空（这是"不用买就能做"的唯一判据）', () => {
    const result = matchDish(dish(['鸡蛋', '番茄', '盐', '葱花']), ['鸡蛋', '西红柿'])
    assert.deepEqual(result, { have: ['鸡蛋', '西红柿'], missing: [], needed: 2 })
  })

  it('差的那样**列名字**而不是只说"差一样"', () => {
    const result = matchDish(dish(['鸡蛋', '番茄', '青椒']), ['鸡蛋'])
    assert.deepEqual(result?.missing, ['番茄', '青椒'])
    assert.deepEqual(result?.have, ['鸡蛋'])
    assert.equal(result?.needed, 3)
  })

  it('have 回显**用户自己的说法**（他说"西红柿"就别回他"番茄"）', () => {
    const result = matchDish(dish(['番茄']), ['西红柿'])
    assert.deepEqual(result?.have, ['西红柿'])
  })

  it('missing **归一**后去重（一道菜里"番茄"和"西红柿"写两遍只差一样）', () => {
    const result = matchDish(dish(['番茄', '西红柿', '鸡蛋']), [])
    assert.deepEqual(result?.missing, ['番茄', '鸡蛋'])
  })

  it('同一样东西在菜里写了两种切法，have 里只算一次（但 missing 会各算一次，见下）', () => {
    const result = matchDish(dish(['猪肉', '猪肉末']), ['猪肉'])
    assert.deepEqual(result?.have, ['猪肉'])
    assert.deepEqual(result?.missing, [])
  })

  it('冰箱里的调料**不算解了这道菜的调料**（盐是默认有的，不是"用上了你的盐"）', () => {
    // 盐在两边都跳过：它既不进 missing 也不进 have
    const result = matchDish(dish(['土豆', '盐']), ['土豆', '盐'])
    assert.deepEqual(result, { have: ['土豆'], missing: [], needed: 1 })
  })
})

describe('排序：先看差几样，再看用掉你多少东西', () => {
  const rows = [
    { recipeId: 'c', name: '差两样的', match: { have: ['土豆'], missing: ['牛肉', '番茄'], needed: 3 } },
    { recipeId: 'b', name: '差一样的', match: { have: ['土豆'], missing: ['牛肉'], needed: 2 } },
    { recipeId: 'a', name: '全都有·用两样', match: { have: ['土豆', '鸡蛋'], missing: [], needed: 2 } },
    { recipeId: 'd', name: '全都有·用一样', match: { have: ['土豆'], missing: [], needed: 1 } },
  ]

  it('差得少的在前；同样不差时**用掉你更多东西的在前**（清库存）', () => {
    const ranked = rankMatches(rows, 2)
    assert.deepEqual(ranked.map((row) => row.recipeId), ['a', 'd', 'b', 'c'])
  })

  it('超过容忍度的一律不出现', () => {
    assert.deepEqual(rankMatches(rows, 0).map((row) => row.recipeId), ['a', 'd'])
    assert.deepEqual(rankMatches(rows, 1).map((row) => row.recipeId), ['a', 'd', 'b'])
  })

  it('missingCount 单独给字段（前端分组不必数数组）', () => {
    assert.deepEqual(rankMatches(rows, 2).map((row) => row.missingCount), [0, 0, 1, 2])
  })

  it('同分有确定顺序（否则两次请求的顺序可能不一样，界面看着像在跳）', () => {
    const same = [
      { recipeId: 'z', name: 'Z', match: { have: ['土豆'], missing: [], needed: 1 } },
      { recipeId: 'a', name: 'A', match: { have: ['土豆'], missing: [], needed: 1 } },
    ]
    assert.deepEqual(rankMatches(same, 1).map((row) => row.recipeId), ['a', 'z'])
  })

  it('**一样都没用上的菜不出现**（否则一页全是"用料最少的菜"，那不是手边食材选菜）', () => {
    // 蒸蛋（只要鸡蛋，而你没有）、凉拌黄瓜（只要黄瓜，而你没有）：它们"差一样"但那跟你手边没关系
    const rows = [
      { recipeId: 'mine', name: '用上你东西的', match: { have: ['土豆'], missing: [], needed: 1 } },
      { recipeId: 'unrelated', name: '跟你没关系的', match: { have: [], missing: ['鸡蛋'], needed: 1 } },
    ]
    assert.deepEqual(rankMatches(rows, 1).map((row) => row.recipeId), ['mine'])
  })

  it('**同名菜只留一道**（库里 33 行是重名，一页里连着三行「番茄炒蛋」看着像列表坏了）', () => {
    const rows = [
      { recipeId: 'v1', name: '番茄炒蛋', match: { have: ['番茄'], missing: [], needed: 1 } },
      { recipeId: 'v2', name: '番茄炒蛋', match: { have: ['番茄'], missing: [], needed: 1 } },
      { recipeId: 'v3', name: '番茄炒蛋', match: { have: ['番茄'], missing: ['鸡蛋'], needed: 2 } },
      { recipeId: 'other', name: '番茄汤', match: { have: ['番茄'], missing: [], needed: 1 } },
    ]
    assert.deepEqual(
      rankMatches(rows, 1).map((row) => row.name),
      ['番茄炒蛋', '番茄汤'],
      '重名的三道只留一道，而"番茄汤"是另一道菜，要留着',
    )
  })

  it('同名去重留的是**更好做的那一份**（差得少的排前面，所以留下来的就是它）', () => {
    const rows = [
      { recipeId: 'needs-egg', name: '番茄炒蛋', match: { have: ['番茄'], missing: ['鸡蛋'], needed: 2 } },
      { recipeId: 'all-have', name: '番茄炒蛋', match: { have: ['番茄', '鸡蛋'], missing: [], needed: 2 } },
    ]
    assert.deepEqual(rankMatches(rows, 1).map((row) => row.recipeId), ['all-have'])
  })
})

describe('参数解析', () => {
  it('手边食材：去空、按代表名去重、限量', () => {
    assert.deepEqual(parsePantry('鸡蛋, 土豆 、西红柿'), ['鸡蛋', '土豆', '西红柿'])
    // 番茄与西红柿是同一个代表名，只留先出现的那个
    assert.deepEqual(parsePantry(['番茄', '西红柿']), ['番茄'])
    assert.deepEqual(parsePantry('   '), [])
    assert.deepEqual(parsePantry(undefined), [])
  })

  it('容忍度：0～3，默认 1', () => {
    assert.equal(parseMaxMissing(undefined), 1)
    assert.equal(parseMaxMissing('0'), 0)
    assert.equal(parseMaxMissing(3), 3)
    assert.throws(() => parseMaxMissing(4))
    assert.throws(() => parseMaxMissing('两样'))
  })
})
