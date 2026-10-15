#!/usr/bin/env node
/**
 * 点单接口 HTTP 验收（真实请求，不 mock）。M3 / F3-01~F3-05，口径见 D-022。
 * 用法：先启动服务，再执行 pnpm run test:http:orders
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：点菜 → 合并成卡 → 撤回 → 状态机（含跳级/回退被拒）→ 权限（吃货推不动状态）
 *       → 共享开关收窄吃货可见范围 → 已安排后**仍能**加菜（2026-10-15 放开）。
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
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 全局限流是 60 次/分（按 IP 计数，见 app.module.ts）。本脚本一轮就有 50 多个请求，
 * **连着跑两遍必然把第二遍打进 429**，于是验收结果会变成一片红——看起来像功能坏了，其实是自己的限流。
 * 这里遇到 429 就等窗口过去再重试（最多 3 轮），让脚本本身可重复运行。
 * 注：本脚本没有"必须返回 429"的用例，所以自动重试不会掩盖任何断言。
 */
async function callWithRetry(method, path, options = {}) {
  for (let round = 0; round < 3; round += 1) {
    const response = await call(method, path, options)
    if (response.status !== 429) return response
    const waitMs = (Number(response.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 触发限流（60 次/分），等待 ${Math.round(waitMs / 1000)}s 后重试 ${method} ${path}…`)
    await sleep(waitMs)
  }
  console.log(`⚠️ ${method} ${path} 一直 429，返回最后一次结果`)
  return call(method, path, options)
}

/** 登录 8 次/分、加入家庭 10 次/分：连着跑两遍脚本时上一轮的窗口还没过期 */
async function settleThrottleWindow(probes) {
  for (let round = 0; round < 3; round += 1) {
    const attempt = await probes()
    if (attempt.status !== 429) return
    const waitMs = (Number(attempt.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 上一轮限流窗口未过期，等待 ${Math.round(waitMs / 1000)}s 后重跑…\n`)
    await sleep(waitMs)
  }
  throw new Error('限流窗口一直未恢复，无法开始验收（服务是否异常？）')
}

async function joinFamily(token, inviteCode) {
  const first = await call('POST', '/family/join', { token, body: { inviteCode } })
  if (first.status !== 429) return first
  const waitMs = (Number(first.retryAfter) || 60) * 1000 + 1000
  console.log(`⏳ 加入家庭已触发限流（10 次/分），等待 ${Math.round(waitMs / 1000)}s 后重试…\n`)
  await sleep(waitMs)
  return call('POST', '/family/join', { token, body: { inviteCode } })
}

let seq = 0
async function newUser(nickname) {
  seq += 1
  const account = `ord${Date.now()}${seq}`.toLowerCase()
  const password = 'cook2026pass'
  const registered = await callWithRetry('POST', '/auth/register', { body: { account, password, nickname: nickname ?? account } })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, password, token: registered.body.token, refreshToken: registered.body.refreshToken, user: registered.body.user }
}

/** 验收要真的点几道菜：用当天日期 + 晚餐 */
function todayKey() {
  return plusDaysKey(0)
}

function plusDaysKey(offset) {
  // 按日历递进（setDate），不是加 86400000 毫秒——跨夏令时那天会跑偏
  const base = new Date()
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function weekdayOfKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return WEEKDAY_LABEL[new Date(year, month - 1, day).getDay()]
}

