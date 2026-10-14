#!/usr/bin/env node
/**
 * 「某一餐的详情」验收（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
 * 真实请求，不 mock。
 *
 * 用法：先启动服务，再执行 pnpm run test:http:meal-detail
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 自带全部前置数据（自己注册、建家庭、两个人），不依赖别的验收留下的东西。
 *
 * 覆盖：
 * ① 未登录 401；形状不对的 mealKey → 400；没点过的那一餐 → 404；
 * ② 详情与列表**同一张卡**（同一份口径，不是"大致一样"）；
 * ③ 逐份的清单在：同一道菜两人各点一份 → `items` 两条、各带各自的备注与点单人
 *    （摘要把它合并成 ×2，所以这是详情存在的理由，必须验）；
 * ④ **谁定的 / 谁做的分开**：妈妈定菜单、爸爸标「做好了」→ 两个留痕各是各的；
 * ⑤ **可见性与列表一字不差**：共享关掉后，吃货取自己没参与的那一餐
 *    → 与列表一致地不给他看（列表里没有它，直接取也不能有）；
 * ⑥ 路由不吃掉同层的静态路径：`/orders/today`、`/orders/plan`、`/orders/history`
 *    仍然各自可用（`:mealKey` 若排在前头会把它们当成一餐）。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'

let failed = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const contentType = response.headers.get('content-type') ?? ''
  let parsed = null
  if (contentType.includes('application/json')) {
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
  }
  return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 限流（60 次/分钟）返回 429：等到它说的秒数再重试，别把 429 当数据读 */
async function callWithRetry(method, path, options = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await call(method, path, options)
    if (result.status !== 429) return result
    const wait = Math.min(Number(result.retryAfter ?? 5) + 1, 70)
    console.log(`⏳ 触发限流，等待 ${wait}s 后重试…`)
    await sleep(wait * 1000)
  }
  throw new Error(`重试多次仍是 429：${method} ${path}`)
}

function dateKey(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86_400_000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function register(tag) {
  const account = `${tag}${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 100)}`
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: tag },
  })
  if (!registered.body?.token) {
    console.error('注册失败：', registered.status, JSON.stringify(registered.body))
    process.exit(1)
  }
  return { token: registered.body.token, account }
}

