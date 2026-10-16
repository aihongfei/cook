import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { parseRecipeQuery, QUERY_TAGS_MAX, QUERY_TAG_MAX } from '../src/modules/recipes/recipe.query'

test('query defaults, trimmed filters and maximum pagination bounds', () => {
  // `mine` 是 F1-12 加的"只看自家上传的"开关，默认 false（= 全局库 + 自家的都看）
  assert.deepEqual(parseRecipeQuery({}), { q: undefined, category: undefined, cuisine: undefined, tags: undefined, page: 1, pageSize: 12, mine: false })
  assert.deepEqual(parseRecipeQuery({ q: ' 鸡蛋 ', category: '素菜', cuisine: '家常', page: '10000', pageSize: '100' }),
    { q: '鸡蛋', category: '素菜', cuisine: '家常', tags: undefined, page: 10000, pageSize: 100, mine: false })
  assert.deepEqual(parseRecipeQuery({ mine: '1' }).mine, true)
})

test('`mine` 只接受 1/true，别的一律 400（不把 `mine=false` 当成"要只看我的"）', () => {
  for (const bad of ['0', 'false', 'yes', '2', '']) {
    assert.throws(() => parseRecipeQuery({ mine: bad }), BadRequestException, `mine=${JSON.stringify(bad)} 应该被拒`)
  }
})

/**
 * `tag` 是发现页「时令精选」（按季节标签）与「换个场合挑」（按场合标签）要用的筛选。
 * 它必须**精确命中标签**，不能用 `q` 兜——`q` 搜的是 searchText（菜名+别名+标签+食材名），
 * 命中的是"文本里出现过这两个字"，而界面上那个数字（「秋日时令 · 38 道」）用户是拿来
 * 判断"值不值得点进去"的，它只能由"打了这个标签"给出（见 recipe.query 里 tagList 的注释；
 * 那里也记了 2026-10-16 实测"两者眼下恰好一致"这件事，免得后人以为有现成的反例）。
 */
test('tag：逗号分隔、去空白、去重，空串视为没给（不是"筛一个空标签"）', () => {
  assert.deepEqual(parseRecipeQuery({ tag: '秋季' }).tags, ['秋季'])
  assert.deepEqual(parseRecipeQuery({ tag: '秋季,秋季菜谱,秋季养生' }).tags, ['秋季', '秋季菜谱', '秋季养生'])
  assert.deepEqual(parseRecipeQuery({ tag: ' 秋季 , 夏季菜谱 ' }).tags, ['秋季', '夏季菜谱'])
  // 同一个标签给两遍不该变成两个条件（否则"最多 5 个"是个假上限）
  assert.deepEqual(parseRecipeQuery({ tag: '秋季,秋季' }).tags, ['秋季'])
  for (const empty of ['', '  ', ',,']) assert.equal(parseRecipeQuery({ tag: empty }).tags, undefined)
})

test('tag：给多了或给长了都是 400，不做静默截断', () => {
  // 静默截断最坏：界面以为筛了 6 个季节叫法、实际只筛了 5 个，数字对不上还查不出原因
  const tooMany = Array.from({ length: QUERY_TAGS_MAX + 1 }, (_, i) => `标签${i}`).join(',')
  assert.throws(() => parseRecipeQuery({ tag: tooMany }), BadRequestException)
  assert.equal(parseRecipeQuery({ tag: Array.from({ length: QUERY_TAGS_MAX }, (_, i) => `标签${i}`).join(',') }).tags?.length, QUERY_TAGS_MAX)
  assert.throws(() => parseRecipeQuery({ tag: 'x'.repeat(QUERY_TAG_MAX + 1) }), BadRequestException)
  // 数组形态（`?tag=a&tag=b`）不接受：口径是"一个字符串里逗号分隔"，两种都收会让调用方各写一套
  assert.throws(() => parseRecipeQuery({ tag: ['秋季', '夏季'] }), BadRequestException)
})

test('rejects invalid, duplicate, nested and excessive queries with 400', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e2', ' 1', '01', '9007199254740993', ['1', '2'], {}, 1]) {
    for (const key of ['page', 'pageSize']) assert.throws(() => parseRecipeQuery({ [key]: value }), BadRequestException)
  }
  for (const query of [{ page: '10001' }, { pageSize: '101' }, { q: ['a', 'b'] }, { q: {} }, { q: 'a'.repeat(101) }, { unknown: 'x' }]) assert.throws(() => parseRecipeQuery(query), BadRequestException)
})
