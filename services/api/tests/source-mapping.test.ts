import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classify,
  cleanDishName,
  deriveCuisine,
  deriveSpiciness,
  parseCommaPair,
  parseSpacePair,
  sourceRecipeId,
  stripStepNumbering,
} from '../src/modules/recipes/sources/recipe-source'

// 外部数据源的归一规则测试。这些规则是启发式的，用真实踩过的样本锁住行为，
// 避免以后调规则时把已经正确的分类改坏（例：红烧肉（电饭锅）曾被误判为主食）。

test('classify 按 汤 → 主食 → 素菜 → 荤菜 归类，且不被厨具词误导', () => {
  assert.equal(classify([], '番茄鸡蛋汤').category, '汤')
  assert.equal(classify([], '排骨莲藕羹').category, '汤')
  assert.equal(classify([], '家常米饭').category, '主食')
  assert.equal(classify(['家常菜'], '红烧肉（电饭锅）').category, '荤菜', '电饭锅不能被当成主食')
  assert.equal(classify(['快手菜'], '面包机版吐司').category, '荤菜', '面包机不能被当成主食')
  assert.equal(classify([], '凉拌黄瓜').category, '素菜')
  assert.equal(classify(['家常菜', '热菜'], '红烧排骨').category, '荤菜')
  assert.equal(classify([], '某道没线索的菜').category, '荤菜', '无命中时默认荤菜')
  assert.equal(classify([], '红烧排骨').cuisine, '家常')
})

test('classify 优先采用源站分类名，源站没给才退回菜名规则', () => {
  // 真实踩过的样本：极速数据「素菜」类下的姜汁腐竹拌芹菜，光看菜名会被默认成荤菜
  assert.equal(classify([], '姜汁腐竹拌芹菜', '素菜').category, '素菜')
  assert.equal(classify([], '某道没线索的菜', '素菜').category, '素菜')
  assert.equal(classify([], '紫菜蛋花羹', '羹').category, '汤')
  assert.equal(classify([], '辣炒蛤蜊', '海鲜').category, '荤菜')
  assert.equal(classify([], '扬州炒饭', '炒饭').category, '主食')
  assert.equal(classify([], '刀切馒头', '馒头').category, '主食')
  // 源站分类没信息量（凉菜/热菜/家常菜）时不猜，仍按菜名规则判
  assert.equal(classify([], '凉拌黄瓜', '凉菜').category, '素菜')
  assert.equal(classify([], '红烧排骨', '热菜').category, '荤菜')
  // 源站分类与菜名冲突时以源站为准
  assert.equal(classify(['家常菜'], '红烧肉', '素菜').category, '素菜')
})

test('deriveCuisine 只在源站明确标注菜系时才写真实菜系，否则归家常', () => {
  assert.equal(deriveCuisine(['减肥', '川菜', '快手菜'], null), '川菜', '标签里的菜系也算数')
  assert.equal(deriveCuisine([], '粤菜'), '粤菜', '源站分类名是菜系时采用')
  assert.equal(deriveCuisine(['家常菜', '热菜'], null), '家常')
  assert.equal(deriveCuisine([], null), '家常')
  // 菜系树里混着的"减肥""烘焙"等非菜系项不能被当成菜系
  assert.equal(deriveCuisine([], '减肥'), '家常')
})

test('cleanDishName 只剥编辑性/人群性括号前缀，正常菜名不动', () => {
  assert.equal(cleanDishName('[原创首发]绿豆糕馅包子'), '绿豆糕馅包子')
  assert.equal(cleanDishName('（原创首发）排骨海带汤'), '排骨海带汤')
  assert.equal(cleanDishName('【美食】宫保鸡丁'), '宫保鸡丁')
  assert.equal(cleanDishName('【儿童美食】红薯发糕'), '红薯发糕')
  assert.equal(cleanDishName('  [转载] 红烧肉 '), '红烧肉')
  // 括号里是口味/做法/菜名本身时不剥（源站真实写法）
  assert.equal(cleanDishName('（微辣）鱼香肉丝'), '（微辣）鱼香肉丝')
  assert.equal(cleanDishName('【桂圆银耳羹】'), '【桂圆银耳羹】', '菜名在括号里，剥了就没名字了')
  assert.equal(cleanDishName('【红烧排骨】万用的炒糖上色法'), '【红烧排骨】万用的炒糖上色法')
  assert.equal(cleanDishName('红烧排骨'), '红烧排骨')
  assert.equal(cleanDishName('[原创首发]'), '[原创首发]', '剥完为空则保留原名')
})

test('deriveSpiciness 只依据源站标注，不臆造', () => {
  assert.equal(deriveSpiciness(['麻辣', '川菜']), 1)
  assert.equal(deriveSpiciness(['香辣']), 1)
  assert.equal(deriveSpiciness(['家常菜', '热菜']), 0)
  assert.equal(deriveSpiciness([]), 0)
})

test('原料解析：逗号对（聚合类）与空格对（uapis 类）都能拆出名称与用量', () => {
  assert.deepEqual(parseCommaPair('五花肉,500g'), { name: '五花肉', amount: '500g' })
  assert.deepEqual(parseCommaPair('盐,适量'), { name: '盐', amount: '适量' })
  assert.deepEqual(parseCommaPair(' 葱 '), { name: '葱', amount: '' })
  assert.equal(parseCommaPair('   '), null)

  assert.deepEqual(parseSpacePair('鸡蛋 3个'), { name: '鸡蛋', amount: '3个' })
  assert.deepEqual(parseSpacePair('番茄 500克'), { name: '番茄', amount: '500克' })
  assert.deepEqual(parseSpacePair('小许盐'), { name: '小许盐', amount: '' })
})

test('步骤去掉行首序号', () => {
  assert.equal(stripStepNumbering('1.把所有材料准备好。'), '把所有材料准备好。')
  assert.equal(stripStepNumbering('2、鸡蛋嗑进碗里'), '鸡蛋嗑进碗里')
  assert.equal(stripStepNumbering('①热锅下油'), '热锅下油')
  assert.equal(stripStepNumbering('热锅下油'), '热锅下油')
})

test('sourceRecipeId 稳定且带来源前缀', () => {
  const first = sourceRecipeId('upa', 'uapis:800024249')
  assert.equal(first, sourceRecipeId('upa', 'uapis:800024249'))
  assert.ok(first.startsWith('upa-'))
  assert.notEqual(first, sourceRecipeId('jum', 'uapis:800024249'))
})
