import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { FAVORITES_MAX, canFavorite, parseRecipeId } from '../src/modules/favorites/favorites.rules'

// 收藏（M1 / F1-09）的纯规则。收藏本身很简单（是/不是），
// 值得钉死的是两个"以后一定会问"的点：id 校验、以及到上限时的处置（拒绝，不顶掉最早的）。

test('菜谱 id：非空字符串，两端空白去掉', () => {
  assert.equal(parseRecipeId('  jis-abc  '), 'jis-abc')
  assert.equal(parseRecipeId('x'), 'x')
})

test('菜谱 id：非字符串、空串、纯空白、超长都要报 400', () => {
  assert.throws(() => parseRecipeId(42), BadRequestException)
  assert.throws(() => parseRecipeId(undefined), BadRequestException)
  assert.throws(() => parseRecipeId(null), BadRequestException)
  assert.throws(() => parseRecipeId(''), BadRequestException)
  assert.throws(() => parseRecipeId('   '), BadRequestException)
  assert.throws(() => parseRecipeId('x'.repeat(65)), BadRequestException)
})

test('没到上限可以继续收藏', () => {
  assert.equal(canFavorite(0, false), true)
  assert.equal(canFavorite(FAVORITES_MAX - 1, false), true)
})

test('到上限就拒绝（不悄悄顶掉更早收藏的那道）', () => {
  assert.equal(canFavorite(FAVORITES_MAX, false), false)
  assert.equal(canFavorite(FAVORITES_MAX + 5, false), false)
})

test('已收藏过的那道**永远放行**：否则收藏满的人连取消都做不了', () => {
  // 这一条是真正的坑：到上限时点一颗已收藏的心是想"取消"，若被上限拦下，
  // 用户会发现"收藏满了之后连取消都不行"——而取消本该是减法，不受上限约束。
  assert.equal(canFavorite(FAVORITES_MAX, true), true)
  assert.equal(canFavorite(FAVORITES_MAX + 5, true), true)
})
