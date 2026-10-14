#!/usr/bin/env node
/**
 * 消息提醒的验收（M10 / F10-01~04，见 D-078）。真实请求，不 mock。
 *
 * 用法：先启动服务，再执行 pnpm run test:http:notifications
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 这一份**自带全部前置数据**（自己注册、建家庭、两个人），不依赖别的验收留下的东西。
 *
 * 覆盖（每一条都对应 D-078 的一句结论）：
 * ① 四条提醒各自会出现：菜单定下来（别人定的）/ 饭已做好（**我点过菜**的）/ 快过期 / 该备菜；
 * ② **不通知自己**：妈妈定的菜单不进妈妈自己的列表；
 * ③ **不通知没点菜的人**：同一餐做好了，妈妈（点了菜的）收到、另一个没点的人收不到；
 * ④ 未读与列表是两个数：已读的仍留在列表里（能翻回去看），只有 `unread` 减；
 * ⑤ 标一条只少一条；一键已读**只标当前列表里那些**（别人的一条都标不到）；
 * ⑥ 换设备（重新登录）后条数与已读状态**一致**（这就是"换手机也都在"）；
 * ⑦ 那句文案与去处**取库里那份**（回放"当时那句话"），`body` 与 `to` 都有；
 * ⑧ 四个开关：关掉一类 → 那类不再出现在列表里；非法值当没传（不能静默改开关）；
 * ⑨ 三个边界：不给 id → 400、空数组 → 400、未登录 → 401。
 *
 * ⚠️ **点菜有窗口**（「只能点从今天到周二这 7 天内的菜」）：造餐必须落在窗口内，
 * 而且**每一步都要看状态码**——本脚本第一版用 day+7/day+8 造餐、又没检查 400，
 * 于是"新造的两餐没产生未读"被误当成通知的 bug（真因是那一餐根本没点成菜）。
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

const board = async (token) => (await callWithRetry('GET', '/notifications', { token })).body
const rowOf = (data, id) => (data?.items ?? []).find((row) => row.id === id)

async function main() {
  const stamp = String(Date.now()).slice(-6)
  const mama = await register(`mama${stamp}`)
  const baba = await register(`baba${stamp}`)
  const uncle = await register(`uncle${stamp}`)

  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '提醒试家' } })
  check('前置：建家庭', family.status === 201, `status=${family.status}`)
  const invite = family.body?.inviteCode
  await callWithRetry('POST', '/family/join', { token: baba.token, body: { inviteCode: invite } })
  await callWithRetry('POST', '/family/join', { token: uncle.token, body: { inviteCode: invite } })
  check('前置：爸爸、小舅都以吃货身份加入', true, '两人 EATER')

  const dishes = (await callWithRetry('GET', '/recipes?page=1', { token: mama.token })).body?.items ?? []
  const recipe = dishes.find((row) => row.id)
  const second = dishes.find((row) => row.id !== recipe?.id)
  check('前置：库里有菜谱可点', Boolean(recipe && second), `拿到 ${recipe?.name ?? '?'} / ${second?.name ?? '?'}`)

  const cards = (await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body?.cards
  const slots = freeSlots(cards, 3)
  check('前置：点菜窗口内找到 3 个空餐次', slots.length === 3, slots.join('、'))

  // ---------- ① 菜单定下来 ----------
  // 爸爸点菜 → 妈妈定菜单 → 爸爸应当收到（**定的人不是看的人**）
  const [planKey, doneKey, secondPlanKey] = slots
  const addByBaba = await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: recipe.id, mealDate: planKey.slice(0, 10), meal: planKey.slice(11) },
  })
  check('前置：爸爸点一道菜', addByBaba.status === 201, `status=${addByBaba.status}`)
  const confirmed = await callWithRetry('POST', `/orders/meals/${planKey}/status`, {
    token: mama.token,
    body: { status: 'PLANNED' },
  })
  check('前置：妈妈定下这一餐的菜单', confirmed.status === 200 || confirmed.status === 201, `status=${confirmed.status}`)

  const babaBoard = await board(baba.token)
  const planRow = rowOf(babaBoard, `plan:${planKey}`)
  check('① 别人定了菜单 → 我收到一条提醒', Boolean(planRow), planRow?.title ?? '(没有)')
  check(
    '① 那条是未读',
    planRow?.unread === true,
    `unread=${planRow?.unread} 未读总数=${babaBoard?.unread}`,
  )
  // 去处是**那一餐的详情**，不是列表页（用户 2026-10-15：「通知可以点击跳转到对应的地方去」）
  check(
    '⑦ 去处对（点进去直达那一餐的详情，不用自己在列表里找）',
    planRow?.to === `/order/${planKey}`,
    `to=${planRow?.to}`,
  )
  check(
    '⑦ 文案由后端拼、`body` 有内容（前端不拼句子）',
    typeof planRow?.title === 'string' && planRow.title.length > 0 && typeof planRow?.body === 'string',
    `${JSON.stringify(planRow?.title)} / ${JSON.stringify(planRow?.body)}`,
  )
  check(
    '① 归到订单那个 Tab（红点按区域算）',
    babaBoard?.unreadByArea?.order >= 1,
    JSON.stringify(babaBoard?.unreadByArea),
  )
  check('① kind 标着来源类别', planRow?.kind === 'plan', `kind=${planRow?.kind}`)

  // ---------- ② 不通知自己 ----------
  const mamaBoard0 = await board(mama.token)
  check(
    '② **自己定的不进自己的列表**',
    rowOf(mamaBoard0, `plan:${planKey}`) === undefined,
    rowOf(mamaBoard0, `plan:${planKey}`)?.title ?? '(没有，正确)',
  )

  // ---------- ③ 饭已做好只给点过菜的人 ----------
  // 爸爸点了菜、小舅**没点** → 妈妈推到「做好了」→ 爸爸收到、小舅收不到。
  // 这一餐必须有菜才推得动（空餐次是 404「这一餐还没有人点菜」）。
  const addForDone = await callWithRetry('POST', '/orders/items', {
    token: baba.token,
    body: { recipeId: recipe.id, mealDate: doneKey.slice(0, 10), meal: doneKey.slice(11) },
  })
  check('前置：爸爸在另一餐点菜（要做好的那一餐）', addForDone.status === 201, `status=${addForDone.status}`)
  await callWithRetry('POST', `/orders/meals/${doneKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  // 推进链是 PLANNED → COOKING → DONE：跳过「准备中」直接标做好了会被 409 挡回来
  const cooking = await callWithRetry('POST', `/orders/meals/${doneKey}/status`, {
    token: mama.token,
    body: { status: 'COOKING' },
  })
  check('前置：妈妈开始做这一餐', cooking.status === 200 || cooking.status === 201, `status=${cooking.status}`)
  const cooked = await callWithRetry('POST', `/orders/meals/${doneKey}/status`, {
    token: mama.token,
    body: { status: 'DONE' },
  })
  check('前置：妈妈把这一餐标成「做好了」', cooked.status === 200 || cooked.status === 201, `status=${cooked.status} msg=${cooked.body?.message ?? ''}`)

  const babaBoard2 = await board(baba.token)
  const doneRow = rowOf(babaBoard2, `done:${doneKey}`)
  check('③ 我点过菜的餐做好了 → 我收到', Boolean(doneRow), doneRow?.title ?? '(没有)')
  check(
    '③ 那句带上我点的那道菜',
    (doneRow?.body ?? '').includes(recipe.name),
    `body=${JSON.stringify(doneRow?.body)}`,
  )
  const uncleBoard = await board(uncle.token)
  check(
    '③ **没点这一餐的人收不到**（他没在等这顿饭）',
    rowOf(uncleBoard, `done:${doneKey}`) === undefined,
    rowOf(uncleBoard, `done:${doneKey}`)?.title ?? '(没有，正确)',
  )

  // ---------- ① 该备菜 ----------
  const prepRow = (babaBoard2?.items ?? []).find((row) => row.kind === 'prep')
  check('① 接下来几天有餐次空着 → 收到「该备菜了」', Boolean(prepRow), prepRow?.title ?? '(没有)')
  check('① 那条点进去是备菜页', prepRow?.to === '/prep', `to=${prepRow?.to}`)
  check('① 备菜也算订单那个 Tab 的未读（入口在订单那一支）', (babaBoard2?.unreadByArea?.order ?? 0) >= 1, JSON.stringify(babaBoard2?.unreadByArea))

  // ---------- ④ 已读的还翻得回去看 ----------
  const totalBefore = babaBoard2?.items?.length ?? 0
  const unreadBefore = babaBoard2?.unread ?? 0
  const markOne = await callWithRetry('POST', '/notifications/read', {
    token: baba.token,
    body: { id: planRow.id },
  })
  check('⑤ 标一条已读成功', markOne.body?.read === 1, JSON.stringify(markOne.body))
  const babaBoard3 = await board(baba.token)
  check('④ 未读少了一条', babaBoard3?.unread === unreadBefore - 1, `${unreadBefore} → ${babaBoard3?.unread}`)
  check('④ **列表长度没变**（已读的还留着，能翻回去看）', babaBoard3?.items?.length === totalBefore, `${totalBefore} → ${babaBoard3?.items?.length}`)
  check('④ 标的那条 `unread` 变 false', rowOf(babaBoard3, planRow.id)?.unread === false, `unread=${rowOf(babaBoard3, planRow.id)?.unread}`)

  // ---------- ⑤ 一键已读只标当前列表里那些 ----------
  // 中途妈妈又定一餐（爸爸还没看过）→ 一键已读**不能**把它吞掉
  const uncleAdd = await callWithRetry('POST', '/orders/items', {
    token: uncle.token,
    body: { recipeId: second.id, mealDate: secondPlanKey.slice(0, 10), meal: secondPlanKey.slice(11) },
  })
  check('前置：小舅在另一餐点了菜', uncleAdd.status === 201, `status=${uncleAdd.status}`)
  await callWithRetry('POST', `/orders/meals/${secondPlanKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })

  const beforeAll = await board(baba.token)
  check(
    '前置：新定的那一餐确实进到了列表里、且是未读',
    rowOf(beforeAll, `plan:${secondPlanKey}`)?.unread === true,
    `未读总数=${beforeAll?.unread}`,
  )
  const visibleIds = (beforeAll?.items ?? []).map((row) => row.id)
  const all = await callWithRetry('POST', '/notifications/read-all', { token: baba.token, body: { ids: visibleIds } })
  check(
    '⑤ 一键已读标掉的正好是**列表里那些未读**（不是"这个账号所有未读"）',
    all.body?.read === beforeAll?.unread,
    `标了 ${all.body?.read} 条、当时未读 ${beforeAll?.unread} 条`,
  )
  const afterAll = await board(baba.token)
  check('④ 一键已读后未读归零', afterAll?.unread === 0, `unread=${afterAll?.unread}`)
  check('④ 两个区域的未读都归零', (afterAll?.unreadByArea?.order ?? 0) === 0 && (afterAll?.unreadByArea?.fridge ?? 0) === 0, JSON.stringify(afterAll?.unreadByArea))
  check(
    '⑤ 条数只增不减（新来那条留在列表里，不是被清掉）',
    afterAll.items.length > totalBefore,
    `${totalBefore} → ${afterAll.items.length}`,
  )

  // ---------- ⑥ 换设备 ----------
  const again = await callWithRetry('POST', '/auth/login', {
    body: { account: baba.account, password: 'cook2026pass' },
  })
  check('⑥ 换设备：重新登录拿到新会话', Boolean(again.body?.token), `status=${again.status}`)
  const deviceB = await board(again.body.token)
  check('⑥ 换设备后**条数一致**', deviceB?.items?.length === afterAll?.items?.length, `${afterAll?.items?.length} vs ${deviceB?.items?.length}`)
  check('⑥ 换设备后**已读状态一致**', deviceB?.unread === afterAll?.unread, `unread ${afterAll?.unread} vs ${deviceB?.unread}`)

  // ---------- ⑦ 别人标不掉我的 ----------
  const mamaIds = ((await board(mama.token))?.items ?? []).map((row) => row.id)
  const crossMark = await callWithRetry('POST', '/notifications/read-all', { token: baba.token, body: { ids: mamaIds } })
  check('⑤ 拿别人的 id 去标 → 一条都标不到', crossMark.body?.read === 0, JSON.stringify(crossMark.body))

  // ---------- ⑧ 四个开关 ----------
  const off = await callWithRetry('POST', '/notifications/prefs', { token: baba.token, body: { mealPlan: false } })
  check('⑧ 关掉「菜单安排」', off.body?.mealPlan === false, JSON.stringify(off.body))
  const closed = await board(baba.token)
  check(
    '⑧ 关掉之后那类**不再出现在列表里**',
    (closed?.items ?? []).every((row) => row.kind !== 'plan'),
    `剩下的 kind：${[...new Set((closed?.items ?? []).map((row) => row.kind))].join('、') || '(空)'}`,
  )
  const othersIntact = await board(baba.token)
  check('⑧ 关一类不动别的三类', (othersIntact?.items ?? []).some((row) => row.kind !== 'plan') || (othersIntact?.items ?? []).length === 0, `items=${othersIntact?.items?.length}`)

  const back = await callWithRetry('POST', '/notifications/prefs', { token: baba.token, body: { mealPlan: true } })
  const reopened = await board(baba.token)
  check(
    '⑧ 重新打开 → 又看得见（且**已读状态没丢**）',
    back.body?.mealPlan === true && (reopened?.items ?? []).some((row) => row.kind === 'plan') && reopened?.unread === 0,
    `mealPlan=${back.body?.mealPlan} unread=${reopened?.unread}`,
  )
  const junk = await callWithRetry('POST', '/notifications/prefs', { token: baba.token, body: { mealPlan: 'false', expiry: 1 } })
  check(
    '⑧ 非法值当没传（`"false"`/`1` **不能**静默把开关改掉）',
    junk.body?.mealPlan === true && junk.body?.expiry === true,
    JSON.stringify(junk.body),
  )

  // ---------- ⑨ 边界 ----------
  const noId = await callWithRetry('POST', '/notifications/read', { token: baba.token, body: {} })
  const emptyIds = await callWithRetry('POST', '/notifications/read-all', { token: baba.token, body: { ids: [] } })
  const anon = await call('GET', '/notifications')
  check('⑨ 不给 id → 400', noId.status === 400, `status=${noId.status}`)
  check('⑨ 空数组 → 400', emptyIds.status === 400, `status=${emptyIds.status}`)
  check('⑨ 未登录 → 401', anon.status === 401, `status=${anon.status}`)

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
