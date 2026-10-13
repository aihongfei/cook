#!/usr/bin/env node
/**
 * 全局 AI 助手"对话里办事 + 撤销"的 HTTP 验收（M16 / F16-10，D-052 / D-053）。
 * 用法：先起 stub 上游与 API（见 RUNBOOK R-042），再执行 `pnpm run test:http:ai-actions`
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 走的是**真路**：`/ai/chat/stream` + stub 上游（`ai-stub-upstream.cjs`）——
 * 模型真的决定调工具、服务端真的执行、真的写库。所以这里验到的不是"函数返回值"，
 * 而是"AI 说记好了的时候，冰箱里真的有了，且那张回执卡上的「撤」真的能撤回去"。
 *
 * ⚠️ 为什么不直接造 `AiAction` 记录去验撤销：那样验的是"撤销本身"，
 * 而真正危险的是**写与撤是两套代码**——AI 写库时记的 undoData 形状如果和撤销时读的对不上，
 * 单测（两边都用假数据）照样全绿，用户点「撤」却是坏的。所以这里全程走真路。
 *
 * 覆盖：
 * ① 无工具轮（普通问答）不受影响；
 * ② "记一下鸡蛋牛奶" → 真写库（牛奶进了、鸡蛋因已存在被拒并如实说明）→ 回执卡 → **撤掉后牛奶没了**；
 * ③ 两样都新的时候一批都进（一张回执卡两笔），撤一笔只影响那笔；
 * ④ "把牛奶拿掉" → 真删 → 回执 → 撤回去那条真的回来了（含数量/位置）；
 *    另有一场"用户又自己记回来了" → 撤销如实说"还在，没被删"（不硬重建撞唯一约束）；
 * ⑤ "改成一盒" → 真改 → 回执 → 「改回去」**写回原样**，且不碰用户自己改过的字段；
 * ⑥ 撤销越权：家里别人 403、别家 403、不存在的 404、同一笔撤两次 409。
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
  const account = `aia${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: nickname ?? account },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, user: registered.body.user }
}

async function newFamily(token, name) {
  const created = await callWithRetry('POST', '/family', { token, body: { name } })
  if (created.status !== 201) throw new Error(`建家庭失败：${created.status} ${JSON.stringify(created.body)}`)
  return created.body
}

const flatten = (board) => (board?.zones ?? []).flatMap((group) => group.items)
const itemNamed = (board, name) => flatten(board).find((item) => item.name === name) ?? null

/**
 * stub 给牛奶带的那个保质期（它自己按"今天往后 7 天"算，见 ai-stub-upstream）。
 * 这里跟着算同一个日子：要验的是"AI 说的日期**原样**存进了库"，所以两边必须对同一个值。
 */
function soonKey() {
  return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 今天往后第 N 天的日期键（**按本地日历**算，与产品同一口径：容器 TZ=Asia/Shanghai）。
 *
 * 不能用 `toISOString()`：那是 UTC，晚上 8 点之后（东八区）会比本地日期早一天，
 * 于是"明天晚餐"在脚本里指向了今天——验收就会去查一个根本不存在的餐次，
 * 断言看着像产品坏了（这类时区坑见 RISKS R-18）。
 */
function menuDateForVerify(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86_400_000)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * 打一次流式问答，把 SSE 三种事件收下来。
 *
 * 这里**必须自己读流**（不能用 /ai/chat 那个非流式接口）：回执是 `event: receipts`，
 * 只有流式这条路上有。产品里前端走的也是这条。
 *
 * **必须带限流重试**：AI 那几条接口是 10 次/分（每次都是用户自己的额度，D-026 刻意压紧的），
 * 而这个脚本要问十几轮——不加这一层就会在中途撞 429 然后整轮挂掉（第一次跑就是这样）。
 */
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
        try {
          events.push(JSON.parse(data))
        } catch {
          // 半截 JSON：跳过
        }
      }
    }
    return {
      text: events.filter((event) => event.text).map((event) => event.text).join(''),
      statuses: events.filter((event) => event.type === 'status').map((event) => event.label),
      receipts: events.filter((event) => event.type === 'receipts').flatMap((event) => event.items ?? []),
      proposals: events.filter((event) => event.type === 'proposals').flatMap((event) => event.items ?? []),
    }
  }
  throw new Error('AI 限流一直未恢复，无法继续验收')
}

const say = (user) => [{ role: 'user', content: user }]

