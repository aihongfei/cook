#!/usr/bin/env node
/**
 * 「AI 会办采购清单了」的 HTTP 验收（M7 / M16，用户 2026-10-14 要求）。
 *
 * 用法：先起 stub 上游与指向它的 API（见 RUNBOOK R-061），再执行
 *   pnpm --dir services/api run test:http:ai-shopping
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * **为什么要有这一条**：接入之前模型的原话是
 * 「我这边没有『采购单』这个功能，做不了它——只能帮你记冰箱里已有的东西」
 * （用户截图里就是这句）。它说的是实话：AI 的工具表里根本没有采购清单。
 * 这一组走**真路**——`/ai/chat/stream` + stub 上游（模型真的决定调工具、服务端真的执行、
 * 真的落库），验的就是"它现在真的能办"，而不是"某个函数返回了字符串"。
 *
 * 覆盖：
 * ① 读清单（"我看看清单上有什么"）——一条回执都不该有（读不写库）；
 * ② "采购清单上加一样垃圾袋" → 真加进去（走用户自己那条 `addExtra`）；
 * ③ 再加一样同名的 → 被拒且如实说（**不许谎报"加好了"**）；
 * ④ "我都买到了" → 真勾上（刷新后还在）；
 * ⑤ "收进冰箱" → 真把勾掉的那样写进冰箱（F7-05），回执按**冰箱那条 kind** 记；
 * ⑥ 撤"补货"那一笔 → 刚进冰箱的那样真的没了；
 * ⑦ 撤"加条目"那一笔 → 清单上那条真的没了；
 * ⑧ 菜单推出来的那几条删不掉 → 不许谎报，要说明"勾掉就行"；
 * ⑨ 没加入家庭的人：清单接口 404，AI 一个字的库也没写、并说清原因。
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

/** AI 那条流是 10 次/分，本脚本要问好几轮——等上一轮窗口过去再开跑 */
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
  const account = `aish${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token }
}

/**
 * 打一次流式问答，把 SSE 四种事件收下来。
 *
 * **必须自己读流**（不能用 `/ai/chat`）：回执只有流式这条路上有，而这一组要验的
 * 恰恰是"它真写进库了、且那张卡上的「撤」真能撤"。
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
/** 清单上的全部条目名（含自加的与菜单推出来的） */
const boardNames = (board) => (board?.items ?? []).map((item) => item.name)
const boardItem = (board, name) => (board?.items ?? []).find((item) => item.name === name) ?? null
const flattenFridge = (board) => (board?.zones ?? []).flatMap((group) => group.items)

async function main() {
  await settleThrottleWindow()

  const mama = await newUser('清单妈')
  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '清单之家' } })
  if (family.status !== 201) throw new Error(`建家庭失败：${family.status}`)
  const board = () => callWithRetry('GET', '/shopping-list', { token: mama.token })

  /*
   * 让清单上有东西可算：点一道菜进今天晚餐，再把这餐定成「已安排」。
   *
   * **这两步都不能省**：清单按 `F7-01` 只算"定了的"那一餐（PLANNED / COOKING），
   * 刚点完的餐是 PENDING（还在收集中：可能还要加菜、也可能取消，照它去买会白跑一趟）。
   * 只点不定，清单就是空的——第一版验收脚本就漏了这一步，于是"清单能读出来"那条红着，
   * 而后面几条看着"过了"其实是在一条空清单上过的（`toBuyCount=0`）。
   *
   * 直接调点菜与状态接口——这一组要验的是"AI 会办清单"，不是"AI 会点菜/会改状态"
   * （那两条 R-043 已验过）。
   */
  const today = new Date()
  const mealDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const recipes = await callWithRetry('GET', '/recipes?pageSize=8', { token: mama.token })
  const candidates = recipes.body?.items ?? []
  if (candidates.length === 0) throw new Error('菜谱库是空的，验收跑不了（先导入菜谱）')
  /*
   * 挑一道**有配料表**的菜：清单是配料聚合出来的，选到一道配料为空的
   * （自由菜品那种）清单还是空的，后面几条就会在空清单上"过"掉。
   */
  let recipe = null
  for (const row of candidates) {
    const detail = await callWithRetry('GET', `/recipes/${row.id}`, { token: mama.token })
    if ((detail.body?.ingredients?.length ?? 0) > 0) { recipe = detail.body; break }
  }
  if (!recipe) throw new Error('这一页菜谱都没有配料表，换一页再跑（验收要一道能推出清单的菜）')
  const ordered = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: recipe.id, mealDate, meal: 'DINNER' },
  })
  check('前置：点一道菜进今天晚餐', ordered.status < 300, `status=${ordered.status} recipe=${recipe.name}`)
  const planned = await callWithRetry('POST', `/orders/meals/${mealDate}-DINNER/status`, {
    token: mama.token,
    body: { status: 'PLANNED' },
  })
  check(
    '前置：把这餐定成「已安排」（清单只算定了的餐）',
    planned.status < 300,
    `status=${planned.status}`,
  )

  const before = await board()
  check(
    '前置：清单能读出来（按菜单配料算的）',
    before.status === 200 && (before.body?.items?.length ?? 0) > 0,
    `status=${before.status} toBuyCount=${before.body?.toBuyCount} items=${JSON.stringify(boardNames(before.body).slice(0, 6))}`,
  )
  const menuItem = boardNames(before.body)[0] ?? ''

  // ---------- ① 读清单：不写库 ----------

  const read = await chatStream(mama.token, say('我看看采购清单上有什么要买的'))
  check(
    'AI 真的去读了采购清单（状态行能看出来）',
    read.statuses.some((label) => /要买什么/.test(label)),
    `statuses=${JSON.stringify(read.statuses)}`,
  )
  check(
    '读清单**不写库**：一个回执都不该有',
    read.receipts.length === 0,
    `receipts=${read.receipts.length}`,
  )
  check(
    '读完能说出一句实情（不是空话）',
    read.text.trim().length > 0,
    `text=${read.text.slice(0, 60)}`,
  )

  // ---------- ② 加自加条目：真的进清单 ----------

  const added = await chatStream(mama.token, say('采购清单上加一样垃圾袋，两卷'))
  const afterAdd = await board()
  check(
    '**一句"清单上加一样垃圾袋"真的加进去了**（此前模型只会说"我没有这个功能"）',
    boardNames(afterAdd.body).includes('垃圾袋'),
    `names=${JSON.stringify(boardNames(afterAdd.body).slice(0, 8))}`,
  )
  check(
    '加进去那条带数量（"两卷"照抄了）',
    boardItem(afterAdd.body, '垃圾袋')?.amount === '两卷',
    `amount=${boardItem(afterAdd.body, '垃圾袋')?.amount}`,
  )
  check(
    '回执卡给出来了（真的写库才有卡），标签是「撤掉」',
    added.receipts.some((item) => /垃圾袋/.test(item.summary)) && added.receipts.every((item) => item.label === '撤掉'),
    `receipts=${JSON.stringify(added.receipts.map((item) => `${item.summary}/${item.label}`))}`,
  )

  // ---------- ③ 同名重复：被拒且如实说 ----------

  const dup = await chatStream(mama.token, say('采购清单上再加一样垃圾袋'))
  const afterDup = await board()
  check(
    '再加一样同名的：清单上仍然只有一条（服务端拒了，没变成两行）',
    boardNames(afterDup.body).filter((name) => name === '垃圾袋').length === 1,
    `count=${boardNames(afterDup.body).filter((name) => name === '垃圾袋').length}`,
  )
  check(
    '**被拒了就要说"已经有了"**，不许说"加好了"',
    /已经|有了|不用再加|重复/.test(dup.text) && !/加好了|加上了|加进去了/.test(dup.text),
    `text=${dup.text.slice(0, 60)}`,
  )
  check(
    '被拒那一次不该再给一张"撤"的卡（没发生的事不能给撤销）',
    dup.receipts.length === 0,
    `receipts=${JSON.stringify(dup.receipts.map((item) => item.summary))}`,
  )

  // ---------- ④ 勾选：真的落库 ----------

  const checkTargets = boardNames(afterDup.body).slice(0, 2)
  const checked = await chatStream(mama.token, say(`清单上这几样我都买到了：${checkTargets.join('、')}`))
  const afterCheck = await board()
  check(
    '**"我都买到了"真的把勾落库了**（刷新后还在）',
    (afterCheck.body?.checkedNames?.length ?? 0) > 0,
    `checked=${JSON.stringify(afterCheck.body?.checkedNames)}`,
  )
  check(
    '勾选也有回执可撤（标签是"按回去"）',
    checked.receipts.some((item) => item.label === '按回去'),
    `labels=${JSON.stringify(checked.receipts.map((item) => item.label))}`,
  )

  // ---------- ⑤ 一键补货：勾掉的那样真的进冰箱，没勾的一律不动 ----------

  const fridgeBefore = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '前置：补货之前冰箱是空的（这样"多了哪几条"才数得清）',
    flattenFridge(fridgeBefore.body).length === 0,
    `冰箱里=${JSON.stringify(flattenFridge(fridgeBefore.body).map((item) => item.name))}`,
  )
  const restocked = await chatStream(mama.token, say('把买到的东西收进冰箱吧'))
  const fridgeAfter = await callWithRetry('GET', '/fridge', { token: mama.token })
  const checkedNames = afterCheck.body?.checkedNames ?? []
  const filled = flattenFridge(fridgeAfter.body)
  check(
    '**"收进冰箱"真的把勾掉的那样写进了冰箱**（F7-05）',
    filled.length > 0 && filled.every((item) => checkedNames.includes(item.name)),
    `checked=${JSON.stringify(checkedNames)} 冰箱里=${JSON.stringify(filled.map((item) => `${item.name}（${item.zone}）`))}`,
  )
  check(
    '**没勾的一律没动**（补货只认那个勾，不认模型说了什么）',
    filled.every((item) => checkedNames.includes(item.name))
      && filled.length <= checkedNames.length,
    `冰箱 ${filled.length} 条 / 勾了 ${checkedNames.length} 条`,
  )
  check(
    '补货的回执按**冰箱那条**记（撤的也是冰箱那一条，不是另一套口径）',
    restocked.receipts.some((item) => item.kind === 'fridge.create')
      && restocked.receipts.every((item) => item.label === '撤掉'),
    `kinds=${JSON.stringify(restocked.receipts.map((item) => `${item.kind}/${item.label}`))}`,
  )

  // ---------- ⑥ 撤"补货"：补进去的那几条，撤一笔少一条 ----------

  /*
   * 按**回执自己的 target**（冰箱里那一条的 id）来核，不按名字猜。
   *
   * 第一版这里是"拿 checkedNames 里的第一个名字去看冰箱"，结果红着：
   * 回执的顺序与清单上勾选的顺序**不是一回事**（回执是按补货结果给的），
   * 撤掉的是另一样，于是"撤了它怎么还在"——其实是断言指错了对象。
   * 撤销这件事本身要问的是**这一笔指向的那条**还在不在。
   */
  const fridgeReceipts = restocked.receipts.filter((item) => item.kind === 'fridge.create')
  const undoLog = []
  let eachReceiptUndone = fridgeReceipts.length > 0
  for (const receipt of fridgeReceipts) {
    const beforeUndo = await callWithRetry('GET', '/fridge', { token: mama.token })
    const had = flattenFridge(beforeUndo.body).some((item) => item.id === receipt.target)
    const undone = await callWithRetry('POST', `/ai/actions/${receipt.id}/undo`, { token: mama.token })
    const afterUndo = await callWithRetry('GET', '/fridge', { token: mama.token })
    const gone = !flattenFridge(afterUndo.body).some((item) => item.id === receipt.target)
    if (!(had && gone && undone.status === 200)) eachReceiptUndone = false
    undoLog.push(`${receipt.summary}→撤前在=${had} 撤后没了=${gone} ${undone.body?.message ?? ''}`)
  }
  check(
    '**撤掉补货那一笔：那条真的从冰箱里没了**（一笔一笔都对得上）',
    eachReceiptUndone,
    undoLog.join(' | ') || '没有冰箱回执可撤',
  )
  const fridgeEmptied = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '补货补进去的一共几条、全撤完冰箱里就一条不剩（没多撤也没漏撤）',
    fridgeReceipts.length > 0 && flattenFridge(fridgeEmptied.body).length === 0,
    `回执 ${fridgeReceipts.length} 条，冰箱剩 ${JSON.stringify(flattenFridge(fridgeEmptied.body).map((item) => item.name))}`,
  )

  // ---------- ⑦ 撤"加条目"：清单上那条真的没了 ----------

  const addReceipt = added.receipts.find((item) => /垃圾袋/.test(item.summary))
  if (addReceipt) {
    const undone = await callWithRetry('POST', `/ai/actions/${addReceipt.id}/undo`, { token: mama.token })
    const boardUndone = await board()
    check(
      '撤掉"加进清单"那一笔：200 且**清单上真的没了**',
      undone.status === 200 && !boardNames(boardUndone.body).includes('垃圾袋'),
      `status=${undone.status} msg=${undone.body?.message ?? ''}`,
    )
  } else {
    check('撤掉"加进清单"那一笔：200 且**清单上真的没了**', false, '没有加条目的回执可撤')
  }

  // ---------- ⑧ 菜单推出来的那几条删不掉：不许谎报 ----------

  if (menuItem) {
    const cannotRemove = await chatStream(mama.token, say(`把「${menuItem}」从清单上去掉`))
    const boardStill = await board()
    check(
      `菜单推出来的「${menuItem}」删不掉时不许谎报：条目还在，且说清该怎么弄`,
      boardNames(boardStill.body).includes(menuItem) && /菜单|勾/.test(cannotRemove.text),
      `还在=${boardNames(boardStill.body).includes(menuItem)} text=${cannotRemove.text.slice(0, 60)}`,
    )
  } else {
    check('菜单推出来的条目删不掉时不许谎报', false, '清单上没有菜单推出的条目，跳过')
  }

  // ---------- ⑨ 家庭归属：没有家庭的人用不了，且要说出来 ----------

  const solo = await newUser('没家的小明')
  const soloBoard = await callWithRetry('GET', '/shopping-list', { token: solo.token })
  const soloTry = await chatStream(solo.token, say('我看看采购清单上有什么要买的'))
  check(
    '没加入家庭的人：清单接口 404（AI 也变不出来）',
    soloBoard.status === 404,
    `status=${soloBoard.status}`,
  )
  check(
    '而且 AI 要说清是"先加入家庭"，不是一句笼统的失败',
    soloTry.receipts.length === 0 && /家庭/.test(soloTry.text),
    `receipts=${soloTry.receipts.length} text=${soloTry.text.slice(0, 60)}`,
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
