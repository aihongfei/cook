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
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function tomorrowKey() {
  const next = new Date(Date.now() + 86_400_000)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

async function main() {
  await settleThrottleWindow(() => call('POST', '/auth/login', { body: { account: 'throttle-probe', password: 'probe-not-valid' } }))

  const TODAY = todayKey()
  const TOMORROW = tomorrowKey()

  // ---------- 口径接口（免登录） ----------
  const options = await callWithRetry('GET', '/orders/options')
  check(
    '口径接口下发餐次、状态与可选日期（前端不硬编码）',
    options.status === 200
      && options.body?.meals?.length === 2
      && options.body?.statuses?.length === 5
      && options.body?.dayOptions?.length === 2,
    `${options.status} meals=${options.body?.meals?.length} statuses=${options.body?.statuses?.length} days=${options.body?.dayOptions?.length}`,
  )
  check(
    '可选日期只有今天与明天（更远的安排归 M4）',
    (options.body?.dayOptions ?? []).map(d => d.value).join(',') === `${TODAY},${TOMORROW}`,
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

  // ---------- 日期边界（D-022：只放今天/明天） ----------
  const farAway = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: '2027-01-01', meal: 'LUNCH' } })
  check('点远期的菜 → 400（只放今天/明天）', farAway.status === 400, `${farAway.status} ${farAway.body?.message ?? ''}`)

  const badMeal = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'BREAKFAST' } })
  check('非法餐次 → 400', badMeal.status === 400, `${badMeal.status}`)

  const noRecipe = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: 'no-such-recipe-id', mealDate: TODAY, meal: 'LUNCH' } })
  check('菜谱不存在 → 404', noRecipe.status === 404, `${noRecipe.status} ${noRecipe.body?.message ?? ''}`)

  const noRecipeId = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { mealDate: TODAY, meal: 'LUNCH' } })
  check('没带菜谱 id → 400', noRecipeId.status === 400, `${noRecipeId.status}`)

  const longNote = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'LUNCH', note: '辣'.repeat(121) } })
  check('备注超长（>120 字）→ 400', longNote.status === 400, `${longNote.status}`)

  const missingMeal = await callWithRetry('GET', '/orders/meals/2027-01-01-DINNER', { token: mama.token })
  check('未点过菜的餐次查不到（流转时 → 404）', missingMeal.status === 404, `${missingMeal.status}`)

  const badKey = await callWithRetry('POST', '/orders/meals/not-a-key/status', { token: mama.token, body: { status: 'PLANNED' } })
  check('畸形的餐次标识 → 400', badKey.status === 400, `${badKey.status}`)

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