async function main() {
  await settleThrottleWindow()

  const mama = await newUser('AI 助手妈')
  const family = await newFamily(mama.token, 'AI 助手之家')

  // ---------- ① 普通问答不受影响（没工具轮，别把原有那条路弄坏）----------

  const plain = await chatStream(mama.token, say('今晚吃什么好'))
  check(
    '普通问答照旧（模型的话能收到，且没有回执——它没动过任何数据）',
    plain.text.length > 0 && plain.receipts.length === 0,
    `text=${plain.text.slice(0, 30)} receipts=${plain.receipts.length}`,
  )

  // ---------- ② 先手记一条鸡蛋，让 stub 的批量里有一条必然失败 ----------

  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '鸡蛋', amount: '一盒', zone: '冷藏' } })

  const recorded = await chatStream(mama.token, say('帮我记一下冰箱里有鸡蛋和牛奶'))
  check(
    'AI 真的去读了冰箱（不是凭记忆直接写）',
    recorded.statuses.some((label) => /冰箱/.test(label)),
    `statuses=${JSON.stringify(recorded.statuses)}`,
  )
  const afterRecord = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '**一句"记一下"真的把牛奶写进了冰箱**（A 档的核心）',
    itemNamed(afterRecord.body, '牛奶')?.amount === '两盒',
    `milk=${JSON.stringify(itemNamed(afterRecord.body, '牛奶'))}`,
  )
  check(
    `牛奶的保质期也照 AI 说的存下了（stub 给的是 7 天后，产品侧不许把它挪成别的日子）`,
    itemNamed(afterRecord.body, '牛奶')?.expiresOn === soonKey(),
    `expiresOn=${itemNamed(afterRecord.body, '牛奶')?.expiresOn} 期望=${soonKey()}`,
  )
  check(
    '**已经记过的鸡蛋不会变成第二条**（一样失败不带走整批）',
    flatten(afterRecord.body).filter((item) => item.name === '鸡蛋').length === 1,
    `egg count=${flatten(afterRecord.body).filter((item) => item.name === '鸡蛋').length}`,
  )
  check(
    '回执卡给出来了，且**只含真记成的那笔**（没把失败的鸡蛋也写进去）',
    recorded.receipts.length === 1 && /牛奶/.test(recorded.receipts[0]?.summary ?? ''),
    `receipts=${JSON.stringify(recorded.receipts.map((item) => item.summary))}`,
  )
  check(
    '回执上带撤销按钮那句话（"撤掉"）',
    recorded.receipts[0]?.label === '撤掉',
    `label=${recorded.receipts[0]?.label}`,
  )

  // ---------- 撤掉它：牛奶真的没了 ----------

  const milkReceipt = recorded.receipts[0]
  const undone = await callWithRetry('POST', `/ai/actions/${milkReceipt.id}/undo`, { token: mama.token })
  check(
    '撤掉那一笔：200 并回一句"已撤销：…"',
    undone.status === 200 && /已撤销/.test(undone.body?.message ?? ''),
    `status=${undone.status} message=${undone.body?.message}`,
  )
  const afterUndo = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '**撤完牛奶真的从冰箱里没了**（不是只把按钮变灰）',
    itemNamed(afterUndo.body, '牛奶') === null,
    `still=${Boolean(itemNamed(afterUndo.body, '牛奶'))}`,
  )
  const twice = await callWithRetry('POST', `/ai/actions/${milkReceipt.id}/undo`, { token: mama.token })
  check(
    '同一笔不能撤两次：409「已经撤过了」',
    twice.status === 409 && /已经撤过/.test(JSON.stringify(twice.body)),
    `status=${twice.status}`,
  )

  // ---------- ③ 两样都新的时候：两张回执，撤一笔只影响那笔 ----------

  const batch = await chatStream(mama.token, say('冰箱里记一下黄瓜和豆腐吧'))
  check(
    '一批两样都成功：**一张回执卡两笔**（不是一样一张）',
    batch.receipts.length === 2,
    `receipts=${batch.receipts.length} ${JSON.stringify(batch.receipts.map((item) => item.summary))}`,
  )
  const cucumberReceipt = batch.receipts.find((item) => /黄瓜/.test(item.summary))
  await callWithRetry('POST', `/ai/actions/${cucumberReceipt.id}/undo`, { token: mama.token })
  const afterPartial = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '撤其中一笔：只撤掉那一笔（黄瓜没了、豆腐还在）',
    itemNamed(afterPartial.body, '黄瓜') === null && itemNamed(afterPartial.body, '豆腐') !== null,
    `cucumber=${Boolean(itemNamed(afterPartial.body, '黄瓜'))} tofu=${Boolean(itemNamed(afterPartial.body, '豆腐'))}`,
  )

  // ---------- ③b 一批里有一条已存在：成的那条仍要落库并出回执 ----------

  const partial = await chatStream(mama.token, say('往冰箱里记一下鸡蛋和苹果'))
  const afterPartialBatch = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '批量里一样已经记过（鸡蛋）：**另一条仍然记进去了**（苹果）',
    itemNamed(afterPartialBatch.body, '苹果') !== null,
    `apple=${Boolean(itemNamed(afterPartialBatch.body, '苹果'))}`,
  )
  check(
    '回执卡**只含真记成的那笔**（不把失败的鸡蛋也写进去骗用户）',
    partial.receipts.length === 1 && /苹果/.test(partial.receipts[0]?.summary ?? ''),
    `receipts=${JSON.stringify(partial.receipts.map((item) => item.summary))}`,
  )
  check(
    '已经记过的鸡蛋**没变成第二条**（唯一约束仍然守着）',
    flatten(afterPartialBatch.body).filter((item) => item.name === '鸡蛋').length === 1,
    `egg count=${flatten(afterPartialBatch.body).filter((item) => item.name === '鸡蛋').length}`,
  )

  // ---------- ④ "把牛奶拿掉" → 真删 → 撤回去 ----------

  /*
   * 先**真的把牛奶放回去**（用户手记一条，与 AI 无关）：上面那轮已经把 AI 记的那条撤掉了，
   * 现在冰箱里是没有牛奶的。少了这一步，stub 从 `read_fridge` 里就拿不到牛奶的 id，
   * 于是它会退而求其次去"记一样"（第一版脚本就是这样，症状是"让它拿掉它却记了一条"——
   * 那不是产品的问题，是**验收脚本自己把场景搭错了**）。
   */
  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '牛奶', amount: '两盒', zone: '冷藏' } })

  const removed = await chatStream(mama.token, say('牛奶喝完了，帮我从冰箱里拿掉'))
  const afterRemove = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    'AI 删东西也是真的删（"拿掉"之后冰箱里没有牛奶了）',
    itemNamed(afterRemove.body, '牛奶') === null,
    `milk=${Boolean(itemNamed(afterRemove.body, '牛奶'))}`,
  )
  const removeReceipt = removed.receipts[0]
  check(
    '删的回执上那句话是"放回去"（不是抽象的"撤销"）',
    removeReceipt?.label === '放回去',
    `label=${removeReceipt?.label}`,
  )
  const restored = await callWithRetry('POST', `/ai/actions/${removeReceipt.id}/undo`, { token: mama.token })
  const afterRestore = await callWithRetry('GET', '/fridge', { token: mama.token })
  const back = itemNamed(afterRestore.body, '牛奶')
  check(
    '撤"删除"：**那条照原样回来了**（数量与位置都对）',
    restored.status === 200 && back?.amount === '两盒' && back?.zone === '冷藏',
    `status=${restored.status} item=${JSON.stringify(back)}`,
  )

  // ---------- ⑤ 用户自己又记了一条 → 撤"删除"不该硬重建（唯一约束）----------

  const secondRemove = await chatStream(mama.token, say('牛奶我扔了，从冰箱里拿掉'))
  const remove2 = secondRemove.receipts[0]
  check(
    '第二次"拿掉"也出了回执（这次撤它之前先把用户自己记的那条造出来）',
    Boolean(remove2) && remove2.label === '放回去',
    `receipt=${JSON.stringify(remove2?.label)}`,
  )
  const listAfter = await callWithRetry('GET', '/ai/actions', { token: mama.token })
  check(
    '可撤销列表里有这一笔（前端重开抽屉时据此挂出按钮）',
    (listAfter.body?.items ?? []).some((item) => item.id === remove2.id),
    `items=${listAfter.body?.items?.length}`,
  )
  /*
   * 用户自己把牛奶**又记回同一个格子**（冷藏）→ 再撤"删除"时那条已经在原位。
   * 这里必须同区同名：记到别的格子不算"它回来了"（那是两条能共存的记录，
   * 撤销该照常重建）。第一版脚本记的是"一盒/常温"，于是撤销成功地重建了一条——
   * 那条检查因此红在一个**我搭错的场景**上，不是产品的问题。
   */
  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '牛奶', amount: '一盒', zone: '冷藏' } })
  const conflict = await callWithRetry('POST', `/ai/actions/${remove2.id}/undo`, { token: mama.token })
  const afterConflict = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '那条又回来了时撤"删除"：**不当失败**，如实说"还在，没被删"（不是硬重建撞唯一约束）',
    conflict.status === 200 && /还在/.test(conflict.body?.message ?? ''),
    `status=${conflict.status} message=${conflict.body?.message}`,
  )
  check(
    '用户自己记的那条**原样还在**（数量与位置都没被动过）',
    itemNamed(afterConflict.body, '牛奶')?.amount === '一盒' && itemNamed(afterConflict.body, '牛奶')?.zone === '冷藏',
    `item=${JSON.stringify(itemNamed(afterConflict.body, '牛奶'))}`,
  )

  // ---------- ⑥ "改一条" → 真改 → 回执 → 「改回去」真的还原成原样 ----------
  /*
   * 四个冰箱工具里"改"是最容易出事的一条：它要**先读到 id 再动**，
   * 而撤销它不是删也不是建，是**把值写回原样**——写错一个字段，用户的食材数量就被悄悄改了。
   * 上面那些场景覆盖不到它，所以单独走一遍（顺带补上"四个工具都端到端验过"这条）。
   *
   * 先把数量弄成两盒（用户自己改）：上一段结束时牛奶是一盒。
   * 于是一会儿 AI 改成一盒之后，撤销**必须变回两盒**——"写回原样"要是写错了方向
   * （比如把"改后"当成原样存了），断言立刻红。
   */
  const milkBefore = itemNamed((await callWithRetry('GET', '/fridge', { token: mama.token })).body, '牛奶')
  await callWithRetry('PATCH', `/fridge/${milkBefore.id}`, { token: mama.token, body: { amount: '两盒' } })

  const changed = await chatStream(mama.token, say('冰箱里的牛奶改成一盒'))
  const afterChange = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '让 AI 改一条：**真的改了**（数量从两盒变成一盒）',
    itemNamed(afterChange.body, '牛奶')?.amount === '一盒',
    `amount=${JSON.stringify(itemNamed(afterChange.body, '牛奶')?.amount)}`,
  )
  const changeReceipt = changed.receipts[0]
  check(
    '改的回执上那句话是"改回去"（不是抽象的"撤销"）',
    changeReceipt?.label === '改回去',
    `label=${changeReceipt?.label}`,
  )

  /*
   * 撤销之前**用户自己改另一个字段**（备注）：AI 只动了数量，用户动的是备注——
   * 这种"各动各的"正是撤销该允许的情形（既不能整个拒绝，也不能把他的改动一并盖掉）。
   * 见 ai-action.service 里"只记模型动过的字段"那段。
   */
  const milkNow = itemNamed(afterChange.body, '牛奶')
  await callWithRetry('PATCH', `/fridge/${milkNow.id}`, { token: mama.token, body: { note: '给奶奶的' } })

  const revert = await callWithRetry('POST', `/ai/actions/${changeReceipt.id}/undo`, { token: mama.token })
  const reverted = itemNamed((await callWithRetry('GET', '/fridge', { token: mama.token })).body, '牛奶')
  check(
    '撤"改"：数量**写回改之前的那个值**（不是删掉、也不是留着改后的值）',
    revert.status === 200 && reverted?.amount === '两盒',
    `status=${revert.status} amount=${JSON.stringify(reverted?.amount)}`,
  )
  check(
    '用户自己改过的那个字段**原样保留**（撤 AI 的改动不该顺手动用户的）',
    reverted?.note === '给奶奶的',
    `note=${JSON.stringify(reverted?.note)}`,
  )

  // ---------- ⑦ 菜单、餐次与组合：全应用 CRUD（用户 2026-10-13 的扩展）----------

  /*
   * 这一段与上面冰箱那几段**同一套路**：走真路（stub 决定调工具 → 服务端真写库 →
   * 回执 → 撤），且每一步都回到接口去核实"库里真的变了"。
   *
   * 为什么不能只验"回执卡出来了"：回执是**服务端自己拼的**，它说"加进去了"而库里
   * 什么都没有，单看回执完全看不出来（第一版冰箱撤销那个 bug 就是这种形状——
   * 界面一片正常，用户点「撤」才发现撤的是别的东西）。
   */
  const plan = await callWithRetry('GET', '/orders/plan?days=3', { token: mama.token })
  const today = plan.body?.days?.[0]?.date ?? soonKey()
  const todayLunch = `${today}-LUNCH`

  const added = await chatStream(mama.token, say('帮我加进菜单，今天午餐来一道番茄，少放盐'))
  const card = await callWithRetry('GET', '/orders?family=true', { token: mama.token })
  const cardOf = (body) => (body?.cards ?? []).find((row) => row.mealKey === todayLunch)
  const todayCard = cardOf(card.body)
  check(
    '**一句"加进菜单"真的往那一餐里加了菜**（不是只给建议）',
    (todayCard?.items ?? []).length > 0 && added.receipts.length > 0,
    `items=${(todayCard?.items ?? []).map((item) => item.name).join(',')} receipts=${added.receipts.length}`,
  )
  check(
    '加菜的回执是"撤掉"，且一道一行（不是整批一个按钮）',
    added.receipts.every((item) => item.label === '撤掉') && added.receipts.length === (todayCard?.items ?? []).length,
    `labels=${JSON.stringify(added.receipts.map((item) => item.label))} items=${(todayCard?.items ?? []).length}`,
  )

  /*
   * 顺序是刻意的：**先改人数与状态，最后再撤菜**。
   * 撤掉最后一道菜时那一餐会被删掉（`orders.removeItem` 的行为），
   * 之后再想"改人数/改状态"就没有那一餐可改了——第一版就是这么红的，
   * 看着像 AI 坏了，其实是验收顺序把前提交没了。
   */
  const diners = await chatStream(mama.token, say('今天午餐改成 5 个人吃'))
  const dinerCard = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
  check(
    '**"5 个人吃"真的写进了那一餐**（dinerCount=5，回执上是"改回去"）',
    dinerCard?.dinerCount === 5 && diners.receipts.some((item) => item.label === '改回去'),
    `dinerCount=${dinerCard?.dinerCount} receipts=${JSON.stringify(diners.receipts.map((item) => item.label))}`,
  )
  const dinerReceipt = diners.receipts.find((item) => item.label === '改回去')
  if (dinerReceipt) {
    const dinerUndo = await callWithRetry('POST', `/ai/actions/${dinerReceipt.id}/undo`, { token: mama.token })
    const backCard = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
    check(
      '撤"改人数"：写回改之前的那个值（原来没定，撤完就是没定）',
      dinerUndo.status === 200 && backCard?.dinerCount === null,
      `status=${dinerUndo.status} dinerCount=${JSON.stringify(backCard?.dinerCount)}`,
    )
  }

  const status = await chatStream(mama.token, say('今天午餐选好了，就这么定'))
  const statusCard = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
  check(
    '**"选好了"真的把那一餐改成已安排**',
    statusCard?.status === 'PLANNED',
    `status=${statusCard?.status}`,
  )
  check(
    '状态流转的回执**没有撤销按钮**（label 是空串：画一个点了只会被拒的按钮比没有更糟）',
    status.receipts.length > 0 && status.receipts.every((item) => item.label === ''),
    `labels=${JSON.stringify(status.receipts.map((item) => item.label))}`,
  )
  const statusUndo = status.receipts[0]
    ? await callWithRetry('POST', `/ai/actions/${status.receipts[0].id}/undo`, { token: mama.token })
    : null
  check(
    '真去撤状态那笔：409 且给一句"回不去"的人话（不是 500，也不是"不支持撤销"）',
    statusUndo === null || (statusUndo.status === 409 && /回不去/.test(JSON.stringify(statusUndo.body))),
    `status=${statusUndo?.status} body=${JSON.stringify(statusUndo?.body)?.slice(0, 60)}`,
  )

  /*
   * 撤菜：这一餐现在是「已安排」，**加不进新菜**——这条本身就是产品该有的行为（D-022），
   * 顺手在这里验它：AI 该如实说清原因，而不是静默失败或硬写进去。
   */
  const blocked = await chatStream(mama.token, say('帮我加进菜单，今天午餐再来一道豆腐'))
  check(
    '已经「已安排」的那一餐**加不进新菜**，且 AI 如实说清了原因（不是静默失败）',
    blocked.receipts.length === 0 && /安排|取消/.test(blocked.text),
    `text=${blocked.text.slice(0, 50)} receipts=${blocked.receipts.length}`,
  )

  /*
   * 撤菜那一路要先让那一餐回到"能加菜"的状态：直接用接口取消这一餐
   * （不走 AI——这一步是"用户自己去点单页操作"，验收里造这个前提最直接），
   * 再让 AI 加一道、然后撤掉它。
   */
  await callWithRetry('POST', `/orders/meals/${todayLunch}/status`, { token: mama.token, body: { status: 'CANCELED' } })
  const readded = await chatStream(mama.token, say('帮我加进菜单，今天午餐来一道豆腐'))
  const readdedCard = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
  check(
    '取消过的餐**能重新点菜**（AI 加的菜把这一餐救回来了，状态回到待确认）',
    (readdedCard?.items ?? []).length > 0 && readdedCard?.status === 'PENDING',
    `items=${(readdedCard?.items ?? []).map((item) => item.name).join(',')} status=${readdedCard?.status}`,
  )

  /*
   * **撤「撤菜」**：让 AI **删**一道（那一道很可能就是那一餐唯一的一道，
   * 整餐会跟着消失——这正是最难的边界：撤销时那一餐已经不存在了，得按需重建）。
   */
  const dishRemoved = await chatStream(mama.token, say('帮我从菜单里撤掉这道豆腐'))
  const afterRemoved = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
  check(
    '**AI 撤菜是真的撤**（那道从菜单里没了），回执上给的是"放回去"',
    dishRemoved.receipts.length > 0
      && dishRemoved.receipts.every((item) => item.label === '放回去')
      && !(afterRemoved?.items ?? []).some((item) => item.name.includes('豆腐')),
    `receipts=${JSON.stringify(dishRemoved.receipts.map((item) => `${item.label}:${item.summary}`))} items=${(afterRemoved?.items ?? []).map((item) => item.name).join(',') || '(空了)'}`,
  )
  const menuRemoveReceipt = dishRemoved.receipts[0]
  const menuRestoreUndo = await callWithRetry('POST', `/ai/actions/${menuRemoveReceipt.id}/undo`, { token: mama.token })
  const afterMenuRestore = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
  check(
    '**撤"撤菜"：那道照原样回到菜单里**（那一餐要能按需重建）',
    menuRestoreUndo.status === 200 && (afterMenuRestore?.items ?? []).some((item) => item.name.includes('豆腐')),
    `status=${menuRestoreUndo.status} items=${(afterMenuRestore?.items ?? []).map((item) => item.name).join(',')}`,
  )
  const twiceUndo = await callWithRetry('POST', `/ai/actions/${menuRemoveReceipt.id}/undo`, { token: mama.token })
  check(
    '同一笔不能撤两次：409',
    twiceUndo.status === 409 && /已经撤过/.test(JSON.stringify(twiceUndo.body)),
    `status=${twiceUndo.status}`,
  )

  /*
   * 再点回去（那一餐可能已经被删光了——撤掉最后一道菜时整餐会消失，
   * 这正是"撤销要能按需重建那一餐"的边界）。
   */
  const restoreOne = await chatStream(mama.token, say('帮我加进菜单，今天午餐来一道白菜'))
  const restoredCard = cardOf((await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body)
  check(
    '那一餐被撤空之后还能重新点进去（撤销/再点都不该被"这一餐不存在"挡住）',
    restoreOne.receipts.length > 0 && (restoredCard?.items ?? []).length > 0,
    `receipts=${restoreOne.receipts.length} items=${(restoredCard?.items ?? []).map((item) => item.name).join(',')}`,
  )

  // ---------- 组合 ----------

  const combo = await chatStream(mama.token, say('把这道豆腐存成一个组合叫快手三菜'))
  const combos = await callWithRetry('GET', '/combos', { token: mama.token })
  const created = (combos.body?.combos ?? []).find((item) => item.name === '快手三菜')
  check(
    '**"存成一个组合"真的建出来了**（带菜、带创建人）',
    Boolean(created) && created.dishCount >= 1 && combo.receipts.length > 0,
    `name=${created?.name} dishes=${created?.dishCount} receipts=${combo.receipts.length}`,
  )
  const comboReceipt = combo.receipts[0]
  check(
    '建组合的回执是"撤掉"（新建这一类都能撤回）',
    comboReceipt?.label === '撤掉',
    `label=${comboReceipt?.label}`,
  )

  /*
   * 再点一次（F3-06）：前提是**来源那一餐已经定局**。今天午餐这时是「待确认」，
   * 所以先用接口把它推到"已做好"（用户自己收尾那一步，不走 AI），再让 AI 照抄到明天晚餐。
   */
  await callWithRetry('POST', `/orders/meals/${todayLunch}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${todayLunch}/status`, { token: mama.token, body: { status: 'COOKING' } })
  await callWithRetry('POST', `/orders/meals/${todayLunch}/status`, { token: mama.token, body: { status: 'DONE' } })
  const repeatTarget = `${menuDateForVerify(1)}-DINNER`
  const repeated = await chatStream(mama.token, say('照抄今天午餐，明天晚餐再点一次'))
  const allCards = (await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body?.cards ?? []
  const tomorrowCard = allCards.find((row) => row.mealKey === repeatTarget)
  check(
    '**"再点一次"真的把那一桌照抄到明天晚餐**（每道一张可撤的回执）',
    (tomorrowCard?.items ?? []).length > 0 && repeated.receipts.length > 0,
    `items=${(tomorrowCard?.items ?? []).map((item) => item.name).join(',')} receipts=${repeated.receipts.length}`,
  )
  const repeatReceipt = repeated.receipts[0]
  if (repeatReceipt) {
    const repeatUndo = await callWithRetry('POST', `/ai/actions/${repeatReceipt.id}/undo`, { token: mama.token })
    const afterRepeat = (await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body?.cards
      ?.find((row) => row.mealKey === repeatTarget)
    check(
      '撤"照抄过来的一道"：只撤那一道（目标那一餐里别的菜不受影响）',
      repeatUndo.status === 200 && (afterRepeat?.items ?? []).length < (tomorrowCard?.items ?? []).length,
      `status=${repeatUndo.status} before=${(tomorrowCard?.items ?? []).length} after=${(afterRepeat?.items ?? []).length}`,
    )
  }

  /*
   * 用组合加菜（`add_combo_to_meal`）：组合这会儿还在（上面只验了回执文案，没撤它），
   * 把它整组加进明天午餐，再撤掉其中一道（逐道可撤，不是整组绑一起）。
   */
  const comboAdd = await chatStream(mama.token, say('用这个组合加菜，明天午餐'))
  const comboMeal = (await callWithRetry('GET', '/orders?family=true', { token: mama.token })).body?.cards
    ?.find((row) => row.mealKey === `${menuDateForVerify(1)}-LUNCH`)
  check(
    '**"用这个组合加菜"真的把整组加了进去**（每道一张回执）',
    (comboMeal?.items ?? []).length > 0 && comboAdd.receipts.length > 0,
    `items=${(comboMeal?.items ?? []).map((item) => item.name).join(',')} receipts=${comboAdd.receipts.length}`,
  )
  const comboAddReceipt = comboAdd.receipts[0]
  if (comboAddReceipt) {
    const comboAddUndo = await callWithRetry('POST', `/ai/actions/${comboAddReceipt.id}/undo`, { token: mama.token })
    check(
      '撤"组合加进来的某一道"：200（逐道可撤）',
      comboAddUndo.status === 200,
      `status=${comboAddUndo.status}`,
    )
  }

  // 最后删组合（`delete_combo`）→ 撤回 → 组合带着菜一起回来
  const comboDel = await chatStream(mama.token, say('删掉这个组合'))
  const afterDelete = await callWithRetry('GET', '/combos', { token: mama.token })
  const delReceipt = comboDel.receipts.find((item) => item.label === '放回去')
  check(
    '**AI 删组合是真的删**（列表里没了），回执上给的是"放回去"',
    Boolean(delReceipt) && !(afterDelete.body?.combos ?? []).some((item) => item.name === '快手三菜'),
    `receipts=${JSON.stringify(comboDel.receipts.map((item) => item.label))} remaining=${(afterDelete.body?.combos ?? []).map((item) => item.name).join(',')}`,
  )
  if (delReceipt) {
    const delUndo = await callWithRetry('POST', `/ai/actions/${delReceipt.id}/undo`, { token: mama.token })
    const afterDelUndo = await callWithRetry('GET', '/combos', { token: mama.token })
    const restoredCombo = (afterDelUndo.body?.combos ?? []).find((item) => item.name === '快手三菜')
    check(
      '**撤"删组合"：组合带着组里的菜一起回来了**（少一道就是少一道）',
      delUndo.status === 200 && Boolean(restoredCombo) && restoredCombo.dishCount === created?.dishCount,
      `status=${delUndo.status} dishes=${restoredCombo?.dishCount} 原来是=${created?.dishCount}`,
    )
  }

  // ---------- ⑧ 自建菜谱（F1-11 / F1-12）：AI 存一道 → **撤得掉** ----------

  /*
   * 这一段是**补上来的**：在此之前，验收与单测都没走过"AI 写菜谱 → 撤销"这条路，
   * 而它当时整条是坏的（`recipeTouched` 拿整份 undoData 去比快照，`recipeId` 找不到 →
   * 每一次撤销都被误判成"用户自己改过"而拒绝）。**只有浏览器里用真模型才撞出来**。
   * 从此以后这条只要坏，这里就红。
   */
  const saved = await chatStream(mama.token, say('我家的凉拌黄瓜是这么做的：黄瓜拍碎加蒜末，放盐、醋和一点香油拌匀。帮我存进我家的菜谱'))
  const mineAfterSave = await callWithRetry('GET', '/recipes?mine=1', { token: mama.token })
  const selfBuilt = (mineAfterSave.body?.items ?? []).find((item) => item.name === '凉拌黄瓜')
  check(
    '**AI 口述的做法真的存进了「我家的菜谱」**（`mine=1` 查得到，且标着自己上传）',
    Boolean(selfBuilt) && selfBuilt.origin === 'user' && selfBuilt.mine === true,
    `name=${selfBuilt?.name} origin=${selfBuilt?.origin} mine=${selfBuilt?.mine} receipts=${saved.receipts.length}`,
  )
  check(
    '自建菜谱的列表项带**来源区分**（`sourceLabel` 是"自己上传"，不是空串或英文 origin）',
    selfBuilt?.sourceLabel === '自己上传',
    `sourceLabel=${selfBuilt?.sourceLabel}`,
  )

  const saveReceipt = saved.receipts.find((item) => /菜谱/.test(item.summary))
  const recipeUndo = saveReceipt
    ? await callWithRetry('POST', `/ai/actions/${saveReceipt.id}/undo`, { token: mama.token })
    : null
  const mineAfterUndo = await callWithRetry('GET', '/recipes?mine=1', { token: mama.token })
  check(
    '**撤"新建菜谱"：那道真的从「我家的菜谱」里没了**（这是之前整条坏掉的那一步）',
    recipeUndo?.status === 200 && !(mineAfterUndo.body?.items ?? []).some((item) => item.name === '凉拌黄瓜'),
    `status=${recipeUndo?.status} body=${JSON.stringify(recipeUndo?.body)?.slice(0, 70)} 还剩=${(mineAfterUndo.body?.items ?? []).map((item) => item.name).join(',')}`,
  )

  // 公共菜谱改不了：让 AI 去改库里导入的那道，必须被拒且给出人话
  const imported = (await callWithRetry('GET', '/recipes?pageSize=1', { token: mama.token })).body?.items?.[0]
  if (imported && imported.origin !== 'user') {
    const publicEdit = await chatStream(mama.token, say(`把菜谱「${imported.name}」改成我家的做法`))
    const stillThere = await callWithRetry('GET', `/recipes/${imported.id}`, { token: mama.token })
    check(
      '**公共菜谱 AI 改不了**（改不动就如实说，不能偷偷写一份自己的）',
      Boolean(stillThere.body) && publicEdit.receipts.length === 0,
      `receipts=${publicEdit.receipts.length} text=${publicEdit.text.slice(0, 40)}`,
    )
  }

  // ---------- ⑨ 越权 ----------

  const papa = await newUser('AI 助手爸')
  await callWithRetry('POST', '/family/join', { token: papa.token, body: { inviteCode: family.inviteCode } })
  const otherUndo = await callWithRetry('POST', `/ai/actions/${remove2.id}/undo`, { token: papa.token })
  check(
    '家里**别人不能撤你让 AI 做的事**：403',
    otherUndo.status === 403,
    `status=${otherUndo.status} body=${JSON.stringify(otherUndo.body)?.slice(0, 60)}`,
  )

  const outsider = await newUser('AI 助手邻居')
  await newFamily(outsider.token, '邻居家')
  const crossUndo = await callWithRetry('POST', `/ai/actions/${remove2.id}/undo`, { token: outsider.token })
  check(
    '别家人撤你家的记录：403（不是 200，也不是 500）',
    crossUndo.status === 403,
    `status=${crossUndo.status}`,
  )

  const missing = await callWithRetry('POST', '/ai/actions/does-not-exist/undo', { token: mama.token })
  check('撤一笔不存在的记录：404', missing.status === 404, `status=${missing.status}`)

  const anonymous = await callWithRetry('GET', '/ai/actions')
  check('未登录看可撤销列表：401', anonymous.status === 401, `status=${anonymous.status}`)

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
