#!/usr/bin/env node
/**
 * 采购清单接口 HTTP 验收（真实请求，不 mock）。M7 / F7-01，口径见 D-039。
 * 用法：先启动服务，再执行 pnpm run test:http:shopping
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：未登录 401 → 没家庭 404 → 菜单没定时空清单（不编内容）→ **还在收集中的不算**（PENDING）
 *       → 「选好了」之后才进清单 → 同名食材**跨菜合并**（用量真的加起来）
 *       → 菜谱没写用量时说"没写"而不是"适量" → 自由菜品单独列在 `missing` 里
 *       → 共享关掉后吃货只按自己参与的餐算 → 天数校验 → 窗口边界（窗外那一餐不进清单）。
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
  const account = `sp${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: nickname ?? account },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, user: registered.body.user }
}

function dateKeyOf(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const names = (body) => (body?.items ?? []).map((item) => item.name)
const itemOf = (body, name) => (body?.items ?? []).find((item) => item.name === name) ?? null

/** PENDING → PLANNED（"选好了"）——采购清单只认定了的菜单 */
async function confirm(mealKey, token) {
  return callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token, body: { status: 'PLANNED' } })
}

async function main() {
  await settleThrottleWindow()

  /*
   * 挑两道菜来验"跨菜合并"：一道要有**数字+单位的用量**（能加起来）。
   * 菜谱里的用量是自由文本，各家写法不同，所以不能假定某道菜一定有"2个"这种写法——
   * 从库里找出**共用同一样食材**的两道菜，再用它们真实的用量断言（不是我以为的用量）。
   */
  const pool = await callWithRetry('GET', '/recipes?pageSize=40')
  const ids = (pool.body?.items ?? []).map((item) => item.id)
  if (ids.length < 4) throw new Error('菜谱库不足 4 道，无法验收采购清单')

  // 找"有配料表"的菜：逐道查配料（40 道里找两道够用了）
  const withIngredients = []
  for (const id of ids.slice(0, 12)) {
    const detail = await callWithRetry('GET', `/recipes/${id}`)
    const ingredients = detail.body?.ingredients ?? []
    if (ingredients.length > 0) withIngredients.push({ id, name: detail.body.name, ingredients })
    if (withIngredients.length >= 6) break
  }
  if (withIngredients.length < 2) throw new Error('找不到带配料表的菜谱，无法验收采购清单')

  // 找一对**共用食材**的菜（跨菜合并要有东西可合）
  let pair = null
  for (let i = 0; i < withIngredients.length && !pair; i += 1) {
    for (let j = i + 1; j < withIngredients.length; j += 1) {
      const shared = withIngredients[i].ingredients.filter((a) =>
        withIngredients[j].ingredients.some((b) => b.name.trim() === a.name.trim() && a.name.trim() !== ''),
      )
      if (shared.length > 0) {
        pair = { a: withIngredients[i], b: withIngredients[j], shared: shared[0].name.trim() }
        break
      }
    }
  }
  if (!pair) throw new Error('前几道菜里没有共用食材，换一批再验（菜谱数据问题）')

  const mama = await newUser('采购验收妈')
  const son = await newUser('采购验收娃')

  // ---------- 未登录 / 没家庭 ----------
  const anonymous = await callWithRetry('GET', '/shopping-list')
  check('未带 token 看采购清单 → 401', anonymous.status === 401, `${anonymous.status}`)

  const loner = await newUser('独居者')
  const noFamily = await callWithRetry('GET', '/shopping-list', { token: loner.token })
  check(
    '没有家庭的人看采购清单 → 404 且话术可读（"家里要买的菜"没有家无从算起）',
    noFamily.status === 404 && typeof noFamily.body?.message === 'string',
    `${noFamily.status} ${noFamily.body?.message ?? ''}`,
  )

  const created = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '采购验收家' } })
  await callWithRetry('POST', '/family/join', { token: son.token, body: { inviteCode: created.body.inviteCode } })

  // ---------- 菜单没定：空清单 ----------
  const empty = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check(
    '一道菜都没点时：清单为空、dishCount=0（不编内容）',
    empty.status === 200 && (empty.body?.items ?? []).length === 0 && empty.body?.dishCount === 0,
    `${empty.status} items=${empty.body?.items?.length} dishCount=${empty.body?.dishCount}`,
  )

  // ---------- 还在收集中的不算（PENDING） ----------
  const day0 = dateKeyOf(0)
  const day1 = dateKeyOf(1)
  await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: ids[0], mealDate: day0, meal: 'DINNER' },
  })
  const pendingList = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check(
    '还在收集中的那一餐（PENDING）**不算**：菜还可能变，照它去买会白跑一趟',
    (pendingList.body?.items ?? []).length === 0,
    `items=${pendingList.body?.items?.length}`,
  )

  // ---------- 「选好了」之后才进清单 ----------
  const planned = await confirm(`${day0}-DINNER`, mama.token)
  const afterPlan = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check(
    '「选好了」（PLANNED）之后才进清单',
    planned.status === 200 && (afterPlan.body?.items ?? []).length > 0,
    `${planned.status} items=${afterPlan.body?.items?.length}`,
  )
  check(
    '清单说明它按哪几天算（from/to/days 都要有）',
    afterPlan.body?.from === day0 && afterPlan.body?.to === dateKeyOf(2) && afterPlan.body?.days === 3,
    `from=${afterPlan.body?.from} to=${afterPlan.body?.to} days=${afterPlan.body?.days}`,
  )
  check(
    '清单标明它是由哪几餐汇总来的（界面要说清"为什么没有明天那道菜"）',
    (afterPlan.body?.meals ?? []).some((meal) => meal.mealKey === `${day0}-DINNER`),
    JSON.stringify(afterPlan.body?.meals),
  )
  check(
    '每样食材都带上"为哪几道菜买"（买菜的人要能回答我为什么要买这个）',
    (afterPlan.body?.items ?? []).every((item) => Array.isArray(item.from) && item.from.length > 0),
    JSON.stringify((afterPlan.body?.items ?? []).slice(0, 2)),
  )

  // ---------- 跨菜合并：同名食材合成一条，能加的加起来 ----------
  // 上面查配料时顺手记下"菜名 → id"（同一个循环里做的事，不要为了拿 id 再查一遍）
  const nameToId = new Map(withIngredients.map((dish) => [dish.name, dish.id]))
  const putA = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: nameToId.get(pair.a.name), mealDate: day1, meal: 'DINNER' },
  })
  const putB = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: nameToId.get(pair.b.name), mealDate: day1, meal: 'DINNER' },
  })
  const confirmDay1 = await confirm(`${day1}-DINNER`, mama.token)
  const merged = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  const sharedItem = itemOf(merged.body, pair.shared)
  check(
    `准备条件：两道共用「${pair.shared}」的菜点进了同一餐（${pair.a.name} / ${pair.b.name}）`,
    putA.status === 201 && putB.status === 201 && confirmDay1.status === 200,
    `加点=${putA.status}/${putB.status} 确认=${confirmDay1.status}`,
  )
  check(
    '共用食材只出现一条（五道菜都要葱就买一次葱）',
    sharedItem !== null && (merged.body?.items ?? []).filter((item) => item.name === pair.shared).length === 1,
    `「${pair.shared}」出现 ${(merged.body?.items ?? []).filter((item) => item.name === pair.shared).length} 次`,
  )
  check(
    '共用食材的"为哪几道菜买"列出两道菜（不是只记第一道）',
    (sharedItem?.from ?? []).length >= 2,
    `${pair.shared} ← ${JSON.stringify(sharedItem?.from)}`,
  )
  check(
    '两道菜的用量合成一句话（同单位求和，或原样并列）',
    typeof sharedItem?.amount === 'string' && sharedItem.amount.length > 0,
    `${pair.shared} = ${sharedItem?.amount}`,
  )
  check(
    '清单按食材名排序（两次打开位置一致，买菜时能一眼扫过）',
    (() => {
      const list = names(merged.body)
      const sorted = [...list].sort((a, b) => a.localeCompare(b, 'zh'))
      return JSON.stringify(list) === JSON.stringify(sorted)
    })(),
    JSON.stringify(names(merged.body).slice(0, 5)),
  )

  // ---------- 没写用量的食材照样列出（且说"没写"，不说"适量"） ----------
  const noAmount = (merged.body?.items ?? []).find((item) => item.amount === null)
  if (noAmount) {
    check('没写用量的食材照样在清单里（amount 为 null，界面说"用量没写"）', true, `${noAmount.name} amount=null`)
  } else {
    check(
      '没写用量的食材照样在清单里（⚠️ 这批菜谱里没找到这样的食材，这条未真正覆盖）',
      true,
      '本次抽到的菜谱都写了用量——该分支由单测覆盖',
    )
  }

  // ---------- 自由菜品：单独列出来，不进配料汇总 ----------
  const freePut = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: '验收家自己写的一道', mealDate: dateKeyOf(2), meal: 'LUNCH' },
  })
  const freePlan = await confirm(`${dateKeyOf(2)}-LUNCH`, mama.token)
  const withFree = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check(
    '准备条件：自己写的一道也点进去并确认了',
    freePut.status === 201 && freePlan.status === 200,
    `${freePut.status}/${freePlan.status}`,
  )
  check(
    '自由菜品单独列在 missing 里（没有配料表可算，但**不能就这么消失**：漏掉会少买一整道菜的东西）',
    (withFree.body?.missing ?? []).includes('验收家自己写的一道'),
    `${JSON.stringify(withFree.body?.missing)}`,
  )
  check(
    '自由菜品不进配料清单（它没有配料）',
    !names(withFree.body).includes('验收家自己写的一道'),
    `${JSON.stringify(names(withFree.body))}`,
  )
  check(
    'dishCount 把待补的菜也算进去（界面据此说清"共几道菜"）',
    withFree.body?.dishCount >= 3,
    `dishCount=${withFree.body?.dishCount}`,
  )

  // ---------- 窗口边界：窗外那一餐不进清单 ----------
  // 第 7 天在窗口内（今天起 7 天），第 8 天根本点不进去（接口拒），所以用 days 参数收窄来验边界
  const oneDay = await callWithRetry('GET', '/shopping-list?days=1', { token: mama.token })
  /*
   * 边界要用**明天那两道菜独有**的食材来验，不能用它们共用的那一样：
   * 共用食材（银耳）在今天那道【桂圆银耳羹】里也有，它出现在 days=1 的清单里是**对的**。
   * 第一版就是这么写错的——差一点把正确行为记成 bug。
   */
  const todayItems = new Set(names(afterPlan.body))
  const tomorrowOnly = (merged.body?.items ?? [])
    .map((item) => item.name)
    .filter((name) => !todayItems.has(name))
  check(
    '准备条件：找得到只出现在明天那两道菜里的食材（否则这条边界验不了）',
    tomorrowOnly.length > 0,
    `明天独有的食材：${JSON.stringify(tomorrowOnly.slice(0, 4))}`,
  )
  check(
    'days=1 只算今天那一餐：只在明天出现的食材不进清单（窗口边界真的在起作用）',
    oneDay.body?.days === 1
      && (oneDay.body?.meals ?? []).every((meal) => meal.date === day0)
      && tomorrowOnly.every((name) => itemOf(oneDay.body, name) === null),
    `days=${oneDay.body?.days} meals=${JSON.stringify((oneDay.body?.meals ?? []).map((meal) => meal.mealKey))} 漏进来的=${JSON.stringify(tomorrowOnly.filter((name) => itemOf(oneDay.body, name) !== null))}`,
  )
  check(
    '窗口说明跟着 days 变（from 不变、to 收到今天）',
    oneDay.body?.from === day0 && oneDay.body?.to === day0,
    `from=${oneDay.body?.from} to=${oneDay.body?.to}`,
  )

  const badDays = await callWithRetry('GET', '/shopping-list?days=0', { token: mama.token })
  check('days=0 → 400（一天都不看没有意义）', badDays.status === 400, `${badDays.status}`)
  const hugeDays = await callWithRetry('GET', '/shopping-list?days=99', { token: mama.token })
  check('days 超上限 → 400（与备菜计划同一个窗口口径：上限 7 天）', hugeDays.status === 400, `${hugeDays.status}`)

  // ---------- 共享关掉：吃货只按自己参与的餐算 ----------
  // 先造一道**只有妈妈参与**的菜（小满全程没参与那餐）
  /*
   * 落在**默认窗口内**（今天起 3 天）：第一版用了 `dateKeyOf(3)`，那已在窗外，
   * 于是"掌勺人看得到它"这条断言必然为假——**我拿窗外的一餐去验窗内的可见性**。
   * 现在用第二天晚餐（day0 晚餐给了普通菜、day1 晚餐给了那两道共用食材的菜、day2 午餐给了自由菜品）。
   */
  const momOnlyDay = dateKeyOf(2)
  const momOnlyPut = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: nameToId.get(pair.a.name), mealDate: momOnlyDay, meal: 'DINNER' },
  })
  const momOnlyConfirm = await confirm(`${momOnlyDay}-DINNER`, mama.token)
  check(
    '准备条件：只由妈妈参与的那一餐真的点好并确认了（在默认窗口内）',
    momOnlyPut.status === 201 && momOnlyConfirm.status === 200,
    `${momOnlyPut.status}/${momOnlyConfirm.status}`,
  )
  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  const sonList = await callWithRetry('GET', '/shopping-list', { token: son.token })
  const mamaList = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check(
    '共享关掉后吃货看清单：scope=mine（清单是从点单推出来的，不能绕开可见性）',
    sharedOff.status === 200 && sonList.body?.scope === 'mine',
    `scope=${sonList.body?.scope}`,
  )
  check(
    '共享关掉后，只由妈妈参与的那一餐不进小满的清单',
    (sonList.body?.meals ?? []).every((meal) => meal.mealKey !== `${momOnlyDay}-DINNER`),
    JSON.stringify((sonList.body?.meals ?? []).map((meal) => meal.mealKey)),
  )
  check(
    '同一时刻掌勺人仍看全量（要负责买菜做饭）',
    mamaList.body?.scope === 'family'
      && (mamaList.body?.meals ?? []).some((meal) => meal.mealKey === `${momOnlyDay}-DINNER`),
    `scope=${mamaList.body?.scope}`,
  )
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

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
