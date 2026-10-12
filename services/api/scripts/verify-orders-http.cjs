#!/usr/bin/env node
/**
 * 点单接口 HTTP 验收（真实请求，不 mock）。M3 / F3-01~F3-05，口径见 D-022。
 * 用法：先启动服务，再执行 pnpm run test:http:orders
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：点菜 → 合并成卡 → 撤回 → 状态机（含跳级/回退被拒）→ 权限（吃货推不动状态）
 *       → 共享开关收窄吃货可见范围 → 已安排后不能再加菜。
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

  // ---------- 撤回（F3-05） ----------
  // 注意：小满点了两道菜（B 一道、A 一道），要按菜名挑出 A 的那条，别用 items[0]
  const sonItems = (repeat.body?.items ?? []).filter(item => item.isMe)
  const sonDishAItem = sonItems.find(item => item.name === dishA.name)
  const sonDishBItem = sonItems.find(item => item.name === dishB.name)
  check(
    '卡片里标出哪些是我点的（前端据此给撤回入口）',
    sonItems.length === 2 && Boolean(sonDishAItem) && Boolean(sonDishBItem),
    `mineItems=${sonItems.length} dishes=${sonItems.map(i => i.name).join('/')}`,
  )

  const steal = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: mama.token })
  check('撤别人的菜 → 403', steal.status === 403, `${steal.status} ${steal.body?.message ?? ''}`)

  const withdraw = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: son.token })
  const dishACountAfterWithdraw = (withdraw.body?.dishes ?? []).find(d => d.name === dishA.name)?.count
  check(
    `撤回自己的一份 200，份数从 2 减到 1（撤回的是「${dishA.name}」）`,
    withdraw.status === 200 && dishACountAfterWithdraw === 1,
    `${withdraw.status} count=${dishACountAfterWithdraw}`,
  )

  // 整餐变空的情况单验（客人那一餐只有一盘菜），这里只验"我在这餐不再有份"
  const withdrawLast = await callWithRetry('DELETE', `/orders/items/${sonDishBItem?.id}`, { token: son.token })
  check(
    '撤掉自己在这一餐的最后一份：「我的份」归零，点菜人减为 1',
    withdrawLast.status === 200 && withdrawLast.body?.mineCount === 0 && withdrawLast.body?.ordererCount === 1,
    `${withdrawLast.status} mine=${withdrawLast.body?.mineCount} orderers=${withdrawLast.body?.ordererCount}`,
  )

  const goneItem = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: son.token })
  check('再撤同一条（已被撤）→ 404', goneItem.status === 404, `${goneItem.status}`)

  // 空卡清理：客人那餐只有他自己一盘，撤掉后这一餐整个消失
  const guestItems = await callWithRetry('GET', '/orders?family=false', { token: guest.token })
  const guestItemId = guestItems.body?.cards?.[0]?.items?.[0]?.id
  const guestWithdraw = await callWithRetry('DELETE', `/orders/items/${guestItemId}`, { token: guest.token })
  check(
    '撤掉整餐最后一份菜时，这张空卡被清掉（列表里不留 0 道菜的餐次）',
    guestWithdraw.status === 200
      && guestWithdraw.body?.dishCount === 0
      && (await callWithRetry('GET', '/orders', { token: mama.token })).body?.cards?.length === 1,
    `${guestWithdraw.status} dishCount=${guestWithdraw.body?.dishCount}`,
  )

  // ---------- 状态机（F3-02） ----------
  const mealKey = `${TODAY}-DINNER`

  const eaterPlan = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: son.token, body: { status: 'PLANNED' } })
  check('吃货推状态 → 403（点菜可以、安排不行，权限在后端强制）', eaterPlan.status === 403, `${eaterPlan.status} ${eaterPlan.body?.message ?? ''}`)

  const skip = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'DONE' } })
  check('跳级（待确认 → 已做好）→ 409', skip.status === 409, `${skip.status} ${skip.body?.message ?? ''}`)

  const badNext = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'FINISHED' } })
  check('非法状态值 → 400', badNext.status === 400, `${badNext.status}`)

  const planned = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  check(
    '掌勺人推「选好了」→ 已安排 200，且下一步只剩「开始做/取消」',
    planned.status === 200
      && planned.body?.status === 'PLANNED'
      && (planned.body?.nextActions ?? []).map(a => a.status).sort().join(',') === 'CANCELED,COOKING',
    `${planned.status} status=${planned.body?.status} next=${JSON.stringify((planned.body?.nextActions ?? []).map(a => a.status))}`,
  )

  const lockedAdd = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: TODAY, meal: 'DINNER' } })
  check('已安排的餐不能再加菜 → 409（要加先取消这餐）', lockedAdd.status === 409, `${lockedAdd.status} ${lockedAdd.body?.message ?? ''}`)

  const alreadyGone = await callWithRetry('DELETE', `/orders/items/${sonDishAItem?.id}`, { token: son.token })
  check('已被撤掉的条目再撤 → 404', alreadyGone.status === 404, `${alreadyGone.status}`)

  const rollback = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'PENDING' } })
  check('从已安排回退到待确认 → 409（不允许回退）', rollback.status === 409, `${rollback.status} ${rollback.body?.message ?? ''}`)

  const cooking = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  check('「开始做」→ 准备中 200', cooking.status === 200 && cooking.body?.status === 'COOKING', `${cooking.status} ${cooking.body?.status}`)

  const done = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'DONE' } })
  check(
    '「做好了」→ 已做好 200，且终态没有下一步',
    done.status === 200 && done.body?.status === 'DONE' && (done.body?.nextActions ?? []).length === 0,
    `${done.status} status=${done.body?.status} next=${(done.body?.nextActions ?? []).length}`,
  )

  const afterDone = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'CANCELED' } })
  check('已做好不能再取消（终态）→ 409', afterDone.status === 409, `${afterDone.status}`)

  // 取消整餐：新建一餐来验（已做好那餐动不了）
  const cancelTarget = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: TOMORROW, meal: 'DINNER' } })
  const cancelKey = `${TOMORROW}-DINNER`
  check('为验证取消，新建了明天晚餐这张卡', cancelTarget.status === 201 && cancelTarget.body?.mealKey === cancelKey, `${cancelTarget.status} ${cancelTarget.body?.mealKey}`)

  const eaterCancel = await callWithRetry('POST', `/orders/meals/${cancelKey}/status`, { token: son.token, body: { status: 'CANCELED' } })
  check('吃货取消整餐 → 403', eaterCancel.status === 403, `${eaterCancel.status}`)

  const canceled = await callWithRetry('POST', `/orders/meals/${cancelKey}/status`, { token: mama.token, body: { status: 'CANCELED' } })
  check(
    '掌勺人取消整餐 200',
    canceled.status === 200 && canceled.body?.status === 'CANCELED',
    `${canceled.status} status=${canceled.body?.status}`,
  )

  // 取消后反悔：必须还能重新点这一餐，否则一家人取消晚餐就再也点不了这一餐了
  const revived = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TOMORROW, meal: 'DINNER' } })
  check(
    '取消过的餐还能重新点菜，并自动复活成「待确认」',
    revived.status === 201 && revived.body?.mealKey === cancelKey && revived.body?.status === 'PENDING',
    `${revived.status} key=${revived.body?.mealKey} status=${revived.body?.status}`,
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
  check(
    '共享关闭后吃货只看到自己参与的餐次（F2-07 生效）',
    sonNarrowed.status === 200
      && narrowedCards.length > 0
      && narrowedCards.length < familyAfterGuest.body?.cards?.length
      && narrowedCards.every(card => card.mineCount > 0)
      && narrowedCards.some(card => card.mealKey === `${TOMORROW}-LUNCH`),
    `cards=${narrowedCards.length} (全家视角 ${familyAfterGuest.body?.cards?.length}) keys=${JSON.stringify(narrowedCards.map(c => c.mealKey))} allMine=${narrowedCards.every(c => c.mineCount > 0)}`,
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

  const seventhDay = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: plusDaysKey(6), meal: 'LUNCH' } })
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
