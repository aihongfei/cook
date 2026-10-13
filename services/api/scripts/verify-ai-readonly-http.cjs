#!/usr/bin/env node
/**
 * 「AI 会答这三件事了」的 HTTP 验收（用户 2026-10-14：「等现在所有没接入 ai 的功能」）。
 *
 * 三件都**只读不写**：帮我决定（F5-05）、家人最爱（F5-02）、打卡（F9-03）。
 * 用法：先起 stub 上游与指向它的 API（见 RUNBOOK R-061），再执行
 *   pnpm --dir services/api run test:http:ai-readonly
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * **为什么值得单独验**：这三件事的答案**只有服务端算得对**——
 * ① "该做哪道菜"要同时看冰箱里快过期的（F6-05）、谁吃不了什么（F8-03）、
 *    家里做过几回与几个人收藏（F5-02）；模型看不到这些输入，凭印象说一道就是丢三条口径；
 * ② "家里最爱吃哪几道"里的那个次数（做过 3 次 / 2 人收藏）必须与发现页**同一个数字**；
 * ③ "连续打卡多少天"是热力图那段算出来的（`streak`），不是数一数就有的。
 *
 * 所以这一组的核心断言都是**同一个形状**：AI 答出来的东西必须与
 * 直接调那个接口拿到的**逐字一致**。这正是"AI 另算一份必然与界面分叉"的解药——
 * 分叉了这条就会红。
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
  const account = `airo${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token }
}

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

/**
 * `decideReason` 能说出来的那几句（见 `discover/decide.rules.ts`）。
 *
 * 验收拿它当"这句话是服务端写的"的判据：模型自己编理由时不会正好编出这些字句，
 * 而这几句中每一句都对应一条真实的库内判断（冰箱里有什么、只差什么、哪样该先吃、
 * 家里做过几次、几个人收藏着）。
 */
const REASON_FRAGMENTS = [
  '正好能做这道',
  '能用上',
  '只差',
  '也该先吃了',
  '你们家做过',
  '人收着',
  '库里挑的，今天换换口味',
]

