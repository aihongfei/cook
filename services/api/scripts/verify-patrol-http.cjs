#!/usr/bin/env node
/**
 * 后台巡查的验收（M10 交付三，见 D-081）。真实请求，不 mock。
 *
 * 用法：先启动服务，再执行 pnpm run test:http:patrol
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 这一份**自带全部前置数据**（自己注册、建家庭、两个人），不依赖别的验收留下的东西。
 *
 * 覆盖（每一条都对应 D-081 或 patrol.rules 的一句结论）：
 * ① 领令牌**要登录态**；没登录领不到（401）；
 * ② 领到的令牌**能用**去巡查（200），而**换个乱写的令牌不行**（401，对照）；
 * ③ **登录令牌不能当巡查令牌用**（两种凭据不通用，这条是防止"顺手复用"的对照）；
 * ④ **第一次巡查（不带 since）一条都不弹**，但会把水位线立起来（`since` 非空）；
 * ⑤ 之后**新发生的事**会被弹出来：爸爸点菜 → 妈妈那边查得到那条；
 * ⑥ **弹过的不会重复弹**：拿返回的 `since` 再查一次 → 0 条（这条最关键，
 *    重复弹会让用户关掉通知权限，连正常的提醒也一起没了）；
 * ⑦ **自己的事不弹给自己**（自己定的菜单不在自己的列表里，与交付一同一条口径）；
 * ⑧ 上限：一次最多 3 条（`items.length <= 3`）；
 * ⑨ **退出登录会吊销巡查令牌**（退出后那枚令牌立刻 401）——这是"没退干净"的防线；
 * ⑩ **两台设备各留各的**：同一账号两个 deviceId 各领一枚、**两枚同时有效**
 *    （第一版按账号唯一，第二台一登录就把第一台静默废掉，所以这条是对照性断言）；
 * ⑪ 边界：不带 deviceId 领 → 400。
 *
 * ⚠️ 与交付一同一条教训：**每一步都要看状态码**。点菜有窗口（7 天），
 * 造餐落在窗口外会 400，而"没产生提醒"会被误读成巡查坏了。
 *
 * ⚠️ 巡查接口是**无状态**的：水位线（`since`）由手机每次带上来。本脚本第一版
 * 第二次查询时漏了 `?since=`，于是被当成"第一次巡查"、一条都不弹——
 * **脚本报的是"实现坏了"，其实是断言写错了**。带上 `since` 才是在验"新事会弹"。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'

let failed = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function call(method, path, { body, token, patrol } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  // 巡查令牌走自己的头（不是 Authorization：那条留给登录令牌，两者不通用）
  if (patrol) headers['x-patrol-token'] = patrol
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

/** 找几个点菜窗口内、还没安排过的空餐次（不猜日期，从接口现查） */
function freeSlots(cards, count) {
  const taken = new Set((cards ?? []).filter((c) => c.status !== 'CANCELED').map((c) => c.mealKey))
  const slots = []
  for (let offset = 0; offset <= 6; offset += 1) {
    for (const meal of ['LUNCH', 'DINNER']) {
      const key = `${dateKey(offset)}-${meal}`
      if (taken.has(key) || slots.includes(key)) continue
      slots.push(key)
      if (slots.length === count) return slots
    }
  }
  return slots
}