async function main() {
  const stamp = String(Date.now()).slice(-6)
  const mama = await register(`mama${stamp}`)
  const baba = await register(`baba${stamp}`)
  const aunt = await register(`aunt${stamp}`)

  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '详情试家' } })
  check('前置：建家庭', family.status === 201, `status=${family.status}`)
  const invite = family.body?.inviteCode
  await callWithRetry('POST', '/family/join', { token: baba.token, body: { inviteCode: invite } })
  await callWithRetry('POST', '/family/join', { token: aunt.token, body: { inviteCode: invite } })
  check('前置：爸爸与姑姑都以吃货身份加入', true, '两人 EATER')

  const dishes = (await callWithRetry('GET', '/recipes?page=1', { token: mama.token })).body?.items ?? []
  const first = dishes.find((row) => row.id)
  const second = dishes.find((row) => row.id !== first?.id)
  check('前置：库里有两道菜可点', Boolean(first && second), `${first?.name ?? '?'} / ${second?.name ?? '?'}`)

  // 爸爸点第一道；妈妈也点第一道（**同一道菜两人点**）——这是摘要合并、详情必须能拆开的那一条
  const mealKey = `${dateKey(1)}-DINNER`
  const mealDate = dateKey(1)
  const addByBaba = await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: first.id, mealDate, meal: 'DINNER', note: '少放辣' },
  })
  check('前置：爸爸点一道（带备注）', addByBaba.status === 201, `status=${addByBaba.status}`)
  const addByMama = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: first.id, mealDate, meal: 'DINNER', note: '多放汤' },
  })
  check('前置：妈妈也点**同一道**（各一份）', addByMama.status === 201, `status=${addByMama.status}`)

  // ---------- ① 未登录 / 坏 key / 不存在 ----------
  const anon = await call('GET', `/orders/${mealKey}`)
  check('① 未登录 → 401', anon.status === 401, `status=${anon.status}`)
  const badKey = await callWithRetry('GET', '/orders/不是一餐', { token: mama.token })
  check('① 形状不对的 mealKey → 400', badKey.status === 400, `status=${badKey.status} msg=${badKey.body?.message}`)
  const missing = await callWithRetry('GET', `/orders/${dateKey(5)}-LUNCH`, { token: mama.token })
  check('① 没点过的那一餐 → 404', missing.status === 404, `status=${missing.status}`)

  // ---------- ② 详情与列表是同一张卡 ----------
  const list = await callWithRetry('GET', '/orders?family=true', { token: mama.token })
  const inList = (list.body?.cards ?? []).find((card) => card.mealKey === mealKey)
  const detail = await callWithRetry('GET', `/orders/${mealKey}`, { token: mama.token })
  check('② 详情取得到', detail.status === 200, `status=${detail.status}`)
  check(
    '② 与列表里那张卡是**同一个形状同一份口径**（逐字段比对）',
    JSON.stringify(detail.body) === JSON.stringify(inList),
    `列表 ${inList ? '有' : '无'}；不一致字段：${
      inList
        ? Object.keys(detail.body ?? {})
            .filter((key) => JSON.stringify(detail.body[key]) !== JSON.stringify(inList[key]))
            .join('、') || '（无）'
        : 'n/a'
    }`,
  )

  // ---------- ③ 逐份清单：同一道菜两人各一条 ----------
  const mine = (detail.body?.items ?? []).filter((item) => item.recipeId === first.id)
  check('③ 同一道菜出现**两条逐份记录**（摘要合并成 ×2，详情要拆得开）', mine.length === 2, `条数=${mine.length}`)
  check(
    '③ 两条各带各自的备注',
    mine.some((item) => item.note === '少放辣') && mine.some((item) => item.note === '多放汤'),
    mine.map((item) => `${item.nickname}:${item.note}`).join(' | '),
  )
  check(
    '③ 两条各带点单人',
    new Set(mine.map((item) => item.nickname)).size === 2,
    mine.map((item) => item.nickname).join('、'),
  )
  check(
    '③ 摘要那一行仍是合并的 ×2（两张视图的分工没串）',
    (detail.body?.dishes ?? []).find((line) => line.recipeId === first.id)?.count === 2,
    `count=${(detail.body?.dishes ?? []).find((line) => line.recipeId === first.id)?.count}`,
  )

  // ---------- ④ 谁定的 / 谁做的分开 ----------
  await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  // 爸爸标「做好了」（吃货可点，D-075）
  const done = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, {
    token: baba.token,
    body: { status: 'DONE' },
  })
  check('前置：爸爸把这一餐标成「做好了」', done.status === 200, `status=${done.status}`)
  const after = await callWithRetry('GET', `/orders/${mealKey}`, { token: mama.token })
  check(
    '④ 「谁定的」是妈妈',
    after.body?.confirmedBy?.nickname === 'mama' || after.body?.confirmedBy?.nickname?.includes('mama'),
    `confirmedBy=${after.body?.confirmedBy?.nickname}`,
  )
  check(
    '④ 「谁做的」是爸爸（**不是**定菜单那个人）',
    after.body?.doneBy?.nickname?.includes('baba'),
    `doneBy=${after.body?.doneBy?.nickname}`,
  )
  check('④ 两个时刻都在', Boolean(after.body?.confirmedAt && after.body?.doneAt), `${after.body?.confirmedAt} / ${after.body?.doneAt}`)

  // ---------- ⑤ 可见性与列表一字不差 ----------
  // 造一餐**只有爸爸参与**的（姑姑没点）→ 关掉共享后，姑姑的列表里没有它，直接取也不能有
  const privateKey = `${dateKey(2)}-LUNCH`
  await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: second.id, mealDate: dateKey(2), meal: 'LUNCH' },
  })
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })

  const auntList = await callWithRetry('GET', '/orders?family=true', { token: aunt.token })
  const inAuntList = (auntList.body?.cards ?? []).some((card) => card.mealKey === privateKey)
  const auntDetail = await callWithRetry('GET', `/orders/${privateKey}`, { token: aunt.token })
  check('⑤ 前置：共享关掉后那一餐不在姑姑的列表里', inAuntList === false, `列表里有=${inAuntList}`)
  check(
    '⑤ 她直接取详情也拿不到（**详情不放行列表不给的东西**）',
    auntDetail.status === 404,
    `status=${auntDetail.status}`,
  )
  const babaDetail = await callWithRetry('GET', `/orders/${privateKey}`, { token: baba.token })
  check('⑤ 但点过它的爸爸取得到（收窄只收窄到"我参与的"）', babaDetail.status === 200, `status=${babaDetail.status}`)
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

  // ---------- ⑥ 同层的静态路径没被吃掉 ----------
  const today = await callWithRetry('GET', '/orders/today', { token: mama.token })
  const plan = await callWithRetry('GET', '/orders/plan', { token: mama.token })
  const history = await callWithRetry('GET', '/orders/history', { token: mama.token })
  const options = await callWithRetry('GET', '/orders/options')
  check(
    '⑥ `/orders/today` 没被 `:mealKey` 吃掉（这条一旦挂了就是路由顺序错）',
    today.status === 200 && Array.isArray(today.body?.rows),
    `status=${today.status}`,
  )
  check('⑥ `/orders/plan` 正常', plan.status === 200 && Array.isArray(plan.body?.days), `status=${plan.status}`)
  check('⑥ `/orders/history` 正常', history.status === 200 && Array.isArray(history.body?.days), `status=${history.status}`)
  check('⑥ `/orders/options` 正常（免登录）', options.status === 200 && Array.isArray(options.body?.meals), `status=${options.status}`)

  for (const row of results) {
    console.log(`${row.ok ? '✅' : '❌'} ${row.name}  — ${row.detail}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验收脚本自己出错了：', error)
  process.exit(1)
})
