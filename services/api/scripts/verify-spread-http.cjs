#!/usr/bin/env node
/**
 * 「摇一桌」的 HTTP 验收（真实请求，不 mock）。F5-01，口径见 D-072。
 * 用法：先启动服务，再执行 pnpm run test:http:spread
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 这一份**自带全部前置数据**（自己注册、建家庭、配口味、点菜），不依赖别的验收留下的东西。
 *
 * 覆盖（按用户报的问题与升级目标排）：
 * ① 401 / 缺 mealKey / 人数越界 → 400；
 * ② **人数与道数对得上**，且晚餐不比午餐少（这是"按人数配一桌"的核心承诺）；
 * ③ **搭配**：一桌里荤/素/汤尽量齐，且**不出现两道汤**；
 * ④ **忌口硬拦**——这一条是本轮修掉的那个不一致：
 *    先做**正对照**（没写过敏时那道菜真会被摇到），再写过敏，**再摇一次一次都不许出现**。
 *    只测"出现 0 次"是没有证明力的：那道菜本来就可能摇不到；
 * ⑤ **整组加入**：加进去的是"还没有的"、已有的**跳过不重复**、再来一次**幂等**；
 * ⑥ **整餐要么都进要么都不进**：往「已做好」的餐加一组 → 409 且**一道菜都没多**；
 * ⑦ 空餐次**用默认人数**并如实标注（`dinersFromMeal: false`）；
 * ⑧ 这一餐已存过人数时，**以存着的为准**（`dinersFromMeal: true`）且覆盖请求里的值。
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

/** 全局限流 60 次/分（按 IP 计数）；本脚本请求量大，遇 429 等窗口重试 */
async function callWithRetry(method, path, options = {}) {
  for (let round = 0; round < 4; round += 1) {
    const response = await call(method, path, options)
    if (response.status !== 429) return response
    const waitMs = (Number(response.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 触发限流，等待 ${Math.round(waitMs / 1000)}s 后重试…`)
    await sleep(waitMs)
  }
  return call(method, path, options)
}

async function newUser(tag) {
  const account = `${tag}${String(Date.now()).slice(-7)}`
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: tag },
  })
  if (!registered.body?.token) {
    console.error('注册失败：', registered.status, JSON.stringify(registered.body))
    process.exit(1)
  }
  return { token: registered.body.token, userId: registered.body.user?.id, account }
}

/** 今天/明天/后天的日期键（与后端同一算法：服务器本地时区） */
function dateKey(offset = 0) {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 取一道**真的含某个配料**的菜，作为忌口验收的靶子。
 *
 * 为什么要费这个劲：忌口那一条要的是"**写了过敏之后它不出现**"，
 * 而那只有在"**没写时它真会出现**"的前提下才有证明力（正对照）。
 * 随手挑一道菜、看到它没出现就宣布过滤生效，是把"本来就没摇到"当成了证据。
 *
 * **踩过的两个坑都记在这里**（第一版两次都是"前置没成立"）：
 * ① 靶子得**真能摇得到**。库里 600 道，随手挑一道 12 轮可能一次都不出现
 *    （实测 0 次），那后面的 0 次就什么都不证明；
 * ② 靶子的配料**不能是调料**。`花生酱` 在 `pantry.rules` 的 `SEASONINGS` 里，
 *    而比对时**调料两边都跳过**（D-058）——所以"把它记进冰箱"根本拉不动它，
 *    冰箱这个杠杆对它无效。搜 `花生米`（不是调料）才有真靶子。
 */
async function findDishByIngredient(keyword, token) {
  // 搜到候选之后**逐道取详情**确认配料表里真有它（搜索结果可能只是菜名或标签里带这个词）
  const found = await callWithRetry('GET', `/recipes?q=${encodeURIComponent(keyword)}&pageSize=30`, { token })
  for (const item of (found.body?.items ?? []).slice(0, 6)) {
    const detail = await callWithRetry('GET', `/recipes/${item.id}`, { token })
    const names = (detail.body?.ingredients ?? []).map((row) => row.name)
    const hit = names.filter((name) => name.includes(keyword))
    if (hit.length > 0) return { id: item.id, name: item.name, hits: hit, ingredients: names }
  }
  return null
}

/**
 * 忌口正对照要摇多少轮。
 *
 * **靶子不会每轮都出现**：一桌里每个角色只占一个槽位，而槽位是在"该角色的前
 * `ROLE_WINDOW`（6）名"里随机抽的，所以单轮命中率约 **1/6**。
 * 12 轮时漏掉的概率还有 11%，会让"前置没成立"假红一次（第一版就是这么红的）。
 *
 * 30 轮时漏掉概率约 **0.4%**——低到可以当它不会发生；真发生了，脚本会如实报
 * "前置没成立"，而不是把"本来就没摇到"粉饰成"过滤生效"。
 */
const CONTROL_ROUNDS = 30

/** 摇 n 轮，返回摇到的全部菜（每一轮都是一桌） */
async function rolls(token, mealKey, diners, rounds) {
  const all = []
  for (let i = 0; i < rounds; i += 1) {
    const one = await callWithRetry('GET', `/discover/spread?mealKey=${mealKey}&diners=${diners}`, { token })
    if (one.status !== 200) {
      console.error('摇一桌失败：', one.status, JSON.stringify(one.body))
      process.exit(1)
    }
    all.push(one.body)
  }
  return all
}

async function main() {
  const mama = await newUser('spread')
  await callWithRetry('POST', '/family', { token: mama.token, body: { name: '摇桌验收家' } })
  const lunchKey = `${dateKey(0)}-LUNCH`
  const dinnerKey = `${dateKey(0)}-DINNER`

  // ---------- ① 前置与闸门 ----------
  const anonymous = await call('GET', `/discover/spread?mealKey=${dinnerKey}`)
  check('未登录 → 401（配菜是"这家人"的事，不是公共读）', anonymous.status === 401, `status=${anonymous.status}`)

  const noKey = await callWithRetry('GET', '/discover/spread', { token: mama.token })
  check('不给 mealKey → 404 且中文话术（后端要知道配哪一餐）', noKey.status === 404, `status=${noKey.status} msg=${noKey.body?.message}`)

  for (const bad of [0, 2.5, 999, 'abc']) {
    const r = await callWithRetry('GET', `/discover/spread?mealKey=${dinnerKey}&diners=${bad}`, { token: mama.token })
    check(`人数给 ${JSON.stringify(bad)} → 400 中文话术`, r.status === 400, `status=${r.status} msg=${r.body?.message}`)
  }

  // ---------- ② 人数 → 道数 ----------
  const oneDinner = (await callWithRetry('GET', `/discover/spread?mealKey=${dinnerKey}&diners=1`, { token: mama.token })).body
  const fourDinner = (await callWithRetry('GET', `/discover/spread?mealKey=${dinnerKey}&diners=4`, { token: mama.token })).body
  const sixDinner = (await callWithRetry('GET', `/discover/spread?mealKey=${dinnerKey}&diners=6`, { token: mama.token })).body
  const fourLunch = (await callWithRetry('GET', `/discover/spread?mealKey=${lunchKey}&diners=4`, { token: mama.token })).body

  check('1 人：配得少（不是一律给一桌）', oneDinner.items.length >= 1 && oneDinner.items.length <= 2, `道数=${oneDinner.items.length}`)
  check('人数多了道数跟着多', fourDinner.items.length > oneDinner.items.length, `1人=${oneDinner.items.length} → 4人=${fourDinner.items.length}`)
  check('6 人比 4 人多（或都已到上限）', sixDinner.items.length >= fourDinner.items.length, `4人=${fourDinner.items.length} 6人=${sixDinner.items.length}`)
  check('**晚餐不比午餐少**（晚饭是一天里最正式的一顿）', fourDinner.items.length >= fourLunch.items.length, `午=${fourLunch.items.length} 晚=${fourDinner.items.length}`)
  check('每道菜都带卡片要的字段（DishCard 能直接画）', fourDinner.items.every((item) => item.id && item.name && 'image' in item && 'mine' in item), JSON.stringify(fourDinner.items[0] ?? {}).slice(0, 120))

  // ---------- ③ 搭配 ----------
  const roleCount = (rows) => rows.reduce((acc, row) => ({ ...acc, [row.role]: (acc[row.role] ?? 0) + 1 }), {})
  const balanced = await rolls(mama.token, dinnerKey, '6', 3)
  const soups = balanced.map((body) => roleCount(body.items).soup ?? 0)
  check('6 人一桌**不出现两道汤**（一桌两汤看着就不像"配"的）', soups.every((n) => n <= 1), `各轮汤数=${soups.join(',')}`)
  check('一桌里认得出荤/素/汤三种角色（搭配是这一块的卖点）', balanced.every((body) => new Set(body.items.map((i) => i.role)).size >= 3), `各轮角色=${balanced.map((b) => [...new Set(b.items.map((i) => i.role))].join('/')).join(' | ')}`)
  check('一桌里没有重复的菜', balanced.every((body) => new Set(body.items.map((i) => i.id)).size === body.items.length), '')
  check('每道菜的 `reason` 是真事（要买/正好能做/做过）或留空，不编', balanced.every((body) => body.items.every((i) => typeof i.reason === 'string')), '')

  // ---------- ⑦ 默认人数如实标注 ----------
  check('空餐次：用默认人数并**如实标注**（dinersFromMeal=false）', fourDinner.diners === 4 && fourDinner.dinersFromMeal === false, `diners=${fourDinner.diners} fromMeal=${fourDinner.dinersFromMeal}`)
  check('头部那句话由后端拼且说得清（"按 N 个人算，配了 M 道"）', /配了/.test(fourDinner.reason ?? ''), JSON.stringify(fourDinner.reason))

  // ---------- ④ 忌口硬拦（带正对照） ----------
  /*
   * 靶子要选**真能摇到**的那种。做法：先用一个不同家庭测"没写过敏时它会不会出现"，
   * 出现过了再写过敏重摇——两次之间只改了档案一个变量。
   */
  const target = await findDishByIngredient('花生米', mama.token)
  if (!target) {
    check('前置：库里找得到含"花生"的菜（找不到就没法验过敏过滤）', false, '搜索没命中任何含花生的菜')
  } else {
    /*
     * **把靶子的配料记进冰箱**——这是让正对照成立的关键一步。
     *
     * 不记冰箱时靶子只是库里 600 道之一，单轮命中率低到 12 轮都碰不到（第一版实证）。
     * 记了之后它落进"冰箱里正好能做"那一档，**在它那个角色的候选里排第一**，
     * 于是只要它的角色槽位被抽到，它就在抽签窗口内（约 1/6 每轮）。
     *
     * 两次检查之间**只改档案一个变量**（冰箱两次都在），所以"前后差异"只能归因于过敏。
     */
    const pantry = await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: target.hits[0], zone: '常温' } })
    check(`前置：把「${target.hits[0]}」记进冰箱（让靶子排到候选前排，正对照才验得动）`, pantry.status === 201, `status=${pantry.status}`)
    /*
     * 前置：靶料**不能是调料**——是调料的话"记进冰箱"拉不动它
     * （D-058：比对时调料两边都跳过），正对照就永远立不起来。
     * 判据是"去掉修饰字之后是不是那 12 种调料"：`油炸花生米` → `花生米`（不是调料），
     * 而 `花生酱` / `香油` 是。这里只做**粗筛**（真正的判据在 pantry.rules，
     * 不在这里重写一套），目的是让"靶子选得不对"能在前一步就报出来。
     */
    const bare = target.hits[0].replace(/^(油炸|熟|生|去皮|盐焗|水煮|自制)/, '')
    check(
      '前置：靶子的配料**不是调料**（是调料的话"记进冰箱"拉不动它——D-058 两边都跳过）',
      !/(酱|油|醋|料酒|香油|麻油|蚝油)$/.test(bare) && bare.length >= 2,
      `靶料=${target.hits[0]} → 去修饰=${bare}`,
    )

    const beforeRounds = await rolls(mama.token, dinnerKey, '6', CONTROL_ROUNDS)
    const beforeHits = beforeRounds.filter((body) => body.items.some((item) => item.id === target.id)).length
    check(
      `前置（正对照）：没写过敏时「${target.name}」真会被摇到（否则后面的 0 没有证明力）`,
      beforeHits > 0,
      `${CONTROL_ROUNDS} 轮里出现 ${beforeHits} 次（含 ${target.hits.join('、')}）`,
    )

    const wrote = await callWithRetry('PATCH', '/taste', {
      token: mama.token,
      // 写**过敏原本身**（不是那个带修饰的全名）：判据是子串匹配，写「花生」能命中「油炸花生米」
      body: { allergies: ['花生'] },
    })
    check('把「花生过敏」写进档案', wrote.status === 200, `status=${wrote.status}`)

    const afterRounds = await rolls(mama.token, dinnerKey, '6', CONTROL_ROUNDS)
    const afterHits = afterRounds.filter((body) => body.items.some((item) => item.id === target.id)).length
    check(
      `写了「花生过敏」之后，${CONTROL_ROUNDS} 轮**一次都不出现**（${beforeHits} → ${afterHits}）`,
      afterHits === 0,
      `写档案前 ${beforeHits} 次 / 写档案后 ${afterHits} 次`,
    )
    check('**过滤不是把功能关掉**：写了过敏之后照样摇得出菜（每轮都有）', afterRounds.every((body) => body.items.length > 0), `各轮道数=${afterRounds.map((b) => b.items.length).join(',')}`)

    // 与旁边那两条出口的口径一致性（用户报的那个不一致就是"三种口径"）
    const decideRound = await callWithRetry('GET', '/discover/decide', { token: mama.token })
    const recommendRound = await callWithRetry('GET', '/discover/recommend?count=6', { token: mama.token })
    const decided = decideRound.body?.recipe ? [decideRound.body.recipe.id] : []
    const recommended = (recommendRound.body?.items ?? []).map((item) => item.id)
    check('「帮我决定」同样不出现过敏菜（三条出口同一口径）', !decided.includes(target.id), `decide=${decideRound.body?.recipe?.name ?? 'null'}`)
    check('「首页推荐」同样不出现过敏菜（三条出口同一口径）', !recommended.includes(target.id), `recommend=${recommended.length} 道`)
  }

  // ---------- ⑧ 已存人数优先 ----------
  const firstItem = balanced[0].items[0]
  const added = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: firstItem.id, mealDate: dateKey(0), meal: 'DINNER' },
  })
  check('前置：先往今天晚餐点一道（建出这一餐）', added.status === 201, `status=${added.status}`)
  const setDiners = await callWithRetry('POST', `/orders/meals/${dinnerKey}/diners`, {
    token: mama.token,
    body: { dinerCount: 5 },
  })
  check('前置：把这一餐的就餐人数设成 5', setDiners.status === 200, `status=${setDiners.status}`)
  const withStored = (await callWithRetry('GET', `/discover/spread?mealKey=${dinnerKey}&diners=2`, { token: mama.token })).body
  check('这一餐存过人数时**以存着的为准**（请求里给 2 也要按 5 算）', withStored.diners === 5 && withStored.dinersFromMeal === true, `diners=${withStored.diners} fromMeal=${withStored.dinersFromMeal}`)

  // ---------- ⑤ 整组加入 ----------
  const spreadOne = (await callWithRetry('GET', `/discover/spread?mealKey=${dinnerKey}&diners=2`, { token: mama.token })).body
  const ids = spreadOne.items.map((item) => item.id)
  /*
   * 这里断言的是 **added + skipped === 要加的道数**，不是 added === 道数。
   * 因为同一份库、同一套偏好下，这一桌很可能混进一道本脚本前面已经点过的菜——
   * 它被合理地跳进 skipped，拿 added 硬等道数只会假红一次（那是脚本的毛病，不是接口的）。
   */
  const bulk = await callWithRetry('POST', '/orders/items/bulk', {
    token: mama.token,
    body: { recipeIds: ids, mealDate: dateKey(0), meal: 'DINNER' },
  })
  const addedCount = (bulk.body?.added ?? []).length
  const skippedCount = (bulk.body?.skipped ?? []).length
  check(
    '整组加入 → 201；**加入的 + 跳过的 = 要加的那些**（没有既没加也没报的）',
    bulk.status === 201 && addedCount + skippedCount === ids.length,
    `status=${bulk.status} added=${addedCount} skipped=${skippedCount} 要加=${ids.length}`,
  )

  const again = await callWithRetry('POST', '/orders/items/bulk', {
    token: mama.token,
    body: { recipeIds: ids, mealDate: dateKey(0), meal: 'DINNER' },
  })
  check('再点一次是**幂等**的：added 为空、全在 skipped 里（同一组菜不会变两份）', again.status === 201 && (again.body?.added ?? []).length === 0, `added=${(again.body?.added ?? []).length} skipped=${(again.body?.skipped ?? []).length}`)
  const card = again.body?.card
  const counted = (card?.items ?? []).filter((item) => ids.includes(item.recipeId)).length
  check('那几道菜在这一餐里各只有一条（没有 ×2）', counted === ids.length, `命中 ${counted} 条 / 期望 ${ids.length} 条`)

  const empty = await callWithRetry('POST', '/orders/items/bulk', { token: mama.token, body: { recipeIds: [], mealDate: dateKey(0), meal: 'DINNER' } })
  check('空列表 → 400（不给"什么都没发生"的静默成功）', empty.status === 400, `status=${empty.status} msg=${empty.body?.message}`)
  const tooMany = await callWithRetry('POST', '/orders/items/bulk', {
    token: mama.token,
    body: { recipeIds: Array.from({ length: 13 }, (_, i) => `fake-${i}`), mealDate: dateKey(0), meal: 'DINNER' },
  })
  check('超过 12 道 → 400（与组合同一个上限）', tooMany.status === 400, `status=${tooMany.status} msg=${tooMany.body?.message}`)

  // ---------- ⑥ 整组要么都进、要么都不进 ----------
  const doneKey = `${dateKey(1)}-DINNER`
  const seed = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: ids[0], mealDate: dateKey(1), meal: 'DINNER' },
  })
  check('前置：明天晚餐点一道并推到「已做好」', seed.status === 201, `status=${seed.status}`)
  for (const status of ['PLANNED', 'COOKING', 'DONE']) {
    await callWithRetry('POST', `/orders/meals/${doneKey}/status`, { token: mama.token, body: { status } })
  }
  const intoDone = await callWithRetry('POST', '/orders/items/bulk', {
    token: mama.token,
    body: { recipeIds: ids.slice(1), mealDate: dateKey(1), meal: 'DINNER' },
  })
  check('整组加到「已做好」的那一餐 → 409（一次判定，不会加到一半才发现）', intoDone.status === 409, `status=${intoDone.status} msg=${intoDone.body?.message}`)
  const after = await callWithRetry('GET', `/orders/today`, { token: mama.token })
  const doneRow = (await callWithRetry('GET', `/orders/plan?days=2`, { token: mama.token })).body?.days
    ?.flatMap((day) => day.meals)
    ?.find((row) => row.mealKey === doneKey)
  check('拒掉之后那一餐**一道菜都没多**（整组要么都进、要么都不进）', doneRow?.dishCount === 1, `dishCount=${doneRow?.dishCount}`)

  // ---------- 汇总 ----------
  for (const row of results) {
    console.log(`${row.ok ? '✅' : '❌'} ${row.name}${row.detail ? `  — ${row.detail}` : ''}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('验收脚本自身出错：', error)
  process.exitCode = 1
})
