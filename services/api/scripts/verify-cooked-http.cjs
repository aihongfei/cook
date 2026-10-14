#!/usr/bin/env node
/**
 * 「我做过」+ 权限放开的验收（M9 / F9-01，见 D-075）。真实请求，不 mock。
 *
 * 用法：先启动服务，再执行 pnpm run test:http:cooked
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 这一份**自带全部前置数据**（自己注册、建家庭、两个人），不依赖别的验收留下的东西。
 *
 * 覆盖（每一条都对应 D-075 的一句结论）：
 * ① 未登录 401；
 * ② **吃货（EATER）能点「做好了」**——这是用户要的那条（"家庭任何人都可以点击做好"）；
 * ③ 但吃货**推不动别的状态**（选好了 / 开始做 / 取消）——放开的是一个 key，不是一批；
 * ④ **谁点的就是谁掌勺的**：同一道菜，爸爸点的那份只有爸爸的「我做过」里有，
 *    妈妈的没有（`OrderItem.userId` 这条记录一直都有，不需要新字段）；
 * ⑤ 计次按**餐**去重：同一餐里点两份同一道菜 → 做过 1 次（不是 2 次）；
 * ⑥ 只有**已做好**的餐才算：安排了没做的、取消的都不算；
 * ⑦ 那行字由后端拼（"做过 N 次 · 最近 …"），且**最近的那次排在最前**；
 * ⑧ 报出 `total`（不是只报返回了几条）。
 *
 * ⚠️ 「做好了」是**终态**：本脚本的餐次只往前推，不回头。
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

/** 限流（60 次/分钟）会返回 429：等到它说的秒数再重试，别把 429 当数据读 */
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

/** 注册一个账号并返回 token */
async function register(tag) {
  const account = `${tag}${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 100)}`
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: tag },
  })
  if (!registered.body?.token) {
    console.error('注册失败：', registered.status, JSON.stringify(registered.body))
    process.exit(1)
  }
  return { token: registered.body.token, userId: registered.body.user?.id, account }
}

