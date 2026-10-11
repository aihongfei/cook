import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { parseRecipeQuery } from '../src/modules/recipes/recipe.query'

test('query defaults, trimmed filters and maximum pagination bounds', () => {
  assert.deepEqual(parseRecipeQuery({}), { q: undefined, category: undefined, cuisine: undefined, page: 1, pageSize: 12 })
  assert.deepEqual(parseRecipeQuery({ q: ' 鸡蛋 ', category: '素菜', cuisine: '家常', page: '10000', pageSize: '100' }), { q: '鸡蛋', category: '素菜', cuisine: '家常', page: 10000, pageSize: 100 })
})

test('rejects invalid, duplicate, nested and excessive queries with 400', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e2', ' 1', '01', '9007199254740993', ['1', '2'], {}, 1]) {
    for (const key of ['page', 'pageSize']) assert.throws(() => parseRecipeQuery({ [key]: value }), BadRequestException)
  }
  for (const query of [{ page: '10001' }, { pageSize: '101' }, { q: ['a', 'b'] }, { q: {} }, { q: 'a'.repeat(101) }, { unknown: 'x' }]) assert.throws(() => parseRecipeQuery(query), BadRequestException)
})
