#!/usr/bin/env node
/**
 * 「AI 会办口味与忌口了」的 HTTP 验收（M8 / F8-01、F8-02，用户 2026-10-14 要求）。
 *
 * 用法：先起 stub 上游与指向它的 API（见 RUNBOOK R-061），再执行
 *   pnpm --dir services/api run test:http:ai-taste
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * **为什么单独一条**：`read_taste` / `update_taste` 的工具早就接上了，
 * 但**从来没有端到端验过**——stub 上游里压根没有这一支，所以"用户说一句'我不吃辣'
 * 到底会不会写进他自己的档案"这件事在本地一次也没被走过。用户 2026-10-14 把
 * 「口味忌口」与采购清单并列提出来（「等现在所有没接入 ai 的功能」），
 * 这一组就是把那句话走成真的。
 *
 * 三条分寸各有一条断言盯着：
 * ① **只写用户说的那几项**：说"不吃辣"不该顺手写出过敏原（写进去会真的过滤推荐）；
 * ② **只改自己的**：同一个人说"我妈对花生过敏"也只落在**他自己**那份上——
 *    替别人写档案是 AI 不该有的权力（那会改掉别人点菜时看到的提醒）；
 * ③ **撤得回来**：撤掉那一笔，辣度回到写之前的那个值。
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
  const account = `aitaste${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, nickname }
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

async function main() {
  await settleThrottleWindow()

  const mama = await newUser('口味妈')
  const family = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '口味之家' } })
  if (family.status !== 201) throw new Error(`建家庭失败：${family.status}`)
  const invite = family.body.inviteCode
  const papa = await newUser('口味爸')
  const joined = await callWithRetry('POST', '/family/join', {
    token: papa.token,
    body: { inviteCode: invite },
  })
  check('前置：两个人一个家（"只改自己的"这条才验得出来）', joined.status < 300, `status=${joined.status}`)

  const mine = () => callWithRetry('GET', '/taste', { token: mama.token })
  const papaMine = () => callWithRetry('GET', '/taste', { token: papa.token })

  check('前置：家里两个人都还没写过档案', (await mine()).body === null, `status=${(await mine()).status}`)

  // ---------- ① 说一句"我不吃辣"：真的写进自己的档案 ----------

  const spicy = await chatStream(mama.token, say('我不吃辣，做菜别放辣椒'))
  const afterSpicy = await mine()
  check(
    '**AI 真的去读了家里的档案**（状态行能看出来）',
    spicy.statuses.some((label) => /吃不了什么/.test(label)),
    `statuses=${JSON.stringify(spicy.statuses)}`,
  )
  check(
    '**一句"我不吃辣"真的写进了自己的档案**（此前这条没人验过，工具在不在都不知道）',
    afterSpicy.body?.spicyLevel === 0,
    `spicyLevel=${afterSpicy.body?.spicyLevel}`,
  )
  check(
    '回执卡给出来了（真的写库才有卡），标签是「改回去」',
    spicy.receipts.length > 0 && spicy.receipts.every((item) => item.label === '改回去'),
    `receipts=${JSON.stringify(spicy.receipts.map((item) => `${item.summary}/${item.label}`))}`,
  )

  // ---------- ② 只写说的那几项：不该顺手冒出过敏原 ----------

  check(
    '**只说"不吃辣"就只写辣度**：过敏原/不爱吃那几项不该凭空冒出来（写进去会真的过滤推荐）',
    (afterSpicy.body?.allergies?.length ?? 0) === 0 && (afterSpicy.body?.dislikes?.length ?? 0) === 0,
    `allergies=${JSON.stringify(afterSpicy.body?.allergies)} dislikes=${JSON.stringify(afterSpicy.body?.dislikes)}`,
  )

  // ---------- ③ 说"对花生过敏"：写进去，且不动刚才写的辣度 ----------

  const allergy = await chatStream(mama.token, say('另外我对花生过敏，这个要记一下'))
  const afterAllergy = await mine()
  check(
    '**"对花生过敏"真的写进了过敏原**（这条会真的影响推荐过滤）',
    (afterAllergy.body?.allergies ?? []).includes('花生'),
    `allergies=${JSON.stringify(afterAllergy.body?.allergies)}`,
  )
  check(
    '这次只改过敏原：刚才写的辣度**一个字没动**（部分更新，不是整份覆盖）',
    afterAllergy.body?.spicyLevel === 0,
    `spicyLevel=${afterAllergy.body?.spicyLevel}`,
  )

  // ---------- ④ 替别人说：只落在自己那份上 ----------

  const other = await chatStream(mama.token, say('我妈对虾过敏，帮她记一下'))
  const mamaAfterOther = await mine()
  const papaAfterOther = await papaMine()
  check(
    '**替别人说的也只落在自己那份上**（AI 没有替别人写档案的权力）',
    papaAfterOther.body === null,
    `爸爸那份=${JSON.stringify(papaAfterOther.body)}`,
  )
  check(
    '而且 AI 要说清"只能记你自己的"（不是静默丢掉）',
    /自己|你那份|本人|替他|她的档案/.test(other.text),
    `text=${other.text.slice(0, 70)}`,
  )
  check(
    '妈妈那份不该被"我妈"那句话改动（虾没被写进去）',
    !(mamaAfterOther.body?.allergies ?? []).includes('虾'),
    `allergies=${JSON.stringify(mamaAfterOther.body?.allergies)}`,
  )

  // ---------- ⑤ 撤销：辣度回到写之前的那个值 ----------

  const spicyReceipt = spicy.receipts[0]
  if (spicyReceipt) {
    const undone = await callWithRetry('POST', `/ai/actions/${spicyReceipt.id}/undo`, { token: mama.token })
    const afterUndo = await mine()
    check(
      '**撤掉那一笔：辣度回到写之前（原来是没写过 = null）**',
      undone.status === 200 && afterUndo.body?.spicyLevel === null,
      `status=${undone.status} spicyLevel=${afterUndo.body?.spicyLevel}`,
    )
    check(
      '撤这一笔不该带走另一笔（过敏原还在）',
      (afterUndo.body?.allergies ?? []).includes('花生'),
      `allergies=${JSON.stringify(afterUndo.body?.allergies)}`,
    )
  } else {
    check('撤掉那一笔：辣度回到写之前', false, '没有口味回执可撤')
  }

  // ---------- ⑥ 读全家：那两位没写档案的人要被点出来 ----------

  const readAll = await chatStream(mama.token, say('家里人有什么忌口吗'))
  check(
    '读全家档案时**说出还没写的人**（"还没写"本身就是有用的一条信息）',
    /没写|还没|写一下|档案/.test(readAll.text),
    `text=${readAll.text.slice(0, 70)}`,
  )
  check(
    '读档案那条路**不写库**（一个回执都不该有）',
    readAll.receipts.length === 0,
    `receipts=${readAll.receipts.length}`,
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