async function main() {
  const stamp = String(Date.now()).slice(-6)
  const mama = await register(`mama${stamp}`)
  const baba = await register(`baba${stamp}`)

  // 妈妈建家，爸爸用邀请码进来当**吃货**（默认角色就是 EATER）
  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '我做过试家' } })
  check('前置：建家庭', family.status === 201, `status=${family.status}`)
  const invite = family.body?.inviteCode
  const joined = await callWithRetry('POST', '/family/join', { token: baba.token, body: { inviteCode: invite } })
  check('前置：爸爸以**吃货**身份加入（默认角色）', joined.status === 200 && joined.body?.myRole === 'EATER', `status=${joined.status} role=${joined.body?.myRole}`)

  // 权限：爸爸的能力表里应当有 menu.confirm（放开的那一个），且确实没有 menu.manage
  const caps = joined.body?.myCapabilities ?? []
  check('吃货的能力表：有 `menu.confirm`（能标做好了）', caps.includes('menu.confirm'), caps.join(','))
  check('吃货的能力表：没有 `menu.manage`（安排/取消/开始做仍不行）', !caps.includes('menu.manage'), caps.join(','))

  // ---------- ② 吃货能标「做好了」 ----------
  const dishes = (await callWithRetry('GET', '/recipes?page=1', { token: mama.token })).body?.items ?? []
  const recipe = dishes.find((row) => row.id)
  check('前置：库里有菜谱可点', Boolean(recipe), recipe?.name ?? '(没有)')

  const dinnerKey = `${dateKey(0)}-DINNER`
  const addByBaba = await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: recipe.id, mealDate: dateKey(0), meal: 'DINNER' },
  })
  check('前置：爸爸点一道菜', addByBaba.status === 201, `status=${addByBaba.status}`)

  // 爸爸这条推进链的前两步都不该能动（那要 menu.manage）
  const babaPlan = await callWithRetry('POST', `/orders/meals/${dinnerKey}/status`, {
    token: baba.token,
    body: { status: 'PLANNED' },
  })
  check('② 吃货**推不动**「选好了」（那是 menu.manage）', babaPlan.status === 403, `status=${babaPlan.status} msg=${babaPlan.body?.message}`)

  // 妈妈按正常流程推到 COOKING（她掌勺）
  await callWithRetry('POST', `/orders/meals/${dinnerKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  const cooking = await callWithRetry('POST', `/orders/meals/${dinnerKey}/status`, {
    token: mama.token,
    body: { status: 'COOKING' },
  })
  check('前置：妈妈把这一餐推到「准备中」', cooking.status === 201 || cooking.status === 200, `status=${cooking.status}`)

  // 这一步是这次改动的**核心断言**：吃货点得动「做好了」
  const babaDone = await callWithRetry('POST', `/orders/meals/${dinnerKey}/status`, {
    token: baba.token,
    body: { status: 'DONE' },
  })
  check('② **吃货点得动「做好了」**（用户要的"家庭任何人都可以点击做好"）', babaDone.status === 201 || babaDone.status === 200, `status=${babaDone.status} msg=${babaDone.body?.message ?? ''}`)
  check('② 这一餐真的变成已做好', babaDone.body?.status === 'DONE', `status=${babaDone.body?.status}`)

  // ---------- ④ 谁点的就是谁掌勺的 ----------
  const babaCooked = (await callWithRetry('GET', '/discover/cooked', { token: baba.token })).body
  const mamaCooked = (await callWithRetry('GET', '/discover/cooked', { token: mama.token })).body
  check(
    '④ **爸爸点的 → 出现在爸爸的「我做过」里**（谁点的就是谁掌勺的）',
    (babaCooked?.items ?? []).some((row) => row.id === recipe.id),
    `爸爸 ${babaCooked?.items?.length ?? 0} 道：${(babaCooked?.items ?? []).map((row) => row.name).join('、') || '(空)'}`,
  )
  check(
    '④ **妈妈没点这道 → 她的「我做过」里没有**（记录认的是点菜人）',
    !(mamaCooked?.items ?? []).some((row) => row.id === recipe.id),
    `妈妈 ${mamaCooked?.items?.length ?? 0} 道：${(mamaCooked?.items ?? []).map((row) => row.name).join('、') || '(空)'}`,
  )

  // ---------- ⑤ 计次按餐去重 ----------
  const babaRow = (babaCooked?.items ?? []).find((row) => row.id === recipe.id)
  check('⑤ 同一餐里再点一份同一道菜 → 仍算**做过 1 次**（按餐去重，不按份）', babaRow?.cooked === 1, `cooked=${babaRow?.cooked}`)
  check('⑤ 那行字由后端拼（"做过 N 次 · 最近 …"）', typeof babaRow?.cookedLabel === 'string' && /^做过 \d+ 次/.test(babaRow.cookedLabel), `cookedLabel=${JSON.stringify(babaRow?.cookedLabel)}`)
  check('⑦ 最近那次就是今天（刚推的 DONE）', /今天/.test(babaRow?.cookedLabel ?? ''), babaRow?.cookedLabel ?? '(空)')
  check('⑧ 报出 total（不是只报返回了几条）', typeof babaCooked?.total === 'number' && babaCooked.total >= 1, `total=${babaCooked?.total}`)

  // ---------- ⑥ 没做好的不算 ----------
  const tomorrowLunch = `${dateKey(1)}-LUNCH`
  await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: recipe.id, mealDate: dateKey(1), meal: 'LUNCH' },
  })
  const before = (await callWithRetry('GET', '/discover/cooked', { token: baba.token })).body
  const beforeRow = (before?.items ?? []).find((row) => row.id === recipe.id)
  check(
    '⑥ 只点了、还没做的 → 次数**不变**（"安排了"不算"做过"）',
    beforeRow?.cooked === 1,
    `cooked=${beforeRow?.cooked}（点了明天午餐但没推 DONE）`,
  )

  // ---------- ⑦ 最近做的排最前 ----------
  // 换一道菜，走完 待确认→已安排→准备中→已做好，然后看它的顺序
  const second = dishes.find((row) => row.id !== recipe.id)
  if (second) {
    const nextKey = `${dateKey(0)}-LUNCH`
    await callWithRetry('POST', '/orders/items', {
      token: baba.token,
      body: { recipeId: second.id, mealDate: dateKey(0), meal: 'LUNCH' },
    })
    await callWithRetry('POST', `/orders/meals/${nextKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
    await callWithRetry('POST', `/orders/meals/${nextKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
    await callWithRetry('POST', `/orders/meals/${nextKey}/status`, { token: baba.token, body: { status: 'DONE' } })
    const after = (await callWithRetry('GET', '/discover/cooked', { token: baba.token })).body
    check(
      '⑦ 两道都做过时，**各一条、次数都是 1**（不同菜不互相影响）',
      (after?.items ?? []).length === 2 && (after?.items ?? []).every((row) => row.cooked === 1),
      `items=${(after?.items ?? []).map((row) => `${row.name}:${row.cooked}`).join('、')}`,
    )
    check('⑧ total 跟着变', after?.total === 2, `total=${after?.total}`)
  } else {
    check('⑦ 库里的菜够做第二道（跳过这条）', false, '库里只有一道菜')
  }

  // ---------- ① 未登录 ----------
  const anon = await call('GET', '/discover/cooked')
  check('① 未登录 → 401', anon.status === 401, `status=${anon.status}`)

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
