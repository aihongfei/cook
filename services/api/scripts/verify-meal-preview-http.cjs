#!/usr/bin/env node
/**
 * 「这一餐要买什么」的 HTTP 验收（F7-06 + AI 的 `preview_meal_shopping`，
 * 用户 2026-10-14 报的第二件事）。
 *
 * 用法：先起 stub 上游与指向它的 API（见 RUNBOOK R-061），再执行
 *   pnpm --dir services/api run test:http:meal-preview
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * **这一组要钉住的是那条最容易搞错的界线**：用户的原话是
 * 「我让 ai 加入鱼香肉丝的配料到采购清单，**他不加入**，要让我加到订单中就自动出现了」。
 *
 * AI 拒得对（清单是按菜单配料算出来的，手写进去的在菜单变了之后不会跟着变），
 * 但它**只说了"你得先点菜"，没告诉用户"点完要买什么"**——所以用户以为功能坏了。
 * 修法不是让 AI 往清单里手写配料（那会让清单与菜单对不上），而是给它一支**只读的**预览：
 * 当场算出这一餐要买什么。
 *
 * 覆盖：
 * ① `GET /shopping-list/preview` 对**还没定**的餐也算得出来（`list` 那时是空的）；
 * ② 与定下来之后的 `list` 对得上（同一套规则，不能两份数字）；
 * ③ 冰箱里有的那几样划到"家里已有"，不在"要买"里；
 * ④ 自由菜品（没有配料表）出现在 `missing` 里，不许静默消失；
 * ⑤ 没加入家庭 → 404 且是中文话术；
 * ⑥ mealKey 格式不对 → 400（不是 500）；
 * ⑦ AI：问"做鱼香肉丝要买什么"→ 真调预览工具、**一条回执都没有**（不写库）；
 * ⑧ 而且它说得出要买的样数（不是只说"你得先点菜"）。
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
    try { parsed = await response.json() } catch { parsed = null }
  }
  return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** AI 那条流是 10 次/分，本脚本要问一轮——等上一轮窗口过去再开跑 */
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
  const account = `meal${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token }
}

/** 打一次流式问答，把 SSE 事件收下来（与 verify-ai-shopping 同一手法） */
async function chatStream(token, messages) {
  for (let round = 0; round < 5; round += 1) {
    const response = await fetch(`${base}/ai/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages }),
    })
    if (response.status === 429) {
      const waitMs = (Number(response.headers.get('retry-after')) || 60) * 1000 + 1000
      console.log(`⏳ AI 限流（10 次/分），等待 ${Math.round(waitMs / 1000)}s 后重试…`)
      await sleep(waitMs)
      continue
    }
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`流式问答失败：${response.status} ${text.slice(0, 200)}`)
    }
    const raw = await response.text()
    const events = []
    for (const block of raw.split('\n\n')) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try { events.push(JSON.parse(data)) } catch { /* 半截 JSON：跳过 */ }
      }
    }
    return {
      text: events.filter((event) => event.text).map((event) => event.text).join(''),
      statuses: events.filter((event) => event.type === 'status').map((event) => event.label),
      receipts: events.filter((event) => event.type === 'receipts').flatMap((event) => event.items ?? []),
    }
  }
  throw new Error('AI 限流一直未恢复，无法继续验收')
}

const say = (user) => [{ role: 'user', content: user }]
const boardNames = (board) => (board?.items ?? []).map((item) => item.name)

