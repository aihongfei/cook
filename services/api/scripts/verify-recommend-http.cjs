#!/usr/bin/env node
/**
 * 首页「菜谱推荐」的 HTTP 验收（D-071，用户 2026-10-14 报的第三件事）。
 *
 * 用法：`pnpm --dir services/api run test:http:recommend`
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 用户的原话：「首页的菜谱推荐现在固定那几样了，能不能随机一些呢，
 * 根据个人习惯、口味等进行推荐」。原实现是直接调 `GET /recipes`（按 `name ASC` 的第 1 页
 * 取前 6 条），所以**每次进首页都是同样六道**——"固定那几样"是准确的描述，不是错觉。
 *
 * 这一组盯住三件事：
 * ① **每次不一样**（至少在这几次调用里能看出差别）——这是用户报的那一条；
 * ② **但也不是随机撒**：多次调用见到的菜数远小于全库（只在分数靠前的那一池里抽）；
 * ③ **个性化真的接上了**：收藏过的菜会被推上来，且 `favorites` 计数跟着走。
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'
const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

let failed = 0
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) failed += 1 }

async function main() {
  const stamp = `${Date.now()}`.slice(-9)
  const account = `rec${stamp}`.toLowerCase()
  const reg = await call('POST', '/auth/register', { body: { account, password: 'cook2026pass', nickname: '推荐测试' } })
  if (reg.status !== 201) throw new Error(`注册失败 ${reg.status} ${JSON.stringify(reg.body)}`)
  const token = reg.body.token

  const noFamily = await call('GET', '/discover/recommend', { token })
  check('没加入家庭 → 404 中文话术（不是 500）', noFamily.status === 404 && /家庭/.test(String(noFamily.body?.message ?? '')), `status=${noFamily.status} msg=${String(noFamily.body?.message ?? '').slice(0, 20)}`)

  await call('POST', '/family', { token, body: { name: '推荐之家' } })

  const first = await call('GET', '/discover/recommend?count=6', { token })
  check('① 返回 6 道', first.status === 200 && first.body?.items?.length === 6, `status=${first.status} n=${first.body?.items?.length}`)
  check('① 每道都带卡片要的字段（DishCard 能直接画）', (first.body?.items ?? []).every((d) => d.id && d.name && 'origin' in d && 'sourceLabel' in d && 'mine' in d && Array.isArray(d.tags)), JSON.stringify((first.body?.items ?? [])[0] ?? {}).slice(0, 120))

  // ② 多次调用应当不完全一样（这就是用户要的"随机一些"）
  const seen = new Set()
  const sets = []
  for (let i = 0; i < 8; i += 1) {
    const r = await call('GET', '/discover/recommend?count=6', { token })
    const ids = (r.body?.items ?? []).map((d) => d.id)
    const key = ids.join(',')
    sets.push(key)
    ids.forEach((id) => seen.add(id))
    if (!r.body?.fridgeEmpty) check('② fridgeEmpty 在没记冰箱时是 true', false, `fridgeEmpty=${r.body?.fridgeEmpty}`)
  }
  check('② 8 次调用不是同一屏（"固定那几样"已修）', new Set(sets).size > 1, `8 次里 ${new Set(sets).size} 种不同组合`)
  check('② 但也不是随便撒（见过的 id 数远小于全库 600+）', seen.size <= 40, `8 次共出现 ${seen.size} 道不同的菜`)

  // ③ 收藏过的菜会被推上来
  const favTarget = (first.body?.items ?? [])[0]
  // 收藏是 POST /favorites/toggle + `{recipeId}`（不是 POST /favorites/:id）
  const fav = await call('POST', '/favorites/toggle', { token, body: { recipeId: favTarget.id } })
  check('前置：收藏这道菜', fav.status < 300, `status=${fav.status}`)
  let favHits = 0
  for (let i = 0; i < 6; i += 1) {
    const r = await call('GET', '/discover/recommend?count=6', { token })
    const hit = (r.body?.items ?? []).find((d) => d.id === favTarget.id)
    if (hit && hit.favorites > 0) favHits += 1
  }
  check('③ 收藏过的菜真的被推上来（而且 favorites 计数跟着走）', favHits > 0, `6 次里命中 ${favHits} 次`)

  // ④ 参数校验
  const bad = await call('GET', '/discover/recommend?count=999', { token })
  check('④ count 越界 → 400 中文话术', bad.status === 400 && /1～18/.test(String(bad.body?.message ?? '')), `status=${bad.status} msg=${String(bad.body?.message ?? '').slice(0, 30)}`)

  // ⑤ 未登录不可用（个性化要家庭，不能匿名拿）
  const anon = await fetch(`${BASE}/discover/recommend?count=6`)
  check('⑤ 未登录 → 401（个性化是"这家人"的事，不是公共读）', anon.status === 401, `status=${anon.status}`)

  for (const item of results) console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}
void main().catch((e) => { console.error(e); process.exitCode = 1 })
