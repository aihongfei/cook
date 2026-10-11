#!/usr/bin/env node
/**
 * 菜谱接口 HTTP 验收（真实请求，不 mock）。
 * 用法：先启动服务，再执行 pnpm run test:http
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'

let failed = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function get(path) {
  const response = await fetch(`${base}${path}`)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

async function main() {
  const list = await get('/recipes?page=1&pageSize=12')
  check('列表 200 且结构为 items/total/page/pageSize', list.status === 200 && Array.isArray(list.body?.items) && typeof list.body?.total === 'number', `${list.status} total=${list.body?.total}`)

  const total = list.body?.total ?? 0
  check('总数 28、首页 12 条', total === 28 && list.body?.items?.length === 12, `total=${total} items=${list.body?.items?.length}`)

  const summary = list.body?.items?.[0] ?? {}
  const summaryKeys = ['id', 'name', 'image', 'category', 'cuisine', 'tags', 'calories', 'caloriesEstimated']
  check('摘要字段齐全（含 image/calories 可为 null）', summaryKeys.every(k => k in summary), Object.keys(summary).join(','))

  const page2 = await get('/recipes?page=2&pageSize=12')
  const ids1 = new Set((list.body?.items ?? []).map(r => r.id))
  const overlap = (page2.body?.items ?? []).filter(r => ids1.has(r.id))
  check('第二页 12 条且与第一页无重复', page2.status === 200 && page2.body?.items?.length === 12 && overlap.length === 0, `overlap=${overlap.length}`)

  const search = await get('/recipes?q=' + encodeURIComponent('鸡蛋') + '&page=1&pageSize=50')
  check('搜索“鸡蛋”能命中（菜名/配料/标签）', search.status === 200 && (search.body?.total ?? 0) > 0, `total=${search.body?.total}`)

  const alias = await get('/recipes?q=' + encodeURIComponent('番茄炒鸡') + '&page=1&pageSize=50')
  check('别名/近似词“番茄炒鸡”命中西红柿炒鸡蛋', alias.status === 200 && (alias.body?.items ?? []).some(r => r.name === '西红柿炒鸡蛋'), `total=${alias.body?.total}`)

  const filtered = await get('/recipes?category=' + encodeURIComponent('素菜') + '&cuisine=' + encodeURIComponent('家常') + '&page=1&pageSize=12')
  check('品类+菜系交叉筛选（素菜/家常 = 7）', filtered.status === 200 && filtered.body?.total === 7, `total=${filtered.body?.total}`)

  const filters = await get('/recipes/filters')
  check('筛选选项返回 4 个品类与菜系', filters.status === 200 && filters.body?.categories?.length === 4 && Array.isArray(filters.body?.cuisines), JSON.stringify(filters.body))

  const empty = await get('/recipes?q=' + encodeURIComponent('不存在的菜') + '&page=1&pageSize=12')
  check('无结果返回 200 且 total=0', empty.status === 200 && empty.body?.total === 0, `total=${empty.body?.total}`)

  const targetId = summary.id
  const detail = targetId ? await get(`/recipes/${encodeURIComponent(targetId)}`) : { status: 0, body: null }
  const detailKeys = ['ingredients', 'steps', 'notes', 'aliases', 'spiciness', 'videoUrl', 'source']
  check('详情返回配料/步骤/来源等字段', detail.status === 200 && detailKeys.every(k => k in (detail.body ?? {})), `${detail.status}`)
  check('详情配料与步骤非空', (detail.body?.ingredients?.length ?? 0) > 0 && (detail.body?.steps?.length ?? 0) > 0, `ingredients=${detail.body?.ingredients?.length} steps=${detail.body?.steps?.length}`)
  check('来源标注含许可与固定 commit', detail.body?.source?.license === 'Unlicense' && /^[0-9a-f]{40}$/.test(detail.body?.source?.commit ?? ''), JSON.stringify(detail.body?.source))

  const missing = await get('/recipes/definitely-missing-id')
  check('未知 id 返回 404', missing.status === 404, `${missing.status}`)

  for (const [label, path] of [
    ['page=0', '/recipes?page=0'],
    ['page=99999', '/recipes?page=99999'],
    ['pageSize=1000', '/recipes?pageSize=1000'],
    ['page 重复', '/recipes?page=1&page=2'],
    ['未知参数', '/recipes?unknown=1'],
  ]) {
    const bad = await get(path)
    check(`非法查询被拒（${label}）返回 400`, bad.status === 400, `${bad.status}`)
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.detail ?? ''}]`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('验收脚本自身失败：', error)
  process.exit(2)
})