async function main() {
  await settleThrottleWindow()

  const mama = await newUser('预览妈')
  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '预览之家' } })
  if (family.status !== 201) throw new Error(`建家庭失败：${family.status}`)

  const today = new Date()
  const mealDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const mealKey = `${mealDate}-DINNER`

  const recipes = await callWithRetry('GET', '/recipes?pageSize=12', { token: mama.token })
  let recipe = null
  for (const row of recipes.body?.items ?? []) {
    const detail = await callWithRetry('GET', `/recipes/${row.id}`, { token: mama.token })
    if ((detail.body?.ingredients?.length ?? 0) > 0) { recipe = detail.body; break }
  }
  if (!recipe) throw new Error('这一页菜谱都没有配料表，换一页再跑')
  const ingredientNames = (recipe.ingredients ?? []).map((item) => item.name)

  // 先往冰箱里放一样这道菜要用的料：它该出现在"家里已有"里
  const inFridge = ingredientNames[0]
  const put = await callWithRetry('POST', '/fridge', {
    token: mama.token,
    body: { name: inFridge, amount: '1把', zone: '冷藏' },
  })
  check('前置：往冰箱里放一样这道菜要用的料', put.status < 300, `status=${put.status} name=${inFridge}`)

  await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: recipe.id, mealDate, meal: 'DINNER' },
  })

  // ---------- ① 还没定：清单是空的，但预览算得出来 ----------

  const beforeList = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check(
    '前置：这一餐还没定 → 整份清单里没有它的配料（这正是用户看到的现象）',
    !boardNames(beforeList.body).includes(inFridge) || beforeList.body?.items?.length === 0,
    `items=${JSON.stringify(boardNames(beforeList.body).slice(0, 5))}`,
  )

  const preview = await callWithRetry('GET', `/shopping-list/preview?mealKey=${mealKey}`, { token: mama.token })
  check(
    '① 预览对**还没定**的这一餐也算得出来',
    preview.status === 200 && preview.body?.toBuyCount > 0,
    `status=${preview.status} toBuyCount=${preview.body?.toBuyCount} status=${preview.body?.status}`,
  )
  check(
    '① 它老实说自己看的是"还没定"的那一餐（界面据此说清下一步）',
    preview.body?.status === 'PENDING',
    `status=${preview.body?.status}`,
  )

  // ---------- ④ 自由菜品（没有配料表）不许静默消失 ----------

  /*
   * 要在**还没定**的时候加：`canAddItem` 只放 PENDING（定了之后再想加菜得先取消整餐）。
   * 字段名是 `dishName`（F3-10 自己写一道），不是 recipeName。
   */
  const freeDish = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { dishName: '昨天的乱炖', mealDate, meal: 'DINNER' },
  })
  if (freeDish.status < 300) {
    const withFree = await callWithRetry('GET', `/shopping-list/preview?mealKey=${mealKey}`, { token: mama.token })
    check(
      '④ 自由菜品进 `missing`（它没有配料表，但必须说出来）',
      (withFree.body?.missing ?? []).includes('昨天的乱炖'),
      `missing=${JSON.stringify(withFree.body?.missing)}`,
    )
    // 卡片上的条目 id 字段是 `id`（`OrderItemView`），不是 `itemId`
    const freeItem = (freeDish.body?.items ?? []).find((item) => item.name === '昨天的乱炖')
    const removed = freeItem
      ? await callWithRetry('DELETE', `/orders/items/${freeItem.id}`, { token: mama.token })
      : { status: 0 }
    check('④ 撤掉那道自由菜品（它不该留在后面的断言里）', removed.status < 300, `status=${removed.status}`)
  } else {
    check('④ 自由菜品进 `missing`（它没有配料表，但必须说出来）', false, `加自由菜品失败：${freeDish.status}`)
  }

  // ---------- ② 与定下来之后的整份清单对得上 ----------

  const planned = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, {
    token: mama.token, body: { status: 'PLANNED' },
  })
  check('前置：把这餐定成已安排', planned.status < 300, `status=${planned.status}`)

  const afterList = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  const listNames = boardNames(afterList.body)
  check(
    '② 定了之后整份清单里出现这些配料（用户说"加入订单后就自动出现了"）',
    ingredientNames.filter((name) => listNames.includes(name)).length > 0,
    `清单 ${listNames.length} 条，命中 ${ingredientNames.filter((name) => listNames.includes(name)).length}/${ingredientNames.length}`,
  )

  const previewBuy = new Set((preview.body?.toBuy ?? []).map((item) => item.name))
  const previewHave = new Set((preview.body?.covered ?? []).map((item) => item.name))
  const listBuy = new Set((afterList.body?.items ?? []).filter((item) => item.needsBuy).map((item) => item.name))
  const listHave = new Set((afterList.body?.items ?? []).filter((item) => !item.needsBuy).map((item) => item.name))

  /*
   * 这一条是整组里最重要的：**预览与清单必须同一套规则**。
   * 两边各算一份的话，汇总页说"缺 3 样"、清单页列 5 样，用户就不知道信哪个
   * （与「帮我决定」不自己重算推荐同一条道理）。
   */
  const previewOnly = [...previewBuy].filter((name) => !listBuy.has(name))
  const listOnly = [...listBuy].filter((name) => !previewBuy.has(name))
  check(
    '② 预览的"要买"与定下来之后的清单**完全一致**（不是两套算法）',
    previewOnly.length === 0 && listOnly.length === 0,
    `只在预览里=${JSON.stringify(previewOnly.slice(0, 5))} 只在清单里=${JSON.stringify(listOnly.slice(0, 5))}`,
  )

  // ---------- ③ 冰箱里有的划到"家里已有" ----------

  const coveredAll = new Set([...previewHave, ...listHave])
  check(
    '③ 冰箱里那把料算进"家里已有"，不算要买',
    coveredAll.has(inFridge) && !previewBuy.has(inFridge),
    `inFridge=${inFridge} covered=${JSON.stringify([...coveredAll].slice(0, 5))}`,
  )

  // ---------- ⑤⑥ 参数与权限 ----------

  const badKey = await callWithRetry('GET', '/shopping-list/preview?mealKey=随便写的', { token: mama.token })
  check(
    '⑤ mealKey 格式不对 → 400 且是中文话术（不是 500）',
    badKey.status === 400 && typeof badKey.body?.message === 'string',
    `status=${badKey.status} message=${JSON.stringify(badKey.body?.message)?.slice(0, 40)}`,
  )

  const solo = await newUser('没家的小明')
  const soloPreview = await callWithRetry('GET', `/shopping-list/preview?mealKey=${mealKey}`, { token: solo.token })
  check(
    '⑥ 没加入家庭 → 404 且说清"先加入家庭"',
    soloPreview.status === 404 && /家庭/.test(String(soloPreview.body?.message ?? '')),
    `status=${soloPreview.status} message=${String(soloPreview.body?.message ?? '').slice(0, 30)}`,
  )

  // ---------- ⑦⑧ AI 真的会当场算，而且不写库 ----------

  const ask = await chatStream(mama.token, say('做鱼香肉丝要买什么？这一餐还缺什么？'))
  check(
    '⑦ AI 真去算了这一餐要买什么（状态行看得出来）',
    ask.statuses.some((label) => /要买什么/.test(label)),
    `statuses=${JSON.stringify(ask.statuses)}`,
  )
  check(
    '⑦ **一条回执都没有**：预览是只读的，它没往清单里写任何东西',
    ask.receipts.length === 0,
    `receipts=${JSON.stringify(ask.receipts.map((item) => item.summary))}`,
  )
  /*
   * 这一条是用户抱怨的那句话的正反面：原来模型只会说"你得先去点菜"，
   * 用户拿不到答案。现在它必须**把要买的几样说出来**。
   */
  const saidSomething = /要买/.test(ask.text) && /\d/.test(ask.text)
  check(
    '⑧ 它说得出要买什么（不是只说"你得先点菜"）',
    saidSomething,
    `text=${ask.text.slice(0, 90)}`,
  )
  check(
    '⑧ 而且说清了"定了这一餐才会进清单"（这个前提不能省，否则用户以为已经加了）',
    /定|清单/.test(ask.text),
    `text=${ask.text.slice(0, 90)}`,
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