async function main() {
  const stamp = String(Date.now()).slice(-6)
  const mama = await register(`mama${stamp}`)
  const baba = await register(`baba${stamp}`)

  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '巡查试家' } })
  check('前置：建家庭', family.status === 201, `status=${family.status}`)
  const invite = family.body?.inviteCode
  await callWithRetry('POST', '/family/join', { token: baba.token, body: { inviteCode: invite } })
  check('前置：爸爸以吃货身份加入', true, 'EATER')

  const dishes = (await callWithRetry('GET', '/recipes?page=1', { token: mama.token })).body?.items ?? []
  const recipe = dishes.find((row) => row.id)
  check('前置：库里有菜谱可点', Boolean(recipe), `${recipe?.name ?? '?'}`)

  // ---------- ① 领令牌要登录态 ----------
  const anonIssue = await call('POST', '/notifications/patrol/token', { body: { deviceId: 'dev-anon' } })
  check('① 没登录领不到巡查令牌 → 401', anonIssue.status === 401, `status=${anonIssue.status}`)

  const noDevice = await callWithRetry('POST', '/notifications/patrol/token', {
    token: mama.token,
    body: { device: '没带 deviceId 的手机' },
  })
  check('⑪ 不带 deviceId 领 → 400', noDevice.status === 400, `status=${noDevice.status}`)

  // ---------- ② 领到的能用；乱写的不行 ----------
  const issued = await callWithRetry('POST', '/notifications/patrol/token', {
    token: mama.token,
    body: { deviceId: 'phone-a', device: '妈妈的手机' },
  })
  check('② 领到巡查令牌', issued.status === 200 && Boolean(issued.body?.token), `status=${issued.status}`)
  const patrol = issued.body?.token

  const bogus = await call('GET', '/notifications/patrol', { patrol: 'not-a-real-token' })
  check('② **对照**：乱写的令牌取不到 → 401', bogus.status === 401, `status=${bogus.status}`)

  // ---------- ③ 两种凭据不通用 ----------
  const loginAsPatrol = await call('GET', '/notifications/patrol', { patrol: mama.token })
  const patrolAsLogin = await call('GET', '/notifications', { token: patrol })
  check('③ **对照**：登录令牌当巡查令牌用 → 401', loginAsPatrol.status === 401, `status=${loginAsPatrol.status}`)
  check('③ **对照**：巡查令牌当登录令牌用 → 401', patrolAsLogin.status === 401, `status=${patrolAsLogin.status}`)

  // ---------- ④ 第一次巡查：不弹，但立水位线 ----------
  const first = await callWithRetry('GET', '/notifications/patrol', { patrol })
  check('④ 第一次巡查成功', first.status === 200, `status=${first.status}`)
  check('④ 第一次**一条都不弹**（伪新不该糊一屏）', (first.body?.items ?? []).length === 0, `items=${(first.body?.items ?? []).length}`)
  check('④ 但水位线立起来了（`since` 非空）', typeof first.body?.since === 'string' && first.body.since.length > 0, `since=${first.body?.since}`)
  let since = first.body?.since ?? null

  // ---------- ⑤ 新发生的事会弹出来 ----------
  const cards = (await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body?.cards
  const slots = freeSlots(cards, 2)
  check('前置：窗口内找到 2 个空餐次', slots.length === 2, slots.join('、'))
  const [planKey] = slots

  const addByBaba = await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: recipe.id, mealDate: planKey.slice(0, 10), meal: planKey.slice(11) },
  })
  check('前置：爸爸点一道菜', addByBaba.status === 201, `status=${addByBaba.status}`)
  const confirmed = await callWithRetry('POST', `/orders/meals/${planKey}/status`, {
    token: mama.token,
    body: { status: 'PLANNED' },
  })
  check('前置：妈妈定下菜单', [200, 201].includes(confirmed.status), `status=${confirmed.status}`)

  // 爸爸那边（**不是他定的**）应当收到；妈妈那边（**是她定的**）不该收到
  const babaIssue = await callWithRetry('POST', '/notifications/patrol/token', {
    token: baba.token,
    body: { deviceId: 'phone-b', device: '爸爸的手机' },
  })
  const babaPatrol = babaIssue.body?.token
  /*
   * ⚠️ 巡查接口是**无状态**的：水位线（`since`）由手机每次带上来（`?since=`）。
   *
   * 本脚本第一版这里漏了 `since`，于是第二次查询被服务端当成"第一次巡查"
   * 而**一条都不弹**——脚本报的是"实现坏了"，其实是断言写错了。
   * 这正是 R-069 那条教训的同一族：**断言本身也要验**。
   */
  const patrolCall = (token, since) => callWithRetry(
    'GET',
    since ? `/notifications/patrol?since=${encodeURIComponent(since)}` : '/notifications/patrol',
    { patrol: token },
  )
  // 先让爸爸也立一条水位线（否则"第一次巡查"那条规则会把历史当新的）
  const babaFirst = await patrolCall(babaPatrol)
  let babaSince = babaFirst.body?.since
  // 妈妈那边立水位线（她刚才已经立过，这里再取一次拿最新的）
  const mamaBefore = await patrolCall(patrol, since)
  since = mamaBefore.body?.since ?? since

  // 现在再制造一件事（爸爸点第二道菜、妈妈再定一餐）→ 爸爸应当被弹
  const [, secondKey] = slots
  const add2 = await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: recipe.id, mealDate: secondKey.slice(0, 10), meal: secondKey.slice(11) },
  })
  check('前置：爸爸再点一道（第二餐）', add2.status === 201, `status=${add2.status}`)
  const confirmed2 = await callWithRetry('POST', `/orders/meals/${secondKey}/status`, {
    token: mama.token,
    body: { status: 'PLANNED' },
  })
  check('前置：妈妈定下第二餐', [200, 201].includes(confirmed2.status), `status=${confirmed2.status}`)

  const babaAfter = await patrolCall(babaPatrol, babaSince)
  const babaItems = babaAfter.body?.items ?? []
  // 断言到**那条具体的事**：只判"非空"的话，别的东西冒出来也算通过
  check('⑤ 爸爸（**不是他定的**）收到了新的事', babaItems.some((item) => item.id === `plan:${secondKey}`), `items=${babaItems.length}：${babaItems.map((i) => i.id).join(' / ') || '（空）'}`)
  check('⑤ 每条都带**后端拼好的那句话**与去处', babaItems.every((item) => item.title && item.to && Number.isInteger(item.notifyId)), JSON.stringify(babaItems[0] ?? null).slice(0, 120))
  check('⑤ 数字 id 是正整数（插件当 `Int` 用，负数在某些机型上会被当成另一个 id）', babaItems.every((item) => item.notifyId > 0), `notifyId=${babaItems.map((i) => i.notifyId).join(',')}`)
  check('⑧ 一次最多 3 条', babaItems.length <= 3, `items=${babaItems.length}`)
  babaSince = babaAfter.body?.since ?? babaSince

  const mamaItems = (await patrolCall(patrol, since)).body?.items ?? []
  /*
   * 这条断言**不能只看"妈妈弹了 0 条"**——那在实现坏掉时也照样通过（空对空）。
   * 两条交叉核对让它变得可判定：
   * ① 妈妈的通知中心里**确实有事**（prep），所以"0 条"不是因为她的看板空了；
   * ② 妈妈的通知中心里**没有**那两条 plan（自己定的不提醒自己），
   *    所以巡查也不该把它们弹给她。
   */
  const mamaBoard = (await callWithRetry('GET', '/notifications', { token: mama.token })).body?.items ?? []
  const babaBoard = (await callWithRetry('GET', '/notifications', { token: baba.token })).body?.items ?? []
  check('⑦ 妈妈的通知中心里**有事**（"0 条"不是因为她压根没看板）', mamaBoard.length > 0, `看板 ${mamaBoard.length} 条`)
  check('⑦ 妈妈的通知中心里**没有**自己定的那两餐（自己定的不提醒自己）', mamaBoard.every((item) => !item.id.startsWith('plan:')), `plan 条数=${mamaBoard.filter((i) => i.id.startsWith('plan:')).length}`)
  check('⑦ **对照**：同一件事在爸爸那边是有的（所以上面那条不是"谁都没有"）', babaBoard.some((item) => item.id === `plan:${secondKey}`), `爸爸的 plan 条数=${babaBoard.filter((i) => i.id.startsWith('plan:')).length}`)
  check(
    '⑦ **自己的事不弹给自己**（妈妈定的那两餐不在她要弹的里）',
    mamaItems.every((item) => !item.id.startsWith('plan:')),
    `妈妈弹了 ${mamaItems.length} 条：${mamaItems.map((i) => i.id).join(' / ') || '（空）'}`,
  )
  /*
   * 第三条交叉核对：**巡查弹出来的每一条都能在通知中心里找到**（同一个 id、同一句话）。
   * 这条是"两处口径一致"的可判定形式——巡查若自己拼一套句子，这里会红。
   */
  check(
    '⑤ 巡查弹的每一条都与通知中心**同源**（同 id、同那句话）',
    babaItems.every((item) => {
      const row = babaBoard.find((candidate) => candidate.id === item.id)
      return Boolean(row) && row.title === item.title && row.to === item.to
    }),
    babaItems.map((item) => item.id).join(' / ') || '（空）',
  )

  // ---------- ⑥ 弹过的不会重复弹 ----------
  const repeat = await patrolCall(babaPatrol, babaSince)
  check('⑥ **带上返回的 since 再查一次 → 0 条**（重复弹会让人关掉通知权限）', (repeat.body?.items ?? []).length === 0, `items=${(repeat.body?.items ?? []).length}：${(repeat.body?.items ?? []).map((i) => i.id).join(' / ') || '（空）'}`)

  // ---------- ⑩ 两台设备各留各的 ----------
  const issuedAgain = await callWithRetry('POST', '/notifications/patrol/token', {
    token: mama.token,
    body: { deviceId: 'phone-a', device: '妈妈的手机（重登）' },
  })
  const stillOld = await call('GET', '/notifications/patrol', { patrol })
  check('⑩ 同一台重登：旧令牌**作废**（换新）', stillOld.status === 401, `旧=${stillOld.status}`)
  const freshOk = await call('GET', '/notifications/patrol', { patrol: issuedAgain.body?.token })
  check('⑩ 同一台重登：新令牌可用', freshOk.status === 200, `新=${freshOk.status}`)

  const secondDevice = await callWithRetry('POST', '/notifications/patrol/token', {
    token: mama.token,
    body: { deviceId: 'phone-a-tablet', device: '妈妈的平板' },
  })
  const tabletOk = await call('GET', '/notifications/patrol', { patrol: secondDevice.body?.token })
  const phoneStillOk = await call('GET', '/notifications/patrol', { patrol: issuedAgain.body?.token })
  check('⑩ **另一台设备领令牌不会顶掉这一台**（第一版按账号唯一，这里会红）', tabletOk.status === 200 && phoneStillOk.status === 200, `平板=${tabletOk.status} 手机=${phoneStillOk.status}`)

  // ---------- ⑨ 退出登录吊销 ----------
  const revoke = await callWithRetry('DELETE', `/notifications/patrol/token?deviceId=${encodeURIComponent('phone-a')}`, { token: mama.token })
  check('⑨ 吊销这台设备 → 返回吊销数', revoke.status === 200 && (revoke.body?.revoked ?? 0) >= 1, JSON.stringify(revoke.body))
  const afterLogout = await call('GET', '/notifications/patrol', { patrol: issuedAgain.body?.token })
  check('⑨ **退出后那枚令牌立刻 401**（"没退干净"的防线）', afterLogout.status === 401, `status=${afterLogout.status}`)
  const tabletSurvives = await call('GET', '/notifications/patrol', { patrol: secondDevice.body?.token })
  check('⑨ **对照**：吊销这台不动另一台（家里的平板不该跟着哑）', tabletSurvives.status === 200, `平板=${tabletSurvives.status}`)

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
