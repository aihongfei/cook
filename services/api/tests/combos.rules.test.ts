import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
  COMBO_ITEMS_MAX,
  COMBO_NAME_MAX,
  COMBO_NOTE_MAX,
  canEditCombo,
  parseComboName,
  parseComboNote,
  parseRecipeIds,
  planAdd,
} from '../src/modules/combos/combos.rules'

// 常用组合的纯规则（M4 / F4-04，口径见 D-029）。不碰数据库，也不起 MySQL。

// ---------- 名字与说明 ----------

test('组合名去首尾空格、不许空、有长度上限', () => {
  assert.equal(parseComboName('  快手三菜一汤  '), '快手三菜一汤')
  assert.equal(parseComboName('三'.repeat(COMBO_NAME_MAX)).length, COMBO_NAME_MAX)
  for (const bad of ['', '   ', null, undefined, 42, ['快手菜']]) {
    assert.throws(() => parseComboName(bad), BadRequestException, `${JSON.stringify(bad)} 应被拒`)
  }
  // 超一个字就拒（前端也有 maxLength，但后端不能靠前端把关）
  assert.throws(() => parseComboName('三'.repeat(COMBO_NAME_MAX + 1)), /最多 24 个字/)
})

test('说明可空；空白串归一成 null（不是空字符串）', () => {
  assert.equal(parseComboNote(undefined), null)
  assert.equal(parseComboNote(null), null)
  assert.equal(parseComboNote('   '), null)
  assert.equal(parseComboNote(' 工作日的晚上 '), '工作日的晚上')
  assert.throws(() => parseComboNote('长'.repeat(COMBO_NOTE_MAX + 1)), /最多 60 个字/)
})

// ---------- 菜列表 ----------

test('菜 id 去重保序：重复的自动去掉，不是报错', () => {
  // 用户连点两次同一道菜是常见的误操作，看到的应该是"重复的没了"而不是一句约束报错
  assert.deepEqual(parseRecipeIds(['a', 'b', 'a', ' c ', 'b']), ['a', 'b', 'c'])
  assert.deepEqual(parseRecipeIds([' a ']), ['a'])
})

test('菜列表：至少一道、最多 12 道、非法类型拒掉', () => {
  assert.deepEqual(parseRecipeIds(['a']), ['a'])
  assert.equal(parseRecipeIds(Array.from({ length: COMBO_ITEMS_MAX }, (_, i) => `r${i}`)).length, COMBO_ITEMS_MAX)
  assert.throws(() => parseRecipeIds([]), /至少要有 1 道菜/)
  assert.throws(() => parseRecipeIds(Array.from({ length: COMBO_ITEMS_MAX + 1 }, (_, i) => `r${i}`)), /最多 12 道菜/)
  assert.throws(() => parseRecipeIds('a,b'), /列表/)
  assert.throws(() => parseRecipeIds([1, 2]), /写成文字/)
  // 全空白 = 空列表（不是"一道叫空的菜"）
  assert.throws(() => parseRecipeIds(['  ', '']), /至少要有 1 道菜/)
})

// ---------- 一键加入：跳过已有的 ----------

test('一键加入跳过已经有的菜，不叠加份数（同一个组合点两次不会变样）', () => {
  const out = planAdd(['b', 'd'], ['a', 'b', 'c', 'd'])
  assert.deepEqual(out.toAdd, ['a', 'c'])
  assert.deepEqual(out.skipped, ['b', 'd'])

  // 幂等：再加一次（这一餐现在有 a b c d）→ 什么都不加
  const again = planAdd(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])
  assert.deepEqual(again.toAdd, [])
  assert.deepEqual(again.skipped, ['a', 'b', 'c', 'd'])
})

test('一键加入：这一餐是空的就整组都加', () => {
  const out = planAdd([], ['a', 'b'])
  assert.deepEqual(out.toAdd, ['a', 'b'])
  assert.deepEqual(out.skipped, [])
})

// ---------- 谁能改 ----------

test('组它的人与掌勺人/帮厨能改，别人不能（但人人都能用）', () => {
  assert.equal(canEditCombo('u1', 'u1', false), true, '自己组的')
  assert.equal(canEditCombo('u1', 'u2', true), true, '掌勺人/帮厨能打理家里的组合')
  assert.equal(canEditCombo('u1', 'u2', false), false, '别人组的、又没有管理权 → 不能改')
  // 只读不控：canEditCombo 只管"改/删"，"能不能一键加入"不在这里判定——
  // 那复用点菜权限（order.create），人人都有
})
