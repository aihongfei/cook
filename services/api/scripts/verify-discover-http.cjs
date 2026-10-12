#!/usr/bin/env node
/**
 * 家人最爱 / 家人常点接口 HTTP 验收（真实请求，不 mock）。M5 / F5-02，口径见 D-038。
 * 用法：先启动服务，再执行 pnpm run test:http:discover
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：未登录 401 → 没家庭 404 → 新家庭榜单为空（不编内容）→ **只有推到"已做好"的才算做过**
 *       （已安排不算、取消不算）→ 同一餐里两人各点一份**只算一次**（按餐去重）→
 *       收藏也算信号且**做过比收藏重** → 共享关掉后吃货只算自己的份（scope=mine，别人的不出现）
 *       → limit 校验。
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

/** 全局限流 60 次/分（按 IP 计数）；连跑第二遍会被自己打到 429，遇 429 等窗口重试 */
async function callWithRetry(method, path, options = {}) {
  for (let round = 0; round < 3; round += 1) {
    const response = await call(method, path, options)
    if (response.status !== 429) return response
    const waitMs = (Number(response.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 触发限流，等待 ${Math.round(waitMs / 1000)}s 后重试…`)
    await sleep(waitMs)
  }
  return call(method, path, options)
}

async function settleThrottleWindow() {
  for (let round = 0; round < 3; round += 1) {
    const attempt = await call('POST', '/auth/login', { body: { account: 'throttle-probe', password: 'probe-not-valid' } })
    if (attempt.status !== 429) return
    const waitMs = (Number(attempt.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 上一轮限流窗口未过期，等待 ${Math.round(waitMs / 1000)}s 后重跑…\n`)
    await sleep(waitMs)
  }
  throw new Error('限流窗口一直未恢复，无法开始验收（服务是否异常？）')
}

let seq = 0
async function newUser(nickname) {
  seq += 1
  const account = `dp${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: nickname ?? account },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, user: registered.body.user }
}

function dateKeyOf(offsetDays) {
  // 用本地日历算术（不用毫秒加减：跨夏令时会算错一天）
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const todayKey = () => dateKeyOf(0)

const names = (body) => (body?.items ?? []).map((item) => item.name)
const pickOf = (body, name) => (body?.items ?? []).find((item) => item.name === name) ?? null

/** 把某一餐推到"已做好"：PENDING → PLANNED → COOKING → DONE（状态机不许跳步） */
async function cookThrough(token, mealKey) {
  for (const status of ['PLANNED', 'COOKING', 'DONE']) {
    const moved = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token, body: { status } })
    if (moved.status !== 200 && moved.status !== 201) {
      throw new Error(`推到 ${status} 失败：${moved.status} ${JSON.stringify(moved.body)}`)
    }
  }
}

async function main() {
  await settleThrottleWindow()

  const recipes = await callWithRetry('GET', '/recipes?pageSize=4')
  const [dishA, dishB, dishC, dishD] = recipes.body?.items ?? []
  if (!dishA || !dishB || !dishC || !dishD) throw new Error('菜谱库不足 4 道，无法验收家人最爱')

  const mama = await newUser('最爱验收妈')
  const son = await newUser('最爱验收娃')

  // ---------- 未登录 / 没家庭 ----------
  const anonymous = await callWithRetry('GET', '/discover/family-picks')
  check('未带 token 看家人最爱 → 401', anonymous.status === 401, `${anonymous.status}`)

  const loner = await newUser('独居者')
  const noFamily = await callWithRetry('GET', '/discover/family-picks', { token: loner.token })
  check(
    '没有家庭的人看家人最爱 → 404 且话术可读（"我们家"没有家无从算起）',
    noFamily.status === 404 && typeof noFamily.body?.message === 'string',
    `${noFamily.status} ${noFamily.body?.message ?? ''}`,
  )

  // ---------- 新家庭：空榜，不编内容 ----------
  const created = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '最爱验收家' } })
  const emptyBoard = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    '一次饭都没做过的家庭：榜单为空、total=0（不拿库里随机的菜凑榜单）',
    created.status === 201 && emptyBoard.status === 200 && (emptyBoard.body?.items ?? []).length === 0 && emptyBoard.body?.total === 0,
    `${emptyBoard.status} total=${emptyBoard.body?.total}`,
  )

  await callWithRetry('POST', '/family/join', { token: son.token, body: { inviteCode: created.body.inviteCode } })

  // ---------- 点了但没做：不算信号 ----------
  const TODAY = todayKey()
  const LUNCH_KEY = `${TODAY}-LUNCH`
  const DINNER_KEY = `${TODAY}-DINNER`
  await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'LUNCH' } })
  const afterOrdering = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    '只是点了、还在收集中（PENDING）：不算做过，榜单仍为空',
    (afterOrdering.body?.items ?? []).length === 0,
    `total=${afterOrdering.body?.total}`,
  )

  // ---------- 推到"已做好"：算一次 ----------
  await cookThrough(mama.token, LUNCH_KEY)
  const afterCooked = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  const cookedA = pickOf(afterCooked.body, dishA.name)
  check(
    '推到"已做好"之后出现，并写明做过 1 次',
    cookedA !== null && cookedA.cooked === 1,
    `${JSON.stringify(names(afterCooked.body))} cooked=${cookedA?.cooked}`,
  )
  check(
    '榜单带回理由所需的字段（做过几次 / 几人收着 / 最近一次）',
    typeof cookedA?.favorites === 'number' && typeof cookedA?.lastCookedOn === 'string',
    `favorites=${cookedA?.favorites} lastCookedOn=${cookedA?.lastCookedOn}`,
  )

  // ---------- 同一餐里两人各点一份：只算一次 ----------
  await callWithRetry('POST', '/orders/items', { token: son.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'DINNER' } })
  const dinnerCard = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishA.id, mealDate: TODAY, meal: 'DINNER' } })
  check(
    '准备条件：晚餐那一餐里同一道菜有两份（两个人各点了一次）',
    dinnerCard.status === 201 && (dinnerCard.body?.items ?? []).filter((item) => item.name === dishA.name).length === 2,
    `${JSON.stringify((dinnerCard.body?.items ?? []).map((item) => item.name))}`,
  )
  await cookThrough(mama.token, DINNER_KEY)
  const afterSameDish = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  const sameDish = pickOf(afterSameDish.body, dishA.name)
  check(
    '同一餐里两个人各点一份只算做过一次（两餐才两次：按"餐"去重不是按"份"）',
    sameDish?.cooked === 2,
    `cooked=${sameDish?.cooked}（午餐 1 次 + 晚餐 1 次；晚餐那两份只算 1 次）`,
  )

  // ---------- 收藏也是信号，但比做过轻 ----------
  const favOnly = await callWithRetry('POST', '/favorites/toggle', { token: son.token, body: { recipeId: dishB.id } })
  const afterFav = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  const favB = pickOf(afterFav.body, dishB.name)
  check(
    '家里有人收藏的菜也进榜（收藏是另一个真实信号，不是只有做过）',
    favOnly.status === 200 && favB !== null && favB.favorites === 1 && favB.cooked === 0,
    `${JSON.stringify(names(afterFav.body))}`,
  )
  check(
    '排序：做过两次的排在只被收藏一次的前面（做一次比收一次重）',
    names(afterFav.body).indexOf(dishA.name) < names(afterFav.body).indexOf(dishB.name),
    `${JSON.stringify(names(afterFav.body))}`,
  )

  // ---------- 多个人收藏：喜欢数累加 ----------
  await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishB.id } })
  const afterTwoFav = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  const favB2 = pickOf(afterTwoFav.body, dishB.name)
  check(
    '两个人收藏同一道：喜欢数 = 2（按人去重，一人一次）',
    favB2?.favorites === 2,
    `favorites=${favB2?.favorites}`,
  )

  // ---------- 取消的餐不算做过 ----------
  /*
   * 取消掉的餐不算做过。
   *
   * 三件事要先说清，否则这条断言是假的：
   * - **取消走状态流转**（`POST /orders/meals/:mealKey/status` → CANCELED），没有独立的 cancel 接口；
   * - **不能往过去的日子点菜**（`parseMealDate` 只放行今天起 7 天），所以这一餐必须排在**未来**：
   *   第一版我用了"昨天"，结果加菜被 400 拒掉、餐根本不存在，断言却因为"榜单里没有它"而**假绿**；
   * - **DONE 是终态**（`ALLOWED_TRANSITIONS.DONE = []`），所以"做完再取消"这条路不存在——
   *   能验的就是"库里确实有这条条目、它挂在被取消的餐上、它不进榜"。先断言条目真的写进去了，
   *   再断言它不在榜上，两步都成立这条才算数。
   */
  const cancelDay = dateKeyOf(2)
  const cancelPut = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishC.id, mealDate: cancelDay, meal: 'DINNER' },
  })
  const cancelled = await callWithRetry('POST', `/orders/meals/${cancelDay}-DINNER/status`, {
    token: mama.token,
    body: { status: 'CANCELED' },
  })
  check(
    '准备条件：往未来的某一餐真点进去了，并且它确实被取消（不是没写进去）',
    cancelPut.status === 201 && cancelled.status === 200,
    `加点=${cancelPut.status} 取消=${cancelled.status}`,
  )
  const afterCancel = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    '取消掉的餐不算做过（条目在库里、但它挂在被取消的餐上，不进榜）',
    pickOf(afterCancel.body, dishC.name) === null,
    `${JSON.stringify(names(afterCancel.body))}`,
  )

  // ---------- 共享关掉：吃货只看自己的份 ----------
  /*
   * 先造一道**小满完全没参与**的菜：由妈妈一个人点、一个人推到"已做好"（小满没在那餐里点过任何东西）。
   * 只靠 dishA 验不了这条——它在午餐（小满没参与）与晚餐（小满参与）都有，
   * `some: { userId }` 会把整道菜带回来。要验"闸门真的按餐算"，得有一道**只有别人参与**的菜。
   */
  const momOnlyDay = dateKeyOf(1)
  const momOnlyKey = `${momOnlyDay}-LUNCH`
  const momOnlyPut = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishD.id, mealDate: momOnlyDay, meal: 'LUNCH' },
  })
  check('准备条件：妈妈一个人（小满没参与）点了一道并做完', momOnlyPut.status === 201, `加点=${momOnlyPut.status}`)
  await cookThrough(mama.token, momOnlyKey)
  const beforeSharedOff = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    '准备条件：家里确实做过那道菜（掌勺人看得到，做过 1 次）',
    pickOf(beforeSharedOff.body, dishD.name)?.cooked === 1,
    `${JSON.stringify(names(beforeSharedOff.body))}`,
  )

  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  const sonBoard = await callWithRetry('GET', '/discover/family-picks', { token: son.token })
  check(
    '共享关掉后吃货看榜单：scope=mine（说明算的只是自己的份）',
    sharedOff.status === 200 && sonBoard.body?.scope === 'mine',
    `scope=${sonBoard.body?.scope}`,
  )
  check(
    '共享关掉后，自己**完全没参与过**的那道菜不在自己的榜单里（只由妈妈一个人做的那道）',
    pickOf(sonBoard.body, dishD.name) === null,
    `小满的榜：${JSON.stringify(names(sonBoard.body))}`,
  )
  check(
    '共享关掉后，自己参与过的餐里那道仍在（他确实参与过今天晚餐，见前面的准备条件）',
    pickOf(sonBoard.body, dishA.name) !== null,
    `小满的榜：${JSON.stringify(names(sonBoard.body))}`,
  )
  check(
    '共享关掉后，自己收藏的那道仍在（**自己收的当然算自己的**）',
    pickOf(sonBoard.body, dishB.name) !== null,
    `${JSON.stringify(names(sonBoard.body))}`,
  )

  const mamaBoard = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    '同一次共享关闭下，掌勺人仍看全量（scope=family：要负责做饭，看不到家里吃过什么没法安排）',
    mamaBoard.body?.scope === 'family' && pickOf(mamaBoard.body, dishA.name) !== null,
    `scope=${mamaBoard.body?.scope} ${JSON.stringify(names(mamaBoard.body))}`,
  )
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

  // ---------- limit ----------
  const limited = await callWithRetry('GET', '/discover/family-picks?limit=1', { token: mama.token })
  const full = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    'limit=1 只回一道，但 total 仍是全部有信号的（界面据此说"还有 N 道"）',
    limited.body?.items?.length === 1 && limited.body?.total === full.body?.total && limited.body?.total > 1,
    `items=${limited.body?.items?.length} total=${limited.body?.total}（全量 ${full.body?.total}）`,
  )
  const badLimit = await callWithRetry('GET', '/discover/family-picks?limit=0', { token: mama.token })
  check('limit=0 → 400（一页至少一道）', badLimit.status === 400, `${badLimit.status}`)
  const hugeLimit = await callWithRetry('GET', '/discover/family-picks?limit=999', { token: mama.token })
  check('limit 超上限 → 400（榜单是一屏的事，不是又一个菜谱列表）', hugeLimit.status === 400, `${hugeLimit.status}`)

  // ---------- 自由菜品不参与（挂不到菜谱上的菜不该出现在"最爱"里） ----------
  // 用**第三天午餐**：今天两餐已成定局（DONE，加菜会被正确地拒 409），
  // 明天午餐给了"小满没参与的那道"，第二天的晚餐被取消过（取消后能加，但那会把整餐拉回 PENDING，
  // 与上面的取消断言互相打架），所以另找一餐。
  const freeDay = dateKeyOf(3)
  const freeDish = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: '验收家自己写的一道', mealDate: freeDay, meal: 'LUNCH' },
  })
  check(
    '准备条件：自己写的一道（菜谱库里没有）也能点进去',
    freeDish.status === 201 && (freeDish.body?.items ?? []).some((item) => item.recipeId === null),
    `${freeDish.status}`,
  )
  const afterFree = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  check(
    '自由菜品（没有菜谱）不进榜单——它没有菜谱可看，进去点了也是死路',
    pickOf(afterFree.body, '验收家自己写的一道') === null && (afterFree.body?.items ?? []).every((item) => item.id),
    `${JSON.stringify(names(afterFree.body))}`,
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
