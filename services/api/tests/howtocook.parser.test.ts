import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHowToCook } from '../src/modules/recipes/howtocook.parser'

test('parses headings, quantities, nested steps and tools without dropping source text', () => {
  const recipe = parseHowToCook(`# 测试菜的做法\n\n## 必备原料和工具\n- 土豆\n- 菜刀\n\n## 计算\n按照 2 份：\n- 土豆 200g\n\n## 操作\n### 准备\n1. 洗净土豆。\n2. 切块。\n### 烹饪\n1. 入锅 5 分钟。\n\n## 附加内容\n- 可按口味调整。`, 'dishes/vegetable_dish/测试菜.md', '3dfa950f6daf0a5b311fc46619f1b559bac980c4')
  assert.equal(recipe.name, '测试菜')
  assert.deepEqual(recipe.tools, ['菜刀'])
  assert.equal(recipe.ingredients[0].name, '土豆')
  assert.match(recipe.ingredients[0].amount, /200g/)
  assert.equal(recipe.steps.length, 5)
  assert.ok(recipe.steps.some(step => step.includes('【准备】')))
  assert.ok(recipe.notes.some(note => note.includes('2 份')))
})

test('keeps missing calories null and preserves formula quantities', () => {
  const recipe = parseHowToCook(`# 无热量菜的做法\n## 必备原料和工具\n- 面粉\n## 计算\n- 面粉 = 份数 * 100g\n## 操作\n1. 和面。`, 'dishes/staple/无热量菜.md', '3dfa950f6daf0a5b311fc46619f1b559bac980c4')
  assert.equal(recipe.calories, null)
  assert.equal(recipe.caloriesEstimated, false)
  assert.match(recipe.ingredients[0].amount, /份数/)
})

test('supports setext headings, alternative labels, tool sections and nested step bullets', () => {
  const markdown = `示例菜的做法\n===\n预估卡路里：100 大卡\n\n食材\n---\n+ 鸡蛋\n\n工具\n---\n* 碗\n\n用量\n---\n* 两个鸡蛋\n每份可供两人。\n\n步骤\n---\n1. 搅拌。\n   - 注意不要过度搅拌。\n   继续一分钟。\n2. 煮熟。\n\n备注\n---\n量按原文。`
  const recipe = parseHowToCook(markdown, 'dishes/soup/示例菜.md')
  assert.deepEqual(recipe.tools, ['碗'])
  assert.equal(recipe.ingredients.length, 1)
  assert.equal(recipe.ingredients[0].amount, '两个')
  assert.equal(recipe.steps.length, 2)
  assert.match(recipe.steps[0], /过度搅拌/)
  assert.match(recipe.steps[0], /继续一分钟/)
  assert.ok(recipe.notes.some(n => n.includes('每份可供两人')))
  assert.equal(recipe.calories, 100)
  assert.equal(recipe.caloriesEstimated, true)
  assert.equal(recipe.rawMarkdown, markdown)
})

test('heading depth preserves material and cooking subgroups', () => {
  const recipe = parseHowToCook(`# 分组菜的做法\n### 材料\n#### 主料\n* 米\n### 数量\n* 米 200g\n### 制作方法\n#### 第一阶段\n1. 洗米\n#### 第二阶段\n1. 煮饭\n### 小贴士\n不要烫伤。`, 'dishes/staple/分组菜.md')
  assert.equal(recipe.ingredients[0].name, '米')
  assert.equal(recipe.ingredients[0].amount, '200g')
  assert.equal(recipe.steps.length, 4)
  assert.ok(recipe.notes.some(n => n.includes('不要烫伤')))
})