async function main() {
  await settleThrottleWindow(() => call('POST', '/auth/login', { body: { account: 'throttle-probe', password: 'probe-not-valid' } }))

  const TODAY = todayKey()
  const TOMORROW = plusDaysKey(1)
  const DAY_AFTER = plusDaysKey(2)

  // ---------- 口径接口（免登录） ----------
  const options = await callWithRetry('GET', '/orders/options')
  check(
    '口径接口下发餐次、状态与可选日期（前端不硬编码）',
    options.status === 200
      && options.body?.meals?.length === 2
      && options.body?.statuses?.length === 5
      && (options.body?.dayOptions ?? []).length === 7,
    `${options.status} meals=${options.body?.meals?.length} statuses=${options.body?.statuses?.length} days=${options.body?.dayOptions?.length}`,
  )
  check(
    '可选日期是今天起 7 天（备菜计划每一行都要能安排，不能再点昨天）',
    (options.body?.dayOptions ?? []).map(d => d.value).join(',')
      === Array.from({ length: 7 }, (_, index) => plusDaysKey(index)).join(','),
    JSON.stringify(options.body?.dayOptions),
  )

  // ---------- 前置：家庭 + 两道真实菜谱 ----------
  const mama = await newUser('妈妈')
  const created = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '点单验收家' } })
  if (created.status !== 201) throw new Error(`建家失败：${created.status} ${JSON.stringify(created.body)}`)
  const inviteCode = created.body.inviteCode

  const recipes = await callWithRetry('GET', '/recipes?pageSize=2')
  const [dishA, dishB] = recipes.body?.items ?? []
  if (!dishA || !dishB) throw new Error('菜谱库为空，无法验收点菜（先跑种子导入）')

  // ---------- 未加入家庭 ----------
  const loner = await newUser('独居者')
  const noFamily = await callWithRetry('POST', '/orders/items', { token: loner.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'DINNER' } })
  check('没有家庭的人点菜 → 404 且话术可读', noFamily.status === 404 && typeof noFamily.body?.message === 'string', `${noFamily.status} ${noFamily.body?.message ?? ''}`)

  const anonymous = await callWithRetry('GET', '/orders')
  check('未带 token 访问点单列表 → 401', anonymous.status === 401, `${anonymous.status}`)

  // ---------- 点菜（F3-01/04/05） ----------
  const son = await newUser('小满')
  const joined = await joinFamily(son.token, inviteCode)
  if (joined.status !== 200) throw new Error(`小满加入失败：${joined.status} ${JSON.stringify(joined.body)}`)

  const mamaOrder = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishA.id, mealDate: TODAY, meal: 'DINNER', note: '少放盐' },
  })
  check(
    '点菜 201：自动建出「今天晚餐」这张卡，并带上菜名与状态',
    mamaOrder.status === 201
      && mamaOrder.body?.mealKey === `${TODAY}-DINNER`
      && mamaOrder.body?.status === 'PENDING'
      && mamaOrder.body?.dishes?.[0]?.name === dishA.name,
    `${mamaOrder.status} key=${mamaOrder.body?.mealKey} status=${mamaOrder.body?.status}`,
  )
  check(
    '卡片带上了备注（F3-05）',
    mamaOrder.body?.dishes?.[0]?.notes?.[0]?.text === '少放盐' && mamaOrder.body?.dishes?.[0]?.notes?.[0]?.nickname === '妈妈',
    JSON.stringify(mamaOrder.body?.dishes?.[0]?.notes),
  )

  // 同一餐再加一道：仍是一张卡
  const sonOrder = await callWithRetry('POST', '/orders/items', {
    token: son.token,
    body: { recipeId: dishB.id, mealDate: TODAY, meal: 'DINNER', note: '不要辣' },
  })
  check(
    '家人往同一餐里点菜是同一张卡（按餐次聚合，D-022）',
    sonOrder.status === 201 && sonOrder.body?.mealKey === `${TODAY}-DINNER` && sonOrder.body?.dishes?.length === 2,
    `${sonOrder.status} dishes=${sonOrder.body?.dishes?.length}`,
  )
  check(
    '谁点的都在卡上（点菜人去重、人数正确）',
    (sonOrder.body?.orderers ?? []).slice().sort().join(',') === '妈妈,小满' && sonOrder.body?.ordererCount === 2,
    `orderers=${JSON.stringify(sonOrder.body?.orderers)} count=${sonOrder.body?.ordererCount}`,
  )

  // 又是同一道菜（A）：份数要合并成 2
  const repeat = await callWithRetry('POST', '/orders/items', { token: son.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'DINNER' } })
  const dishALine = (repeat.body?.dishes ?? []).find(d => d.name === dishA.name)
  check(
    '同一道菜被两个人点 → 合并成一行、份数 2（F3-04）',
    repeat.status === 201 && dishALine?.count === 2,
    `count=${dishALine?.count} dishes=${(repeat.body?.dishes ?? []).map(d => `${d.name}x${d.count}`).join('/')}`,
  )

  // ---------- 点单列表与筛选计数（F3-01/03） ----------
  const familyList = await callWithRetry('GET', '/orders', { token: mama.token })
  /*
   * 列表**只铺今天及之后**（用户 2026-10-15：「订单只显示今天及之后的订单，剩余的都放入点单历史中」）。
   * 这个家是脚本现造的、还没有过去的餐次，所以这里只能钉住"回来的每一张都不早于今天"——
   * "过去那几餐真的不出现了"由开发库那个有历史的家实测（见 RUNBOOK R-079）。
   */
  check(
    '列表里没有今天之前的餐次（过去那几餐归点单历史）',
    (familyList.body?.cards ?? []).every((card) => card.date >= TODAY),
    `dates=${JSON.stringify((familyList.body?.cards ?? []).map((c) => c.date))}`,
  )
  check(
    '全家视角看得到这一餐；计数徽标含全部状态',
    familyList.status === 200
      && familyList.body?.scope === 'family'
      && familyList.body?.cards?.length === 1
      && familyList.body?.counts?.ALL === 1
      && familyList.body?.counts?.PENDING === 1,
    `${familyList.status} cards=${familyList.body?.cards?.length} counts=${JSON.stringify(familyList.body?.counts)}`,
  )

  // 妈妈没点过 B 那道菜，但她在这一餐点过 A → 「只看我的」里这一餐仍然出现
  const mineList = await callWithRetry('GET', '/orders?family=false', { token: mama.token })
  check(
    '「只看我的」保留我参与过的餐次',
    mineList.status === 200 && mineList.body?.scope === 'mine' && mineList.body?.cards?.length === 1,
    `${mineList.status} cards=${mineList.body?.cards?.length}`,
  )
  check(
    '「只看我的」下卡片标出我点了几份',
    mineList.body?.cards?.[0]?.mineCount === 1,
    `mineCount=${mineList.body?.cards?.[0]?.mineCount}`,
  )

  // 第三个人点了别的餐次：不该出现在妈妈"只看我的"里
  const guest = await newUser('客人')
  const guestJoined = await joinFamily(guest.token, inviteCode)
  if (guestJoined.status !== 200) throw new Error(`客人加入失败：${guestJoined.status}`)
  await callWithRetry('POST', '/orders/items', { token: guest.token, body: { recipeId: dishA.id, mealDate: TOMORROW, meal: 'LUNCH' } })
  const mineAfterGuest = await callWithRetry('GET', '/orders?family=false', { token: mama.token })
  check(
    '别人点的餐次不出现在我的列表里（「只看我的」按参与过滤）',
    mineAfterGuest.body?.cards?.length === 1 && mineAfterGuest.body?.cards?.[0]?.mealKey === `${TODAY}-DINNER`,
    `cards=${JSON.stringify((mineAfterGuest.body?.cards ?? []).map(c => c.mealKey))}`,
  )
  const familyAfterGuest = await callWithRetry('GET', '/orders', { token: mama.token })
  check(
    '全家视角两张卡，且计数跟着涨（F3-03）',
    familyAfterGuest.body?.cards?.length === 2
      && familyAfterGuest.body?.counts?.ALL === 2
      && familyAfterGuest.body?.counts?.PENDING === 2,
    `cards=${familyAfterGuest.body?.cards?.length} counts=${JSON.stringify(familyAfterGuest.body?.counts)}`,
  )

  const plannedFilter = await callWithRetry('GET', '/orders?status=PLANNED', { token: mama.token })
  check(
    '按状态筛选：没有「已安排」时列表为空，但徽标仍给出各状态数量（切得回去）',
    plannedFilter.status === 200
      && plannedFilter.body?.cards?.length === 0
      && plannedFilter.body?.counts?.PENDING === 2
      && plannedFilter.body?.counts?.PLANNED === 0,
    `cards=${plannedFilter.body?.cards?.length} counts=${JSON.stringify(plannedFilter.body?.counts)}`,
  )

  const badStatus = await callWithRetry('GET', '/orders?status=FINISHED', { token: mama.token })
  check('未知状态筛选 → 400', badStatus.status === 400, `${badStatus.status} ${badStatus.body?.message ?? ''}`)

  // ---------- 退菜（F3-05；用户 2026-10-15 放开：全家都能退任何菜，到「正在做」为止） ----------
  // 注意：小满点了两道菜（B 一道、A 一道），要按菜名挑出 A 的那条，别用 items[0]
  const sonItems = (repeat.body?.items ?? []).filter(item => item.isMe)
  const sonDishAItem = sonItems.find(item => item.name === dishA.name)
  const sonDishBItem = sonItems.find(item => item.name === dishB.name)
  check(
    '卡片里标出哪些是我点的（前端据此给退菜入口）',
    sonItems.length === 2 && Boolean(sonDishAItem) && Boolean(sonDishBItem),
    `mineItems=${sonItems.length} dishes=${sonItems.map(i => i.name).join('/')}`,
  )

  const steal = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: mama.token })
  const dishACountAfterSteal = (steal.body?.dishes ?? []).find(d => d.name === dishA.name)?.count
  check(
    '家里谁都能退任何一份（妈妈退小满点的那份 200，份数 2 → 1）——用户 2026-10-15 的口径',
    steal.status === 200 && dishACountAfterSteal === 1,
    `${steal.status} count=${dishACountAfterSteal} ${steal.body?.message ?? ''}`,
  )

  // 整餐变空的情况单验（客人那一餐只有一盘菜），这里只验"我在这餐不再有份"
  const withdrawLast = await callWithRetry('DELETE', `/orders/items/${sonDishBItem?.id}`, { token: son.token })
  check(
    '退掉自己在这一餐的最后一份：「我的份」归零，点菜人减为 1',
    withdrawLast.status === 200 && withdrawLast.body?.mineCount === 0 && withdrawLast.body?.ordererCount === 1,
    `${withdrawLast.status} mine=${withdrawLast.body?.mineCount} orderers=${withdrawLast.body?.ordererCount}`,
  )

  const goneItem = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: son.token })
  check('再退同一条（已被退）→ 404', goneItem.status === 404, `${goneItem.status}`)

  // 空卡清理：客人那餐只有他自己一盘，退掉后这一餐整个消失
  const guestItems = await callWithRetry('GET', '/orders?family=false', { token: guest.token })
  const guestItemId = guestItems.body?.cards?.[0]?.items?.[0]?.id
  const guestWithdraw = await callWithRetry('DELETE', `/orders/items/${guestItemId}`, { token: guest.token })
  check(
    '退掉整餐最后一份菜时，这张空卡被清掉（列表里不留 0 道菜的餐次）',
    guestWithdraw.status === 200
      && guestWithdraw.body?.dishCount === 0
      && (await callWithRetry('GET', '/orders', { token: mama.token })).body?.cards?.length === 1,
    `${guestWithdraw.status} dishCount=${guestWithdraw.body?.dishCount}`,
  )

  // ---------- 状态机（F3-02） ----------
  const mealKey = `${TODAY}-DINNER`

  const eaterPlan = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: son.token, body: { status: 'PLANNED' } })
  check('吃货推状态 → 403（点菜可以、安排不行，权限在后端强制）', eaterPlan.status === 403, `${eaterPlan.status} ${eaterPlan.body?.message ?? ''}`)

  /*
   * 「做好了」不再必须走"选好了 → 开始做"（用户 2026-10-15：「现在做好了点击不了」）。
   * 旧口径里这是"跳级 409"，现在它是正路——而且**吃货就点得动**：
   * 家里那个只有 order.create + menu.confirm 的账号，从「待确认」也能一步标好，
   * "全家谁都能点做好"（D-075）这才真的够得着。
   * 用第 4 天另起一餐来验，不动今天晚餐这条主线。
   */
  const jumpKey = `${plusDaysKey(4)}-LUNCH`
  await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(4), meal: 'LUNCH' } })
  const jumpDone = await callWithRetry('POST', `/orders/meals/${jumpKey}/status`, { token: son.token, body: { status: 'DONE' } })
  check(
    '「待确认」也能直接标成「做好了」，而且**吃货点得动**（新口径：做好不该被"选好了/开始做"锁住）',
    jumpDone.status === 200 && jumpDone.body?.status === 'DONE',
    `${jumpDone.status} ${jumpDone.body?.status} ${jumpDone.body?.message ?? ''}`,
  )
  check(
    '直接标好的那一餐同样封口：明细加不进也退不掉（终态就是终态）',
    jumpDone.body?.nextActions?.length === 0
      && (await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: plusDaysKey(4), meal: 'LUNCH' } })).status === 409,
    `next=${jumpDone.body?.nextActions?.length}`,
  )

  const badNext = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'FINISHED' } })
  check('非法状态值 → 400', badNext.status === 400, `${badNext.status}`)

  const planned = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  check(
    '掌勺人推「选好了」→ 已安排 200，下一步是「开始做 / 做好了 / 取消」',
    planned.status === 200
      && planned.body?.status === 'PLANNED'
      && (planned.body?.nextActions ?? []).map(a => a.status).sort().join(',') === 'CANCELED,COOKING,DONE',
    `${planned.status} status=${planned.body?.status} next=${JSON.stringify((planned.body?.nextActions ?? []).map(a => a.status))}`,
  )

  // 确认留痕（M4 / F4-05）：定下这一版菜单的人与时间
  check(
    '定菜单记下"谁定的、什么时候"（留痕跟着这一版菜单）',
    planned.body?.confirmedBy?.nickname === '妈妈'
      && typeof planned.body?.confirmedAt === 'string'
      && Math.abs(Date.now() - Date.parse(planned.body.confirmedAt)) < 5 * 60_000,
    `confirmedBy=${JSON.stringify(planned.body?.confirmedBy)} confirmedAt=${planned.body?.confirmedAt}`,
  )

  /*
   * 用户 2026-10-15：「今天点了餐就不能修改了，也不能继续点，都要优化」——
   * 加菜从"只有收集中"放开到**到「正在做」为止都能加**（与退菜同宽，只有做好了封口）。
   * 所以这里原来那条"已安排 → 409"要反过来验：**已安排也能再加一道**。
   */
  const lateAdd = await callWithRetry('POST', '/orders/items', {
    token: son.token,
    body: { recipeId: dishB.id, mealDate: TODAY, meal: 'DINNER' },
  })
  check(
    '已安排的餐还能再加一道（菜单"定了"不等于封口）——用户 2026-10-15 的口径',
    lateAdd.status === 201
      && lateAdd.body?.status === 'PLANNED'
      && (lateAdd.body?.dishes ?? []).some(d => d.name === dishB.name),
    `${lateAdd.status} status=${lateAdd.body?.status} dishes=${(lateAdd.body?.dishes ?? []).map(d => d.name).join('/')}`,
  )
  // 加完之后这一餐还是"已安排"（加菜不把状态打回去，掌勺人已经定过的那一版仍然算数）
  check(
    '加菜不动状态与留痕（这一版菜单还是掌勺人定的那一版）',
    lateAdd.body?.confirmedBy?.nickname === '妈妈' && Boolean(lateAdd.body?.confirmedAt),
    `confirmedBy=${JSON.stringify(lateAdd.body?.confirmedBy)}`,
  )

  const alreadyGone = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: son.token })
  check('已被撤掉的条目再撤 → 404', alreadyGone.status === 404, `${alreadyGone.status}`)

  const rollback = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'PENDING' } })
  check('从已安排回退到待确认 → 409（不允许回退）', rollback.status === 409, `${rollback.status} ${rollback.body?.message ?? ''}`)

  const cooking = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  check('「开始做」→ 准备中 200', cooking.status === 200 && cooking.body?.status === 'COOKING', `${cooking.status} ${cooking.body?.status}`)
  check(
    '开始做不动留痕：做的还是那一版菜单，谁定的没变',
    cooking.body?.confirmedBy?.nickname === '妈妈' && cooking.body?.confirmedAt === planned.body?.confirmedAt,
    `confirmedBy=${JSON.stringify(cooking.body?.confirmedBy)} confirmedAt=${cooking.body?.confirmedAt}`,
  )

  const done = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'DONE' } })
  check(
    '「做好了」→ 已做好 200，且终态没有下一步',
    done.status === 200 && done.body?.status === 'DONE' && (done.body?.nextActions ?? []).length === 0,
    `${done.status} status=${done.body?.status} next=${(done.body?.nextActions ?? []).length}`,
  )
  check(
    '做好了也留着留痕（回看这一餐时知道是谁定的）',
    done.body?.confirmedBy?.nickname === '妈妈' && done.body?.confirmedAt === planned.body?.confirmedAt,
    `confirmedBy=${JSON.stringify(done.body?.confirmedBy)}`,
  )

  const afterDone = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'CANCELED' } })
  check('已做好不能再取消（终态）→ 409', afterDone.status === 409, `${afterDone.status}`)

  // ---------- 退菜的两个边界：终态封口 / 到「正在做」为止（用户 2026-10-15） ----------
  const doneDetail = await callWithRetry('GET', `/orders/${mealKey}`, { token: mama.token })
  const doneItemId = (doneDetail.body?.items ?? [])[0]?.id
  const doneItemRemove = await callWithRetry('DELETE', `/orders/items/${doneItemId}`, { token: son.token })
  check(
    '「做好了」之后单份也退不掉 → 409，并指向点单历史（终态不是能随手改的东西）',
    doneItemRemove.status === 409 && /点单历史/.test(doneItemRemove.body?.message ?? ''),
    `${doneItemRemove.status} ${doneItemRemove.body?.message ?? ''}`,
  )

  const doneClear = await callWithRetry('DELETE', `/orders/meals/${mealKey}/items`, { token: mama.token })
  check(
    '「做好了」的餐整桌也退不掉 → 409（同一条口径，不分单份还是整桌）',
    doneClear.status === 409 && /点单历史/.test(doneClear.body?.message ?? ''),
    `${doneClear.status} ${doneClear.body?.message ?? ''}`,
  )

  // 整桌退菜走得通的那一半：另起一餐推到「正在做」再退（第 4 天没被别的断言占用）
  const bulkKey = `${plusDaysKey(5)}-DINNER`
  await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(5), meal: 'DINNER' } })
  const bulkSecond = await callWithRetry('POST', '/orders/items', { token: son.token, body: { recipeId: dishB.id, mealDate: plusDaysKey(5), meal: 'DINNER' } })
  check(
    '为验证整桌退菜，新建一餐：两个人各点了一道（同一张卡两道菜）',
    bulkSecond.status === 201 && bulkSecond.body?.mealKey === bulkKey && bulkSecond.body?.dishes?.length === 2,
    `${bulkSecond.status} ${bulkSecond.body?.mealKey} dishes=${bulkSecond.body?.dishes?.length}`,
  )

  const clearNobody = await callWithRetry('DELETE', `/orders/meals/${plusDaysKey(5)}-LUNCH/items`, { token: mama.token })
  check('退一餐根本没人点过的菜 → 404（不是静默成功）', clearNobody.status === 404, `${clearNobody.status} ${clearNobody.body?.message ?? ''}`)

  await callWithRetry('POST', `/orders/meals/${bulkKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  const bulkCooking = await callWithRetry('POST', `/orders/meals/${bulkKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  const bulkCleared = await callWithRetry('DELETE', `/orders/meals/${bulkKey}/items`, { token: son.token })
  check(
    `整桌退菜：「正在做」也退得掉（退菜比加菜宽，只有做好封口），而且这次是吃货退的——全家都能退`,
    bulkCooking.body?.status === 'COOKING'
      && bulkCleared.status === 200
      && bulkCleared.body?.dishCount === 0
      /*
        退光之后这一餐在库里已经不存在了，回来的是"还没有人点菜"那张空卡：
        status 是**空卡的占位值**（PENDING），不是把「正在做」原样带回来——
        没有这一餐了，就没有状态可说，前端也只拿它当"这里空了"。
      */
      && bulkCleared.body?.ordererCount === 0
      && bulkCleared.body?.status === 'PENDING',
    `${bulkCleared.status} dishCount=${bulkCleared.body?.dishCount} 退之前=${bulkCooking.body?.status} 退之后=${bulkCleared.body?.status}`,
  )

  const afterBulkClear = await callWithRetry('GET', '/orders', { token: mama.token })
  check(
    '退空的餐不再出现在列表里（与退掉最后一份菜同一条清理规则）',
    !(afterBulkClear.body?.cards ?? []).some(card => card.mealKey === bulkKey),
    `keys=${JSON.stringify((afterBulkClear.body?.cards ?? []).map(c => c.mealKey))}`,
  )

  const clearAgain = await callWithRetry('DELETE', `/orders/meals/${bulkKey}/items`, { token: mama.token })
  check('再退一次（这一餐已经没了）→ 404', clearAgain.status === 404, `${clearAgain.status}`)

  // ---------- 删整条记录（用户 2026-10-15：「点单历史里面要有」删整条） ----------
  /*
   * 这一段自己造自己清：**每一条临时餐次最后都要回到"不存在"**。
   * 后面的备菜计划断言靠的是"没有任何一条还在安排中的餐次"（settled ⟺ 不能加菜），
   * 留下一条 PLANNED/COOKING 会让那一整组无辜变红（第一版就是这么踩的，
   * 而且踩出来的还是"第 7 天点不进去"这种看着像真 bug 的假红）。
   * 另外**不动 `mealKey`（今天晚餐）**：备菜计划要有一行"已做好"来验 canAdd=false。
   */
  const delPendingKey = `${plusDaysKey(4)}-DINNER`
  await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: plusDaysKey(4), meal: 'DINNER' } })
  const delPending = await callWithRetry('DELETE', `/orders/${delPendingKey}`, { token: mama.token })
  check(
    '「待确认」的记录删不掉 → 409，并指路"取消它 / 退菜"（还在安排的那一餐不是一条记录）',
    delPending.status === 409
      && /取消/.test(delPending.body?.message ?? '')
      && /退菜/.test(delPending.body?.message ?? ''),
    `${delPending.status} ${delPending.body?.message ?? ''}`,
  )
  // 那条被拒的餐次按它自己指的路清掉（退菜到「正在做」都行，正是这一轮放开的口径）
  const delPendingCleanup = await callWithRetry('DELETE', `/orders/meals/${delPendingKey}/items`, { token: mama.token })
  check('照着 409 指的路把那一餐退掉 → 200（提示里的路必须真的走得通）', delPendingCleanup.status === 200, `${delPendingCleanup.status}`)

  const delCookingKey = `${plusDaysKey(5)}-LUNCH`
  await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(5), meal: 'LUNCH' } })
  await callWithRetry('POST', `/orders/meals/${delCookingKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${delCookingKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  const delCooking = await callWithRetry('DELETE', `/orders/${delCookingKey}`, { token: mama.token })
  check('「正在做」的记录也删不掉 → 409（做到一半把记录抹掉，厨房那口锅可不会跟着消失）', delCooking.status === 409, `${delCooking.status}`)
  await callWithRetry('DELETE', `/orders/meals/${delCookingKey}/items`, { token: mama.token })

  // 一年后的某一天：形状合法、库里没有记录 —— 用来说明"404 ≠ 不能删，是没这条"
  const delMissing = await callWithRetry('DELETE', '/orders/2027-01-01-DINNER', { token: mama.token })
  check('删一餐根本没有记录的 → 404（不是静默成功）', delMissing.status === 404, `${delMissing.status} ${delMissing.body?.message ?? ''}`)

  // ② 已经做好的一餐整条删掉：先挂一张成品照，删完要能证明照片活着（CheckIn 是 SetNull，不是 Cascade）
  /*
   * 用**第 4 天晚餐**这一格：它在上一步"删不掉的待确认"里刚被退空，正好拿来验"能删的那一半"。
   * （槽位是有限的：0~2 天和 5/6 天被后面的断言占着，4/5 这两格才是我自己造自己清的。）
   */
  const delDoneKey = `${plusDaysKey(4)}-DINNER`
  await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: plusDaysKey(4), meal: 'DINNER' } })
  await callWithRetry('POST', `/orders/meals/${delDoneKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${delDoneKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  const delDone = await callWithRetry('POST', `/orders/meals/${delDoneKey}/status`, { token: mama.token, body: { status: 'DONE' } })
  check('为验证"删整条"，另起一餐推到「做好了」', delDone.status === 200 && delDone.body?.status === 'DONE', `${delDone.status} ${delDone.body?.status}`)

  const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]).toString('base64')
  const shot = await callWithRetry('POST', '/checkins', { token: mama.token, body: { image: tinyJpeg, note: '删记录前的成品照', mealKey: delDoneKey } })
  check('往那一餐挂一张成品照（为验"删记录不吃掉照片"）', [200, 201].includes(shot.status), `${shot.status} ${shot.body?.message ?? ''}`)

  const beforeDelete = await callWithRetry('GET', '/checkins', { token: mama.token })
  const photosBefore = beforeDelete.body?.total ?? 0

  const deleted = await callWithRetry('DELETE', `/orders/${delDoneKey}`, { token: son.token })
  check(
    '「做好了」的记录由**吃货**删得掉 200，并带回去删掉了什么（几道菜、几张成品照）',
    deleted.status === 200
      && deleted.body?.mealKey === delDoneKey
      && deleted.body?.dishCount === 1
      && deleted.body?.photoCount === 1
      && typeof deleted.body?.mealLabel === 'string',
    `${deleted.status} ${JSON.stringify(deleted.body)}`,
  )

  const afterDelete = await callWithRetry('GET', '/orders', { token: mama.token })
  check('删掉之后这一餐不在列表里了', !(afterDelete.body?.cards ?? []).some(card => card.mealKey === delDoneKey), `keys=${JSON.stringify((afterDelete.body?.cards ?? []).map(c => c.mealKey))}`)

  /*
   * 那一格回到"没有安排"要用**本周菜单**看，不能用历史：历史是**从今天往前**铺的
   * （`to` 默认今天），而被删的这条在第 5 天——它在未来，历史窗口里根本不该出现它
   * （第一版就写成了查历史，于是断言拿到 undefined，看着像功能坏了）。
   */
  const boardAfterDelete = await callWithRetry('GET', '/orders/plan?days=7', { token: mama.token })
  const delDoneRow = (boardAfterDelete.body?.days ?? [])
    .find(day => day.date === plusDaysKey(4))?.meals?.find(m => m.meal === 'DINNER')
  check(
    '删掉之后那一格回到"没有安排"（同一天另一餐不受影响）',
    delDoneRow?.dishCount === 0 && delDoneRow?.status === null && delDoneRow?.state === 'none',
    JSON.stringify(delDoneRow && { meal: delDoneRow.meal, dishCount: delDoneRow.dishCount, status: delDoneRow.status, state: delDoneRow.state }),
  )

  const delAgain = await callWithRetry('DELETE', `/orders/${delDoneKey}`, { token: mama.token })
  check('再删一次（记录已经没了）→ 404', delAgain.status === 404, `${delAgain.status}`)

  const wall = await callWithRetry('GET', '/checkins', { token: mama.token })
  const lonely = (wall.body?.items ?? []).find(item => item.note === '删记录前的成品照')
  check(
    '成品照**没跟着记录一起死**：总数不变，那张照片退回成"没挂餐次"的独立打卡',
    (wall.body?.total ?? 0) === photosBefore && Boolean(lonely) && lonely.mealKey === null,
    `total=${wall.body?.total}（删前 ${photosBefore}）mealKey=${lonely ? JSON.stringify(lonely.mealKey) : '照片不见了'}`,
  )

  // 取消整餐：新建一餐来验（已做好那餐动不了）
  const cancelTarget = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: TOMORROW, meal: 'DINNER' } })
  const cancelKey = `${TOMORROW}-DINNER`
  check('为验证取消，新建了明天晚餐这张卡', cancelTarget.status === 201 && cancelTarget.body?.mealKey === cancelKey, `${cancelTarget.status} ${cancelTarget.body?.mealKey}`)

  const eaterCancel = await callWithRetry('POST', `/orders/meals/${cancelKey}/status`, { token: son.token, body: { status: 'CANCELED' } })
  check('吃货取消整餐 → 403', eaterCancel.status === 403, `${eaterCancel.status}`)

  // 先定一次，好在取消时验"留痕被清掉"（取消自己也要有东西可清）
  const plannedThen = await callWithRetry('POST', `/orders/meals/${cancelKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  check(
    '另一餐定下时也记留痕（不是只有今天晚餐那一次）',
    plannedThen.status === 200 && plannedThen.body?.confirmedBy?.nickname === '妈妈',
    `${plannedThen.status} confirmedBy=${JSON.stringify(plannedThen.body?.confirmedBy)}`,
  )

  const canceled = await callWithRetry('POST', `/orders/meals/${cancelKey}/status`, { token: mama.token, body: { status: 'CANCELED' } })
  check(
    '掌勺人取消整餐 200',
    canceled.status === 200 && canceled.body?.status === 'CANCELED',
    `${canceled.status} status=${canceled.body?.status}`,
  )
  check(
    '取消会清掉留痕：这一版菜单作废了，"谁定的"不再成立',
    canceled.body?.confirmedBy === null && canceled.body?.confirmedAt === null,
    `confirmedBy=${JSON.stringify(canceled.body?.confirmedBy)} confirmedAt=${canceled.body?.confirmedAt}`,
  )

  // 取消后反悔：必须还能重新点这一餐，否则一家人取消晚餐就再也点不了这一餐了
  const revived = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TOMORROW, meal: 'DINNER' } })
  check(
    '取消过的餐还能重新点菜，并自动复活成「待确认」',
    revived.status === 201 && revived.body?.mealKey === cancelKey && revived.body?.status === 'PENDING',
    `${revived.status} key=${revived.body?.mealKey} status=${revived.body?.status}`,
  )
  check(
    '复活后留痕仍然是空的（菜单回到收集中，翻篇了）',
    revived.body?.confirmedBy === null && revived.body?.confirmedAt === null,
    `confirmedBy=${JSON.stringify(revived.body?.confirmedBy)} confirmedAt=${revived.body?.confirmedAt}`,
  )
  check(
    '复活后的餐里，取消动作带 needsConfirm=true（前端据此弹二次确认）',
    (revived.body?.nextActions ?? []).find(a => a.status === 'CANCELED')?.needsConfirm === true,
    JSON.stringify(revived.body?.nextActions),
  )

  // ---------- 共享开关（F2-07 首次真正生效） ----------
  const sonSeesAll = await callWithRetry('GET', '/orders', { token: son.token })
  check('共享开启时吃货看得到全家', sonSeesAll.body?.scope === 'family', `scope=${sonSeesAll.body?.scope}`)

  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  check('掌勺人关掉共享开关 200', sharedOff.status === 200 && sharedOff.body?.shared === false, `${sharedOff.status}`)

  // 先让小满真正点一道菜（否则共享关闭后列表为空，`every` 在空数组上恒真，等于没验）
  const sonReorder = await callWithRetry('POST', '/orders/items', { token: son.token, body: { recipeId: dishA.id, mealDate: TOMORROW, meal: 'LUNCH' } })
  check('共享关闭时吃货自己仍能点菜（开关只收窄可见范围，不挡点菜）', sonReorder.status === 201, `${sonReorder.status}`)

  const sonNarrowed = await callWithRetry('GET', '/orders', { token: son.token })
  const narrowedCards = sonNarrowed.body?.cards ?? []
  /*
   * 判据从"比总数小"改成**逐张核对**：早先这里是 `narrowed.length < familyAfterGuest.length`，
   * 而那个快照是几段之前取的——后来小满又在今天晚餐里加了一道（加菜放开之后），
   * 他参与过的餐次变多，"总数"就不再是这件事的判据了（会随数据漂成假红）。
   * 现在直接问一句：**全家视角里"我没有份"的那几餐，是不是都不在我的列表里**。
   */
  // 判据要用**吃货自己**在共享还开着时的那份视角里"我没份"的餐次
  // （拿掌勺人的 mineCount 去推吃货的可见性是想当然：同一张卡两个人的份各不相同）
  const notMine = (sonSeesAll.body?.cards ?? []).filter(card => card.mineCount === 0)
  check(
    '共享关闭后吃货只看到自己参与的餐次（F2-07 生效）',
    sonNarrowed.status === 200
      && narrowedCards.length > 0
      && narrowedCards.every(card => card.mineCount > 0)
      && narrowedCards.some(card => card.mealKey === `${TOMORROW}-LUNCH`)
      && notMine.length > 0
      && notMine.every(card => !narrowedCards.some(mine => mine.mealKey === card.mealKey)),
    `cards=${narrowedCards.length} (共享开着时 ${(sonSeesAll.body?.cards ?? []).length}) 我没份的=${JSON.stringify(notMine.map(c => c.mealKey))} keys=${JSON.stringify(narrowedCards.map(c => c.mealKey))}`,
  )
  const mamaStillAll = await callWithRetry('GET', '/orders', { token: mama.token })
  const mamaKeys = (mamaStillAll.body?.cards ?? []).map(card => card.mealKey)
  const sonKeys = narrowedCards.map(card => card.mealKey)
  check(
    '共享关闭不影响掌勺人看全量（他要负责做饭）',
    mamaStillAll.status === 200
      && mamaKeys.length > sonKeys.length
      && sonKeys.every(key => mamaKeys.includes(key)),
    `掌勺人 ${JSON.stringify(mamaKeys)} vs 吃货 ${JSON.stringify(sonKeys)}`,
  )
  const mineUnaffected = await callWithRetry('GET', '/orders?family=false', { token: son.token })
  check('「只看我的」视图不受共享开关影响', mineUnaffected.status === 200 && mineUnaffected.body?.scope === 'mine', `${mineUnaffected.status}`)

  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

  // ---------- 日期边界（备菜计划把窗口从 3 天扩到 7 天，F4-03） ----------
  const farAway = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: '2027-01-01', meal: 'LUNCH' } })
  check('点远期的菜 → 400（窗口之外）', farAway.status === 400, `${farAway.status} ${farAway.body?.message ?? ''}`)

  const yesterday = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(-1), meal: 'LUNCH' } })
  check('点昨天 → 400（过期的一天不能补）', yesterday.status === 400, `${yesterday.status} ${yesterday.body?.message ?? ''}`)

  const seventhDay = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(5), meal: 'LUNCH' } })
  check('点第 7 天 → 201（备菜计划最后一行也要能安排：看得见的都能点）', seventhDay.status === 201 || seventhDay.status === 200, `${seventhDay.status} ${seventhDay.body?.message ?? ''}`)

  const eighthDay = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(7), meal: 'LUNCH' } })
  check('点第 8 天 → 400（窗口是今天起 7 格）', eighthDay.status === 400, `${eighthDay.status} ${eighthDay.body?.message ?? ''}`)
  check('越界提示语跟着窗口生成（说的是"这 7 天"，不是写死的"今天或明天"）', /这 7 天/.test(eighthDay.body?.message ?? ''), `${eighthDay.body?.message ?? ''}`)

  const badMeal = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'BREAKFAST' } })
  check('非法餐次 → 400', badMeal.status === 400, `${badMeal.status}`)

  const noRecipe = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: 'no-such-recipe-id', mealDate: TODAY, meal: 'LUNCH' } })
  check('菜谱不存在 → 404', noRecipe.status === 404, `${noRecipe.status} ${noRecipe.body?.message ?? ''}`)

  const noRecipeId = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { mealDate: TODAY, meal: 'LUNCH' } })
  check('既没给菜谱 id 也没给菜名 → 400', noRecipeId.status === 400, `${noRecipeId.status} ${noRecipeId.body?.message ?? ''}`)

  const longNote = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'LUNCH', note: '辣'.repeat(121) } })
  check('备注超长（>120 字）→ 400', longNote.status === 400, `${longNote.status}`)

  // ---------- 自由菜品（F3-10）：自己写一道，不进菜谱库 ----------
  const bothTargets = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishA.id, dishName: '外婆的红烧肉', mealDate: TODAY, meal: 'LUNCH' },
  })
  check('同时给菜谱与菜名 → 400（静默挑一个会把用户意图藏起来）', bothTargets.status === 400, `${bothTargets.status} ${bothTargets.body?.message ?? ''}`)

  const blankName = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: '   ', mealDate: TODAY, meal: 'LUNCH' },
  })
  check('菜名只有空白 → 400', blankName.status === 400, `${blankName.status} ${blankName.body?.message ?? ''}`)

  const longName = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: '好'.repeat(31), mealDate: TODAY, meal: 'LUNCH' },
  })
  check('菜名超长（>30 字）→ 400', longName.status === 400, `${longName.status} ${longName.body?.message ?? ''}`)

  const freeDish = await callWithRetry('POST', '/orders/items', {
    token: son.token,
    body: { dishName: '  外婆的糖醋小排  ', mealDate: DAY_AFTER, meal: 'LUNCH', note: '少放糖' },
  })
  check(
    '自己写一道 → 201，菜名去首尾空格、recipeId 为空、备注照常带上',
    freeDish.status === 201
      && freeDish.body?.mealKey === `${DAY_AFTER}-LUNCH`
      && freeDish.body?.dishes?.some(d => d.name === '外婆的糖醋小排' && d.recipeId === null && d.count === 1)
      && (freeDish.body?.items ?? []).some(i => i.name === '外婆的糖醋小排' && i.recipeId === null && i.note === '少放糖'),
    `${freeDish.status} ${JSON.stringify(freeDish.body?.dishes)}`,
  )

  const freeAgain = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: '外婆的糖醋小排', mealDate: DAY_AFTER, meal: 'LUNCH' },
  })
  check(
    '同一道自由菜被两个人点 → 合并成一条、份数 2（合并键退回菜名）',
    freeAgain.status === 201
      && (freeAgain.body?.dishes ?? []).filter(d => d.name === '外婆的糖醋小排').length === 1
      && (freeAgain.body?.dishes ?? []).find(d => d.name === '外婆的糖醋小排')?.count === 2,
    JSON.stringify(freeAgain.body?.dishes),
  )

  // 菜名与库里某道菜完全同名：挂到那道菜上，不然同一道菜会分成两行
  const sameName = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: dishA.name, mealDate: DAY_AFTER, meal: 'DINNER' },
  })
  check(
    '自己写的菜名与库里完全同名 → 挂到菜谱上（不是新开一行）',
    sameName.status === 201
      && (sameName.body?.dishes ?? []).some(d => d.name === dishA.name && d.recipeId === dishA.id),
    JSON.stringify(sameName.body?.dishes),
  )

  const freeOnPlan = await callWithRetry('GET', '/orders/plan', { token: son.token })
  const dayAfterLunch = (freeOnPlan.body?.days ?? []).find(d => d.date === DAY_AFTER)?.meals?.find(m => m.meal === 'LUNCH')
  check(
    '自由菜也进得了本周菜单（与菜谱点的菜无区别）',
    (dayAfterLunch?.dishes ?? []).some(d => d.includes('外婆的糖醋小排')),
    JSON.stringify(dayAfterLunch?.dishes),
  )

  // 注意不能写成 `GET /orders/meals/...`：那个路由压根不存在，404 来自"路由未匹配"，
  // 就算这一餐真的存在也会通过——是个永远绿的假断言。真要走服务层的"餐次不存在"分支。
  const missingMeal = await callWithRetry('POST', '/orders/meals/2027-01-01-DINNER/status', { token: mama.token, body: { status: 'PLANNED' } })
  check('未点过菜的餐次流转 → 404（服务层"这一餐还没有人点菜"）', missingMeal.status === 404, `${missingMeal.status} ${missingMeal.body?.message ?? ''}`)

  const badKey = await callWithRetry('POST', '/orders/meals/not-a-key/status', { token: mama.token, body: { status: 'PLANNED' } })
  check('畸形的餐次标识 → 400', badKey.status === 400, `${badKey.status}`)

  // ---------- 今日安排与就餐人数（M4 / F4-01、F4-05） ----------
  // 这一段自建自己需要的状态（往今天午餐点一道菜），不依赖前面的用例留下了什么
  const todayBoard = await callWithRetry('GET', '/orders/today', { token: mama.token })
  check(
    '今日安排永远给两行（午/晚餐），日期是今天（没点菜的那餐也要在，首页才看得出"晚饭还没人点"）',
    todayBoard.status === 200
      && todayBoard.body?.rows?.length === 2
      && todayBoard.body.rows.map(r => r.meal).join(',') === 'LUNCH,DINNER'
      && todayBoard.body?.date === TODAY,
    `${todayBoard.status} date=${todayBoard.body?.date} rows=${JSON.stringify((todayBoard.body?.rows ?? []).map(r => `${r.meal}:${r.state}`))}`,
  )
  check(
    '"还没人点"的行不编内容：没有菜名、道数为 0、状态为 null（不能拿别人的菜充数，也不能造一条假菜）',
    (todayBoard.body?.rows ?? []).every(r => (r.status === null
      ? r.state === 'none' && r.dishCount === 0 && (r.dishes ?? []).length === 0 && r.statusLabel === '还没人点'
      : true)),
    JSON.stringify((todayBoard.body?.rows ?? []).filter(r => r.status === null).map(r => ({ meal: r.meal, dishes: r.dishes, statusLabel: r.statusLabel }))),
  )
  check(
    '今日安排里的就餐人数默认是 null（还没定），不是 0',
    (todayBoard.body?.rows ?? []).every(r => r.dinerCount === null),
    JSON.stringify((todayBoard.body?.rows ?? []).map(r => r.dinerCount)),
  )

  // 自建一餐：今天午餐（前面的用例只用过晚餐与明天，午餐此时是空的）
  const lunchSeed = await callWithRetry('POST', '/orders/items', {
    token: son.token,
    body: { recipeId: dishA.id, mealDate: TODAY, meal: 'LUNCH' },
  })
  if (lunchSeed.status !== 201 && lunchSeed.status !== 200) throw new Error(`今日安排前置点菜失败：${lunchSeed.status} ${JSON.stringify(lunchSeed.body)}`)

  const boardWithLunch = await callWithRetry('GET', '/orders/today', { token: mama.token })
  const lunchRow = (boardWithLunch.body?.rows ?? []).find(r => r.meal === 'LUNCH')
  check(
    '点过菜的那行带上菜名、状态与 mealKey（点进去就是这一餐）',
    Boolean(lunchRow)
      && lunchRow.mealKey === `${TODAY}-LUNCH`
      && (lunchRow.dishes ?? []).length === 1
      && lunchRow.dishes[0] === dishA.name
      && lunchRow.status === 'PENDING'
      && lunchRow.state === 'open',
    JSON.stringify(lunchRow),
  )

  const dinersByEater = await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/diners`, { token: son.token, body: { dinerCount: 4 } })
  check('吃货设就餐人数 → 403（与安排菜单同一批人，需 menu.manage）', dinersByEater.status === 403, `${dinersByEater.status}`)

  const dinersSet = await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/diners`, { token: mama.token, body: { dinerCount: 4 } })
  check(
    '掌勺人设就餐人数 4 → 200 且卡片带回来（含没点菜只吃饭的家人，与"几人点了"是两回事）',
    dinersSet.status === 200 && dinersSet.body?.dinerCount === 4 && dinersSet.body?.ordererCount === 1,
    `${dinersSet.status} dinerCount=${dinersSet.body?.dinerCount} ordererCount=${dinersSet.body?.ordererCount}`,
  )
  const todayAfterSet = await callWithRetry('GET', '/orders/today', { token: mama.token })
  check(
    '今日安排读得到刚设的人数',
    (todayAfterSet.body?.rows ?? []).find(r => r.meal === 'LUNCH')?.dinerCount === 4,
    JSON.stringify((todayAfterSet.body?.rows ?? []).map(r => `${r.meal}:${r.dinerCount}`)),
  )

  const dinersZero = await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/diners`, { token: mama.token, body: { dinerCount: 0 } })
  check('就餐人数 0 → 400（0 个人吃饭没有意义，不能拿它当"未设定"）', dinersZero.status === 400, `${dinersZero.status} ${dinersZero.body?.message ?? ''}`)
  const dinersFraction = await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/diners`, { token: mama.token, body: { dinerCount: 2.5 } })
  check('就餐人数小数 → 400', dinersFraction.status === 400, `${dinersFraction.status}`)
  const dinersTooMany = await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/diners`, { token: mama.token, body: { dinerCount: 999 } })
  check('就餐人数超上限（>50）→ 400', dinersTooMany.status === 400, `${dinersTooMany.status}`)

  const dinersCleared = await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/diners`, { token: mama.token, body: { dinerCount: null } })
  check('传 null 清除设定（回到"还没定"而不是 0）', dinersCleared.status === 200 && dinersCleared.body?.dinerCount === null, `${dinersCleared.status} dinerCount=${dinersCleared.body?.dinerCount}`)

  const dinersMissing = await callWithRetry('POST', '/orders/meals/2027-01-01-LUNCH/diners', { token: mama.token, body: { dinerCount: 3 } })
  check('给没点菜的餐设人数 → 404（服务层"这一餐还没有人点菜"）', dinersMissing.status === 404, `${dinersMissing.status}`)

  // ---------- 本周菜单（M4 / F4-02） ----------
  // 同样自建前置状态：今天午餐前面已经点过（lunchSeed），这里再往前安排一格"后天晚餐"
  const planBoard = await callWithRetry('GET', '/orders/plan', { token: mama.token })
  check(
    '本周菜单默认给 3 天 × 午晚两餐（今天/明天/后天），没安排的也占行',
    planBoard.status === 200
      && planBoard.body?.days?.length === 3
      && planBoard.body.days.map(d => d.date).join(',') === `${TODAY},${TOMORROW},${DAY_AFTER}`
      && planBoard.body.days.every(d => (d.meals ?? []).length === 2
        && d.meals.map(m => m.meal).join(',') === 'LUNCH,DINNER'),
    `${planBoard.status} days=${JSON.stringify((planBoard.body?.days ?? []).map(d => `${d.date}:${d.meals?.length}`))}`,
  )
  check(
    '每天带「今天/明天/后天」相对说法与星期（过了三天要落到具体星期）',
    planBoard.body?.days?.[0]?.label === '今天'
      && planBoard.body?.days?.[1]?.label === '明天'
      && planBoard.body?.days?.[2]?.label === '后天'
      && planBoard.body.days.every(d => d.weekday === weekdayOfKey(d.date)),
    JSON.stringify((planBoard.body?.days ?? []).map(d => `${d.label}(${d.weekday})`)),
  )
  check(
    '本周菜单里"没安排"的行不编内容：没有菜名、道数为 0、状态为 null',
    (planBoard.body?.days ?? []).every(d => d.meals.every(m => (m.status === null
      ? m.state === 'none' && m.dishCount === 0 && (m.dishes ?? []).length === 0
      : true))),
    JSON.stringify((planBoard.body?.days ?? []).flatMap(d => d.meals.filter(m => m.status === null).map(m => `${d.date}-${m.meal}:${m.statusLabel}`))),
  )

  const planSeed = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishB.id, mealDate: DAY_AFTER, meal: 'DINNER' },
  })
  if (![200, 201].includes(planSeed.status)) throw new Error(`本周菜单前置点菜失败：${planSeed.status} ${JSON.stringify(planSeed.body)}`)

  const planAfterSeed = await callWithRetry('GET', '/orders/plan', { token: mama.token })
  const lastDay = (planAfterSeed.body?.days ?? []).find(d => d.date === DAY_AFTER)
  const lastDinner = (lastDay?.meals ?? []).find(m => m.meal === 'DINNER')
  check(
    '安排过的那一格带上菜名与状态，且 mealKey 对得上（点进去就是这一餐）',
    lastDinner?.mealKey === `${DAY_AFTER}-DINNER`
      && (lastDinner?.dishes ?? []).includes(dishB.name)
      && lastDinner?.status === 'PENDING'
      && lastDinner?.state === 'open',
    JSON.stringify(lastDinner),
  )
  check(
    '后天的菜真的点得进去了（点菜窗口含后天，不然那格的「去安排」是死路）',
    planSeed.body?.mealKey === `${DAY_AFTER}-DINNER`,
    `${planSeed.status} ${planSeed.body?.mealKey ?? ''}`,
  )

  const planDays5 = await callWithRetry('GET', '/orders/plan?days=5', { token: mama.token })
  check(
    'days 参数能放开到 5 天（备菜计划的窗口预演），标签从第 4 天起改用星期',
    planDays5.status === 200
      && planDays5.body?.days?.length === 5
      && planDays5.body.days.slice(3).every(d => /^周[日一二三四五六]$/.test(d.label)),
    `${planDays5.status} labels=${JSON.stringify((planDays5.body?.days ?? []).map(d => d.label))}`,
  )

  // ---------- 备菜计划（M4 / F4-03） ----------
  const prepBoard = await callWithRetry('GET', '/orders/plan?days=7', { token: mama.token })
  check(
    '备菜计划拿到 7 天 × 午晚 = 14 行（这一页要"排满一周"）',
    prepBoard.status === 200
      && prepBoard.body?.days?.length === 7
      && prepBoard.body.days.every(d => (d.meals ?? []).length === 2),
    `${prepBoard.status} days=${prepBoard.body?.days?.length} rows=${(prepBoard.body?.days ?? []).reduce((n, d) => n + (d.meals?.length ?? 0), 0)}`,
  )
  check(
    '7 天的窗口里第 4～7 天都在这（不是只有前三天，后面四天根本没有行）',
    prepBoard.body?.days?.slice(3).every(d => /^周[日一二三四五六]$/.test(d.label) && /^\d{4}-\d{2}-\d{2}$/.test(d.date)),
    JSON.stringify((prepBoard.body?.days ?? []).map(d => `${d.date}(${d.label})`)),
  )
  // 今天午餐在前面被推成过「已做好/已取消」（终态是 DONE 或 CANCELED），所以那一格的 canAdd 必须是 false；
  // 空行与"收集中"的行必须是 true——「加菜」按钮出不出现由这个字段决定，前端不复刻状态机。
  // 不写死"今天午餐=DONE"：这一格到哪一步取决于本脚本前面的流转与库里已有数据，
  // 写死的是**关系**（settled ⟺ 不能加），那才是这条规则本身。
  const prepRows = (prepBoard.body?.days ?? []).flatMap(d => (d.meals ?? []).map(m => ({ date: d.date, ...m })))
  check(
    '每一行都带 canAdd（「加菜」按钮按它决定出不出现）',
    prepRows.every(r => typeof r.canAdd === 'boolean'),
    JSON.stringify(prepRows.slice(0, 3).map(r => `${r.date}-${r.meal}:${r.canAdd}`)),
  )
  check(
    '收集中/空着的餐 canAdd=true（备菜时"这道后天中午也来一份"是最常做的事）',
    prepRows.filter(r => r.state !== 'settled').every(r => r.canAdd === true),
    JSON.stringify(prepRows.filter(r => r.state !== 'settled').map(r => `${r.date}-${r.meal}:${r.canAdd}`)),
  )
  check(
    '已做好/已取消的餐 canAdd=false（加不进去，给按钮等于让人白点一次）',
    prepRows.some(r => r.state === 'settled')
      && prepRows.filter(r => r.state === 'settled').every(r => r.canAdd === false),
    JSON.stringify(prepRows.filter(r => r.state === 'settled').map(r => `${r.date}-${r.meal}:${r.status}:${r.canAdd}`)),
  )

  const prepSeventhDay = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishB.id, mealDate: plusDaysKey(6), meal: 'DINNER' },
  })
  check(
    '备菜计划最后一天（第 7 天）真的能点进去（不然那一行的「加菜」是死路）',
    [200, 201].includes(prepSeventhDay.status) && prepSeventhDay.body?.mealKey === `${plusDaysKey(6)}-DINNER`,
    `${prepSeventhDay.status} ${prepSeventhDay.body?.mealKey ?? prepSeventhDay.body?.message ?? ''}`,
  )

  const planDaysBad = await callWithRetry('GET', '/orders/plan?days=8', { token: mama.token })
  check('days 超上限（>7）→ 400', planDaysBad.status === 400, `${planDaysBad.status} ${planDaysBad.body?.message ?? ''}`)
  const planBad = await callWithRetry('GET', '/orders/plan?days=abc', { token: mama.token })
  check('days 非数字 → 400', planBad.status === 400, `${planBad.status}`)
  const planAnonymous = await callWithRetry('GET', '/orders/plan')
  check('未带 token 看本周菜单 → 401', planAnonymous.status === 401, `${planAnonymous.status}`)

  // 共享关闭时吃货的收窄（与今日安排同一套可见性）
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  const planForSon = await callWithRetry('GET', '/orders/plan', { token: son.token })
  const sonLastDinner = (planForSon.body?.days ?? []).find(d => d.date === DAY_AFTER)?.meals?.find(m => m.meal === 'DINNER')
  check(
    '共享关闭时吃货看不到别人安排的餐：整格与"真没人安排"完全一致（菜名、状态、人数、张数都不漏），scope=mine 让前端说明原因',
    planForSon.status === 200
      && planForSon.body?.scope === 'mine'
      && sonLastDinner?.state === 'none'
      && sonLastDinner?.status === null
      && sonLastDinner?.statusLabel === '还没安排'
      && sonLastDinner?.dishCount === 0
      && (sonLastDinner?.dishes ?? []).length === 0
      && sonLastDinner?.dinerCount === null
      && sonLastDinner?.photoCount === 0,
    `${planForSon.status} scope=${planForSon.body?.scope} ${JSON.stringify(sonLastDinner)}`,
  )
  const planMamaClosed = await callWithRetry('GET', '/orders/plan', { token: mama.token })
  const mamaDinnerClosed = (planMamaClosed.body?.days ?? []).find(d => d.date === DAY_AFTER)?.meals?.find(m => m.meal === 'DINNER')
  check(
    '共享关闭不影响掌勺人（他要做饭，仍看得到全量）',
    planMamaClosed.body?.scope === 'family' && (mamaDinnerClosed?.dishes ?? []).includes(dishB.name),
    `scope=${planMamaClosed.body?.scope} ${JSON.stringify(mamaDinnerClosed)}`,
  )
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })
  const planSonSharedOn = await callWithRetry('GET', '/orders/plan', { token: son.token })
  const sonDinnerSharedOn = (planSonSharedOn.body?.days ?? []).find(d => d.date === DAY_AFTER)?.meals?.find(m => m.meal === 'DINNER')
  check(
    '共享开回来后吃货又能看到那一格（scope=family，提示随之消失）',
    planSonSharedOn.body?.scope === 'family' && (sonDinnerSharedOn?.dishes ?? []).includes(dishB.name),
    `scope=${planSonSharedOn.body?.scope} ${JSON.stringify(sonDinnerSharedOn)}`,
  )

  // ---------- 再点一次（F3-06 / D-034） ----------
  /*
   * 用一个**独立家庭**验，免得与上面那些卡互相干扰（上面的卡状态被推来推去，
   * "哪一餐能当来源"会跟着变，断言就脆了）。
   *
   * 来源用「已做好」的那一餐（终态）——另一条来源路径是"日子已经过去"，
   * 但**接口不让人补点过去的日子**（上面就有"点昨天 → 400"），
   * 所以那条只能由单测钉（见 orders.rules.test.ts 的 canRepeatFrom）。
   */
  const repeatMama = await newUser('复盘妈妈')
  const repeatHome = await callWithRetry('POST', '/family', { token: repeatMama.token, body: { name: '再点一次验收家' } })
  if (repeatHome.status !== 201) throw new Error(`建家失败：${repeatHome.status} ${JSON.stringify(repeatHome.body)}`)
  const repeatCode = repeatHome.body.inviteCode
  const repeatSon = await newUser('复盘小满')
  const repeatJoined = await joinFamily(repeatSon.token, repeatCode)
  if (repeatJoined.status !== 200) throw new Error(`加入失败：${repeatJoined.status}`)

  const recipes3 = await callWithRetry('GET', '/recipes?pageSize=3')
  const [repA, repB, repC] = recipes3.body?.items ?? []
  if (!repA || !repB || !repC) throw new Error('菜谱库不足 3 道，无法验收"再点一次"')

  // 来源那一餐：明天晚餐 —— 妈妈点 A（带备注）、小满点 B 两份，然后推到「已做好」
  const SOURCE_KEY = `${TOMORROW}-DINNER`
  await callWithRetry('POST', '/orders/items', { token: repeatMama.token, body: { recipeId: repA.id, mealDate: TOMORROW, meal: 'DINNER', note: '少放盐' } })
  await callWithRetry('POST', '/orders/items', { token: repeatSon.token, body: { recipeId: repB.id, mealDate: TOMORROW, meal: 'DINNER' } })
  const sourceCard = await callWithRetry('POST', '/orders/items', { token: repeatSon.token, body: { recipeId: repB.id, mealDate: TOMORROW, meal: 'DINNER' } })

  check(
    '还在收集中的那一餐不给「再点一次」入口（要加菜直接点那道菜）',
    sourceCard.status === 201 && sourceCard.body?.canRepeat === false,
    `status=${sourceCard.body?.status} canRepeat=${sourceCard.body?.canRepeat}`,
  )

  const fromOpen = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, {
    token: repeatMama.token,
    body: { mealDate: DAY_AFTER, meal: 'LUNCH' },
  })
  check(
    '拿还在收集中的那一餐当来源 → 409（前端不给入口，接口也挡住）',
    fromOpen.status === 409,
    `${fromOpen.status} ${fromOpen.body?.message ?? ''}`,
  )

  await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/status`, { token: repeatMama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/status`, { token: repeatMama.token, body: { status: 'COOKING' } })
  const sourceDone = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/status`, { token: repeatMama.token, body: { status: 'DONE' } })
  check(
    '做好了的那一餐可以当「再点一次」来源（终态：要重做就照它点）',
    sourceDone.status === 200 && sourceDone.body?.canRepeat === true,
    `status=${sourceDone.body?.status} canRepeat=${sourceDone.body?.canRepeat}`,
  )

  // 照到"后天午餐"：一开是空的 → 整桌照抄（重复的那道只收一份）
  const TARGET_LUNCH = `${DAY_AFTER}-LUNCH`
  const repeated = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, {
    token: repeatMama.token,
    body: { mealDate: DAY_AFTER, meal: 'LUNCH' },
  })
  check(
    '整桌照抄到后天午餐：加了 2 道（来源里点两份的那道只收一份），落在那张卡上',
    repeated.status === 200
      && (repeated.body?.added ?? []).length === 2
      && repeated.body?.card?.mealKey === TARGET_LUNCH
      && repeated.body?.card?.dishCount === 2,
    `${repeated.status} added=${JSON.stringify(repeated.body?.added)} card=${repeated.body?.card?.mealKey} dishCount=${repeated.body?.card?.dishCount}`,
  )
  check(
    '照抄过来的菜**不带备注**（备注是那个人对那一餐的交代，照抄会变成他没说过的话）',
    (repeated.body?.card?.dishes ?? []).every(line => line.notes.length === 0),
    JSON.stringify((repeated.body?.card?.dishes ?? []).map(line => ({ name: line.name, notes: line.notes }))),
  )
  check(
    '来源里点两份的那道，照抄后是 1 份（份数是那一餐的投票结果，不是菜谱用量）',
    (repeated.body?.card?.dishes ?? []).every(line => line.count === 1),
    JSON.stringify((repeated.body?.card?.dishes ?? []).map(line => `${line.name}x${line.count}`)),
  )
  check(
    '照抄出来的菜是**我点的**（不是把原来点菜的人一起搬过来：这一餐还没人表态）',
    repeated.body?.card?.mineCount === 2 && repeated.body?.card?.ordererCount === 1,
    `mineCount=${repeated.body?.card?.mineCount} ordererCount=${repeated.body?.card?.ordererCount} orderers=${JSON.stringify(repeated.body?.card?.orderers)}`,
  )

  // 再点一次同一餐：全都已经有了 → 幂等，且如实说"都有了"，不新增条目
  const repeatAgain = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, {
    token: repeatSon.token,
    body: { mealDate: DAY_AFTER, meal: 'LUNCH' },
  })
  check(
    '同一桌再点一次：全都跳过、不新增（幂等），并给出一句"都有了"',
    repeatAgain.status === 200
      && (repeatAgain.body?.added ?? []).length === 0
      && (repeatAgain.body?.skipped ?? []).length === 2
      && repeatAgain.body?.card?.dishCount === 2
      && typeof repeatAgain.body?.message === 'string',
    `${repeatAgain.status} added=${(repeatAgain.body?.added ?? []).length} skipped=${(repeatAgain.body?.skipped ?? []).length} dishCount=${repeatAgain.body?.card?.dishCount} msg=${repeatAgain.body?.message}`,
  )

  // 目标那一餐已经有其中一道 → 只补缺的那一道，已有的如实报"本来就有"
  const partialTarget = await callWithRetry('POST', '/orders/items', {
    token: repeatMama.token,
    body: { recipeId: repA.id, mealDate: DAY_AFTER, meal: 'DINNER' },
  })
  check('为验"部分已有"，先在后天晚餐放一道', partialTarget.status === 201, `${partialTarget.status}`)
  const partial = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, {
    token: repeatMama.token,
    body: { mealDate: DAY_AFTER, meal: 'DINNER' },
  })
  check(
    '目标那一餐已有其中一道：只补缺的那道，已有的报进 skipped（不凑成两份）',
    partial.status === 200
      && (partial.body?.added ?? []).length === 1
      && (partial.body?.skipped ?? []).length === 1
      && partial.body?.card?.dishCount === 2,
    `${partial.status} added=${JSON.stringify(partial.body?.added)} skipped=${JSON.stringify(partial.body?.skipped)} dishCount=${partial.body?.card?.dishCount}`,
  )

  const fromMissing = await callWithRetry('POST', `/orders/meals/2026-01-01-DINNER/repeat`, {
    token: repeatMama.token,
    body: { mealDate: DAY_AFTER, meal: 'LUNCH' },
  })
  check('来源那一餐不存在 → 404', fromMissing.status === 404, `${fromMissing.status} ${fromMissing.body?.message ?? ''}`)

  const repeatNoBody = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, { token: repeatMama.token, body: {} })
  check('没说照到哪一餐 → 400（不猜默认值）', repeatNoBody.status === 400, `${repeatNoBody.status} ${repeatNoBody.body?.message ?? ''}`)

  const repeatFar = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, {
    token: repeatMama.token,
    body: { mealDate: '2027-01-01', meal: 'LUNCH' },
  })
  check('照到窗口之外的日子 → 400（与手点同一套日期校验）', repeatFar.status === 400, `${repeatFar.status} ${repeatFar.body?.message ?? ''}`)

  const repeatBadKey = await callWithRetry('POST', `/orders/meals/not-a-meal-key/repeat`, {
    token: repeatMama.token,
    body: { mealDate: DAY_AFTER, meal: 'LUNCH' },
  })
  check('来源标识不是一餐 → 400', repeatBadKey.status === 400, `${repeatBadKey.status}`)

  const repeatAnon = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, { body: { mealDate: DAY_AFTER, meal: 'LUNCH' } })
  check('未登录照抄 → 401', repeatAnon.status === 401, `${repeatAnon.status}`)

  // 目标那一餐已经定局（已做好）→ 409：整桌要么都进、要么都不进
  await callWithRetry('POST', '/orders/items', { token: repeatMama.token, body: { recipeId: repC.id, mealDate: plusDaysKey(3), meal: 'DINNER' } })
  const DONE_TARGET = `${plusDaysKey(3)}-DINNER`
  await callWithRetry('POST', `/orders/meals/${DONE_TARGET}/status`, { token: repeatMama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${DONE_TARGET}/status`, { token: repeatMama.token, body: { status: 'COOKING' } })
  await callWithRetry('POST', `/orders/meals/${DONE_TARGET}/status`, { token: repeatMama.token, body: { status: 'DONE' } })
  const intoDone = await callWithRetry('POST', `/orders/meals/${SOURCE_KEY}/repeat`, {
    token: repeatMama.token,
    body: { mealDate: plusDaysKey(3), meal: 'DINNER' },
  })
  check(
    '照到已经做好的一餐 → 409（那餐是终态，加不进去）',
    intoDone.status === 409,
    `${intoDone.status} ${intoDone.body?.message ?? ''}`,
  )
  const doneTargetAfter = await callWithRetry('GET', '/orders', { token: repeatMama.token })
  check(
    '加不进去时**一道都不该进去**（整桌要么都进、要么都不进）',
    doneTargetAfter.body?.cards?.find(card => card.mealKey === DONE_TARGET)?.dishCount === 1,
    `dishCount=${doneTargetAfter.body?.cards?.find(card => card.mealKey === DONE_TARGET)?.dishCount}`,
  )

  // ---------- 点单历史（F3-09 / D-035）：解决 R-19 的"60 张上限之外看不见" ----------
  const histMama = await newUser('历史妈妈')
  const histHome = await callWithRetry('POST', '/family', { token: histMama.token, body: { name: '历史验收家' } })
  if (histHome.status !== 201) throw new Error(`建家失败：${histHome.status}`)
  const histCode = histHome.body.inviteCode
  const histSon = await newUser('历史小满')
  const histJoined = await joinFamily(histSon.token, histCode)
  if (histJoined.status !== 200) throw new Error(`历史小满加入失败：${histJoined.status} ${JSON.stringify(histJoined.body)}`)

  const histRecipes = await callWithRetry('GET', '/recipes?pageSize=2')
  const [histA, histB] = histRecipes.body?.items ?? []
  if (!histA || !histB) throw new Error('菜谱库为空，无法验收历史')

  /*
   * 今天午晚各放一道（**两道都必须在窗口里**：接口不让人补点过去的日子，
   * 而默认窗口的结束日就是今天——放"明天"的话它不在这一页，断言会拿到 undefined）。
   * 由两个人分别点，顺带验"历史里也标得出有几个人点了"。
   */
  const histPutA = await callWithRetry('POST', '/orders/items', { token: histMama.token, body: { recipeId: histA.id, mealDate: TODAY, meal: 'DINNER' } })
  const histPutB = await callWithRetry('POST', '/orders/items', { token: histSon.token, body: { recipeId: histB.id, mealDate: TODAY, meal: 'LUNCH' } })
  if (histPutA.status !== 201 || histPutB.status !== 201) {
    throw new Error(`历史验收前置点菜失败：${histPutA.status} / ${histPutB.status} ${JSON.stringify(histPutB.body)}`)
  }

  const histAnonymous = await callWithRetry('GET', '/orders/history')
  check('未登录看历史 → 401', histAnonymous.status === 401, `${histAnonymous.status}`)

  const hist = await callWithRetry('GET', '/orders/history', { token: histMama.token })
  check(
    '历史一页默认最近 31 天，且**按天铺开**（没有记录的那天也在，午晚两格都有）',
    hist.status === 200
      && hist.body?.days?.length === 31
      && hist.body?.from === plusDaysKey(-30)
      && hist.body?.to === TODAY
      && hist.body?.days?.[0]?.date === TODAY
      && hist.body.days.every(d => d.meals.length === 2),
    `${hist.status} days=${hist.body?.days?.length} from=${hist.body?.from} to=${hist.body?.to} 首日=${hist.body?.days?.[0]?.date}`,
  )
  check(
    '历史给出星期标（回看时是按"那天周几"回忆的），且与日期对得上',
    hist.body?.days?.[0]?.weekday === weekdayOfKey(TODAY),
    `实际=${hist.body?.days?.[0]?.weekday} 期望=${weekdayOfKey(TODAY)}`,
  )

  const histTodayDinner = (hist.body?.days ?? []).find(d => d.date === TODAY)?.meals?.find(m => m.meal === 'DINNER')
  const histTodayLunch = (hist.body?.days ?? []).find(d => d.date === TODAY)?.meals?.find(m => m.meal === 'LUNCH')
  check(
    '历史里有内容的餐次带上菜名、状态与"几个人点了"（两个人点的事都看得出来）',
    histTodayDinner?.dishCount === 1
      && (histTodayDinner?.dishes ?? []).includes(histA.name)
      && histTodayDinner?.status === 'PENDING'
      && histTodayLunch?.dishCount === 1
      && (histTodayLunch?.dishes ?? []).includes(histB.name)
      && histTodayLunch?.ordererCount === 1,
    `今天晚餐=${JSON.stringify(histTodayDinner)} 今天午餐=${JSON.stringify(histTodayLunch)}`,
  )
  check(
    '这一页的窗口**到 to 为止**（明天的安排在"历史"里不该出现——那是本周菜单的事）',
    !(hist.body?.days ?? []).some(d => d.date > (hist.body?.to ?? TODAY)),
    `to=${hist.body?.to} 最大日=${(hist.body?.days ?? []).map(d => d.date).sort().pop()}`,
  )
  /*
   * 空白格：拿**昨天**验（这个家的记录都在今天，昨天必然没有）。
   * 用昨天而不是"今天某一餐"，是因为今天的午晚现在都放了菜——写今天会让断言依赖
   * "哪一餐被占用"，加一条数据就红（这一版就是这么红的）。
   */
  const histYesterday = (hist.body?.days ?? []).find(d => d.date === plusDaysKey(-1))
  check(
    '历史里的空白格照样占位（每天都给午晚两行，没安排的那格 dishCount=0）',
    histYesterday !== undefined
      && histYesterday.meals.length === 2
      && histYesterday.meals.every(m => m.dishCount === 0 && m.dishes.length === 0 && m.state === 'none'),
    `昨天=${JSON.stringify(histYesterday)}`,
  )

  // 往前翻：这一页的结束日改成上一页的第一天
  const histPrev = await callWithRetry('GET', `/orders/history?to=${plusDaysKey(-30)}&pageSize=5`, { token: histMama.token })
  check(
    '按日期区间往前翻：窗口跟着 to 走，且**不与上一页重叠**',
    histPrev.status === 200
      && histPrev.body?.to === plusDaysKey(-30)
      && histPrev.body?.from === plusDaysKey(-34)
      && histPrev.body?.days?.length === 5
      && histPrev.body.days.every(d => d.date <= plusDaysKey(-30)),
    `${histPrev.status} from=${histPrev.body?.from} to=${histPrev.body?.to} days=${histPrev.body?.days?.length}`,
  )

  /*
   * hasMore 只能是 false：这个家今天才建，最早的点单就在窗口里（今天的晚餐 / 明天的午餐）。
   * "库里还有更早的餐次"那条路径造不出来——接口不让人补点过去的日子（上面有"点昨天 → 400"），
   * 那条由单测钉（见 orders.rules.test.ts 的 hasEarlier）。
   * 这里要挡住的是**反向的错**：不能明明没有更早的记录还说"还能往前翻"，
   * 那样用户会一直翻到空白页（家庭才用几天就点"再往前"，翻出来全是空的）。
   */
  const histSame = await callWithRetry('GET', '/orders/history', { token: histMama.token })
  check(
    '库里没有更早的餐次就说"到头了"（不让人一直翻空白页）',
    histSame.status === 200
      && histSame.body?.hasMore === false
      && histPrev.body?.hasMore === false,
    `最新一页 hasMore=${histSame.body?.hasMore} 往前一页 hasMore=${histPrev.body?.hasMore}`,
  )

  const histBadTo = await callWithRetry('GET', '/orders/history?to=2026/10/13', { token: histMama.token })
  check('历史的日期格式不对 → 400', histBadTo.status === 400, `${histBadTo.status} ${histBadTo.body?.message ?? ''}`)

  const histBadSize = await callWithRetry('GET', '/orders/history?pageSize=999', { token: histMama.token })
  check('历史一页天数超上限 → 400', histBadSize.status === 400, `${histBadSize.status} ${histBadSize.body?.message ?? ''}`)

  // 共享关闭：吃货只看得到自己参与的餐次（与列表同一套可见性）
  await callWithRetry('PATCH', '/family', { token: histMama.token, body: { shared: false } })
  const histSonClosed = await callWithRetry('GET', '/orders/history', { token: histSon.token })
  check(
    '共享关闭时吃货的历史也收窄（scope=mine，与列表同一套可见性）',
    histSonClosed.status === 200 && histSonClosed.body?.scope === 'mine',
    `scope=${histSonClosed.body?.scope}`,
  )
  await callWithRetry('PATCH', '/family', { token: histMama.token, body: { shared: true } })

  for (const item of results) {
    console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