async function main() {
  await settleThrottleWindow()

  const mama = await newUser('只读妈')
  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '只读之家' } })
  if (family.status !== 201) throw new Error(`建家庭失败：${family.status}`)
  const today = new Date()
  const mealDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  /*
   * 造点"家里有信号"的素材，否则三条读出来的都是空态、也就验不出"与接口一致"：
   * - 冰箱记一样**快过期的**（"该先吃"是排序的第一权重，会给出一句具体的理由）；
   * - 点一道菜进今天晚餐并做成"已做好"（"家人最爱"与"做过几次"才有数）；
   * - 打一次卡（连续天数与全家累计才有数）。
   */
  const soon = new Date(Date.now() + 86_400_000)
  const soonKey = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
  const fridgeAdded = await callWithRetry('POST', '/fridge', {
    token: mama.token,
    body: { name: '豆腐', amount: '一盒', zone: '冷藏', expiresOn: soonKey },
  })
  check('前置：冰箱里记一样快过期的（"该先吃"才有一句具体的理由）', fridgeAdded.status < 300, `status=${fridgeAdded.status}`)

  const recipes = await callWithRetry('GET', '/recipes?pageSize=8', { token: mama.token })
  const candidates = recipes.body?.items ?? []
  if (candidates.length === 0) throw new Error('菜谱库是空的，验收跑不了（先导入菜谱）')
  let recipe = null
  for (const row of candidates) {
    const detail = await callWithRetry('GET', `/recipes/${row.id}`, { token: mama.token })
    if ((detail.body?.ingredients?.length ?? 0) > 0) { recipe = detail.body; break }
  }
  if (!recipe) throw new Error('这一页菜谱都没有配料表，换一页再跑')
  await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: recipe.id, mealDate, meal: 'DINNER' },
  })
  await callWithRetry('POST', `/orders/meals/${mealDate}-DINNER/status`, { token: mama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${mealDate}-DINNER/status`, { token: mama.token, body: { status: 'COOKING' } })
  const done = await callWithRetry('POST', `/orders/meals/${mealDate}-DINNER/status`, { token: mama.token, body: { status: 'DONE' } })
  check('前置：把今天晚餐做成「已做好」（"做过几次"才有数）', done.status < 300, `status=${done.status}`)

  const checkedIn = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: {
      // 1×1 的 PNG（打卡只要形状对的图就能进，字节大小无关）
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      note: '只读验收用',
    },
  })
  check('前置：打一次卡（连续天数与全家累计才有数）', checkedIn.status < 300, `status=${checkedIn.status}`)

  // ---------- ① 帮我决定：AI 给的那道必须是"服务端算的"，不是它自己想的 ----------

  const decided = await chatStream(mama.token, say('今天不知道吃什么，帮我决定一道吧'))
  check(
    'AI 真的去拿了主意（状态行能看出来）',
    decided.statuses.some((label) => /拿个主意/.test(label)),
    `statuses=${JSON.stringify(decided.statuses)}`,
  )
  const decidedName = /「([^」]+)」/.exec(decided.text)?.[1] ?? ''
  /*
   * 「就是服务端算的那道」**不能拿第二次调接口的结果去比**：`decide` 是**故意随机**的
   * （在前几名里抽一道，见 `PICK_WINDOW`），两次调用本来就该不一样。
   * 所以验的是**出处**，两件：
   * ① 那道菜在菜谱库里真的存在（`/recipes?q=` 查得到同名）——挡住"模型自己编一道"；
   * ② 那句理由的词句来自 `decideReason`（服务端按冰箱临期/缺口/家里习惯拼的），
   *    挡住"模型自己编一个理由"。第二条在下面用**空信号家庭**做成确定性断言。
   */
  const foundDish = decidedName
    ? await callWithRetry('GET', `/recipes?q=${encodeURIComponent(decidedName)}&pageSize=5`, { token: mama.token })
    : { body: { items: [] } }
  check(
    '**AI 报的那道菜在菜谱库里真的存在**（不是它自己编的菜名）',
    Boolean(decidedName) && (foundDish.body?.items ?? []).some((row) => row.name === decidedName),
    `AI 报的=${decidedName} 库里同名=${JSON.stringify((foundDish.body?.items ?? []).map((row) => row.name))}`,
  )
  check(
    '理由那句话是**服务端拼的**（词句来自 `decideReason`，不是模型自己编的）',
    REASON_FRAGMENTS.some((fragment) => decided.text.includes(fragment)),
    `套话命中=${JSON.stringify(REASON_FRAGMENTS.filter((f) => decided.text.includes(f)))} text=${decided.text.slice(0, 90)}`,
  )
  check(
    '只给一道（这条出口的全部意思就是不让人挑）',
    (decided.text.match(/「[^」]+」/g) ?? []).length === 1,
    `引用了几道菜=${(decided.text.match(/「[^」]+」/g) ?? []).length} text=${decided.text.slice(0, 90)}`,
  )
  check('拿主意那条路**不写库**（一个回执都不该有）', decided.receipts.length === 0, `receipts=${decided.receipts.length}`)

  /*
   * 空信号家庭：没有冰箱、没做过、没人收藏 —— 这时 `decideReason` **只有一种输出**
   * （"库里挑的，今天换换口味"），于是"理由到底是谁写的"变成一个确定性断言。
   *
   * 为什么值得单独造一个家：主家庭那句理由里随机成分太多（抽到哪道菜决定说到哪几句），
   * 拿它验"照搬了服务端"只能验个大概；这一条能验到**逐字**。
   */
  const blank = await newUser('空信号妈')
  const blankFamily = await callWithRetry('POST', '/family', { token: blank.token, body: { name: '空白之家' } })
  check('前置：另建一个"没有任何信号"的家（冰箱空、没做过、没收藏）', blankFamily.status === 201, `status=${blankFamily.status}`)
  const blankDecide = await chatStream(blank.token, say('不知道吃什么，帮我决定一道'))
  check(
    '**空信号时理由逐字是服务端那一句**（"库里挑的，今天换换口味"只出现在 `decideReason` 里）',
    blankDecide.text.includes('库里挑的，今天换换口味'),
    `text=${blankDecide.text.slice(0, 90)}`,
  )

  // ---------- ② 家人最爱：次数必须与 /discover/family-picks 同一个数 ----------

  const picksApi = await callWithRetry('GET', '/discover/family-picks', { token: mama.token })
  const favorites = await chatStream(mama.token, say('我们家常做哪几道菜？'))
  check(
    'AI 真的去读了家人最爱（状态行能看出来）',
    favorites.statuses.some((label) => /最爱/.test(label)),
    `statuses=${JSON.stringify(favorites.statuses)}`,
  )
  const topPick = picksApi.body?.items?.[0]
  check(
    '**报出来的菜就是榜单上那道**（两边同一个 `familyPicks`，不是一个自己排的名）',
    Boolean(topPick?.name) && favorites.text.includes(topPick.name),
    `榜单=${topPick?.name}（做过 ${topPick?.cooked} 次 / ${topPick?.favorites} 人收藏） AI=${favorites.text.slice(0, 90)}`,
  )
  check(
    '**"做过几次"那个数字也对得上**（同一道菜在两处不能有两个次数）',
    !topPick || (topPick.cooked === 0 || favorites.text.includes(String(topPick.cooked))),
    `榜单 cooked=${topPick?.cooked} AI=${favorites.text.slice(0, 90)}`,
  )
  check(
    '**"几个人收藏"也对得上**（收藏是"几个人收着"，不是次数）',
    !topPick || (topPick.favorites === 0 || favorites.text.includes(String(topPick.favorites))),
    `榜单 favorites=${topPick?.favorites} AI=${favorites.text.slice(0, 90)}`,
  )

  // ---------- ③ 打卡：连续天数与总张数必须与 /checkins/stats 一致 ----------

  const statsApi = await callWithRetry('GET', '/checkins/stats', { token: mama.token })
  const checkins = await chatStream(mama.token, say('我连续打卡多少天了？'))
  check(
    'AI 真的去翻了打卡（状态行能看出来）',
    checkins.statuses.some((label) => /打卡墙/.test(label)),
    `statuses=${JSON.stringify(checkins.statuses)}`,
  )
  check(
    '**连续天数就是热力图里那个数**（`streak`，不是它数出来的）',
    checkins.text.includes(String(statsApi.body?.mine?.streak ?? -1)),
    `接口 streak=${statsApi.body?.mine?.streak} AI=${checkins.text.slice(0, 80)}`,
  )
  check(
    '**全家累计张数也对得上**',
    checkins.text.includes(String(statsApi.body?.familyTotal ?? -1)) || Number(statsApi.body?.familyTotal) === 0,
    `接口 familyTotal=${statsApi.body?.familyTotal} AI=${checkins.text.slice(0, 90)}`,
  )

  // ---------- ④ 这三条都不该把照片地址塞进对话上下文 ----------

  const wallApi = await callWithRetry('GET', '/checkins?limit=3', { token: mama.token })
  const anyPhotoPath = (wallApi.body?.items ?? []).map((item) => item.photoUrl).filter(Boolean)
  check(
    '打卡读出来的内容里**没有签名照片地址**（那串 URL 会跟着会话落盘，有效期内谁翻到都能取图）',
    anyPhotoPath.length > 0 && !anyPhotoPath.some((path) => checkins.text.includes(path)),
    `签名地址 ${anyPhotoPath.length} 条，AI 那句话里${anyPhotoPath.some((p) => checkins.text.includes(p)) ? '出现' : '没有'}它们`,
  )

  // ---------- ⑤ 没有家庭的人：三件都要说"先加入家庭"，而不是笼统地失败 ----------

  const solo = await newUser('没家的小明')
  const soloDecide = await chatStream(solo.token, say('帮我决定今晚吃什么'))
  const soloPicks = await chatStream(solo.token, say('我们家常做哪几道菜'))
  check(
    '没家庭的人问"吃什么"：照实说先加入家庭（不是"AI 开小差了"）',
    /家庭/.test(soloDecide.text) && soloDecide.receipts.length === 0,
    `text=${soloDecide.text.slice(0, 70)}`,
  )
  check(
    '没家庭的人问"家里最爱"：同上（三条读口子在没有家庭时都该给人话）',
    /家庭/.test(soloPicks.text) && soloPicks.receipts.length === 0,
    `text=${soloPicks.text.slice(0, 70)}`,
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
