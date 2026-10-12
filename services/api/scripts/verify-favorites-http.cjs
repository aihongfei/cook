#!/usr/bin/env node
/**
 * 收藏接口 HTTP 验收（真实请求，不 mock）。M1 / F1-09，口径见 D-037。
 * 用法：先启动服务，再执行 pnpm run test:http:favorites
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：登录才能用 → 切换是同一个接口（收藏/取消来回各一次，结果与总数都对得上）
 *       → 批量状态只回收藏了的 → 收藏列表最近收藏的在前 → 收藏一道别人的、自己没见过的菜
 *       → 不存在/空/非字符串的 id 被拒 → **收藏按人隔离**（别人的收藏不进我的列表）。
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

/**
 * 全局限流 60 次/分（按 IP 计数）。本脚本一轮 20+ 请求，连跑第二遍会被自己的限流打到 429。
 * 遇到 429 就等窗口过去重试（本脚本没有"必须 429"的用例，所以重试不会掩盖断言）。
 */
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
  const account = `fav${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: nickname ?? account },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, user: registered.body.user }
}

const names = (list) => (list.body?.items ?? []).map((item) => item.name)

async function main() {
  await settleThrottleWindow()

  // ---------- 前置：两道菜 ----------
  const recipes = await callWithRetry('GET', '/recipes?pageSize=2')
  const [dishA, dishB] = recipes.body?.items ?? []
  if (!dishA || !dishB) throw new Error('菜谱库为空，无法验收收藏（先跑种子导入）')

  const mama = await newUser('收藏验收妈')
  const son = await newUser('收藏验收娃')

  // ---------- 未登录 ----------
  const anonymous = await callWithRetry('GET', '/favorites')
  check('未带 token 看收藏列表 → 401', anonymous.status === 401, `${anonymous.status}`)

  const anonymousToggle = await callWithRetry('POST', '/favorites/toggle', { body: { recipeId: dishA.id } })
  check(
    '未带 token 点收藏 → 401（收藏挂在账号上，匿名没有账号可挂）',
    anonymousToggle.status === 401,
    `${anonymousToggle.status}`,
  )

  // ---------- 初次进来是空的 ----------
  const empty = await callWithRetry('GET', '/favorites', { token: mama.token })
  check(
    '刚注册的人收藏是空的，且带上限（界面据此说"收藏满了"）',
    empty.status === 200 && (empty.body?.items ?? []).length === 0 && empty.body?.total === 0 && empty.body?.limit > 0,
    `${empty.status} total=${empty.body?.total} limit=${empty.body?.limit}`,
  )

  // ---------- 切换：收一道 ----------
  const on = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishA.id } })
  check(
    '点一下收藏 → favorited=true，总数 1（接口回答的是"现在收藏了吗"）',
    on.status === 200 && on.body?.favorited === true && on.body?.total === 1,
    `${on.status} ${JSON.stringify(on.body)}`,
  )

  const afterOn = await callWithRetry('GET', '/favorites', { token: mama.token })
  check(
    '收完再看列表，那道菜在里面',
    afterOn.status === 200 && names(afterOn).includes(dishA.name),
    `${afterOn.status} ${JSON.stringify(names(afterOn))}`,
  )

  // ---------- 同一个接口再点一下 = 取消 ----------
  const off = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishA.id } })
  check(
    '同一个接口再点一下 → favorited=false，总数回 0（一颗心的开与关，不用两个接口）',
    off.status === 200 && off.body?.favorited === false && off.body?.total === 0,
    `${off.status} ${JSON.stringify(off.body)}`,
  )

  const afterOff = await callWithRetry('GET', '/favorites', { token: mama.token })
  check(
    '取消后列表里没有了（不是只在按钮上改了个样子）',
    !names(afterOff).includes(dishA.name),
    JSON.stringify(names(afterOff)),
  )

  // ---------- 连点两下回到原状：接口是幂等的"切换"，不是累加 ----------
  const twice = []
  twice.push(await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishA.id } }))
  twice.push(await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishA.id } }))
  check(
    '连点两下回到未收藏，且不会留下两条记录（不存在"收藏了两次"这种状态）',
    twice[0].body?.favorited === true && twice[1].body?.favorited === false && twice[1].body?.total === 0,
    `第一下=${JSON.stringify(twice[0].body)} 第二下=${JSON.stringify(twice[1].body)}`,
  )

  // ---------- 最近收藏的在前 ----------
  const favA = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishA.id } })
  const favB = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: dishB.id } })
  const ordered = await callWithRetry('GET', '/favorites', { token: mama.token })
  check(
    '后收的排在前面（收藏页最上面是"我刚想起来要做的"）',
    favA.status === 200 && favB.status === 200
      && names(ordered)[0] === dishB.name
      && names(ordered).includes(dishA.name)
      && ordered.body?.total === 2,
    `${JSON.stringify(names(ordered))} total=${ordered.body?.total}`,
  )

  const orderedAt = ordered.body?.items?.[0]?.favoritedAt
  check(
    '列表里带回收藏时间（前端要按时间排/显示"什么时候收的"）',
    typeof orderedAt === 'string' && !Number.isNaN(Date.parse(orderedAt)),
    `${orderedAt}`,
  )

  // ---------- 批量状态：只回收藏了的 ----------
  const status = await callWithRetry('POST', '/favorites/status', {
    token: mama.token,
    body: { recipeIds: [dishA.id, dishB.id, 'not-a-real-recipe-id'] },
  })
  const map = status.body?.favorited ?? {}
  check(
    '批量状态：收藏了的两个都是 true，没收藏的不出现（省一半体积，前端按"没回=未收藏"处理）',
    status.status === 200 && map[dishA.id] === true && map[dishB.id] === true && map['not-a-real-recipe-id'] === undefined,
    `${status.status} ${JSON.stringify(map)}`,
  )

  const statusEmpty = await callWithRetry('POST', '/favorites/status', { token: son.token, body: { recipeIds: [dishA.id] } })
  check(
    '换个人问同一批菜 → 空对象（**收藏是按人存的**，别人的收藏不出现）',
    statusEmpty.status === 200 && Object.keys(statusEmpty.body?.favorited ?? {}).length === 0,
    `son=${JSON.stringify(statusEmpty.body?.favorited)}`,
  )

  const statusJunk = await callWithRetry('POST', '/favorites/status', { token: mama.token, body: { recipeIds: 'oops' } })
  check(
    '批量状态的入参不是数组 → 当成没问，不炸（列表页少一屏状态不该把页面打崩）',
    statusJunk.status === 200 && Object.keys(statusJunk.body?.favorited ?? {}).length === 0,
    `${statusJunk.status} ${JSON.stringify(statusJunk.body)}`,
  )

  // ---------- 收藏按人隔离 ----------
  const sonList = await callWithRetry('GET', '/favorites', { token: son.token })
  check(
    '别人收藏的菜不出现在我的列表里（共享开关管的是点单与照片，与私人收藏无关）',
    sonList.status === 200 && (sonList.body?.items ?? []).length === 0,
    `son total=${sonList.body?.total}`,
  )

  // ---------- 坏 id ----------
  const ghost = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: 'no-such-recipe-xyz' } })
  check(
    '收藏一道菜谱库里没有的 → 404 且话术可读（不是数据库外键错误）',
    ghost.status === 404 && typeof ghost.body?.message === 'string',
    `${ghost.status} ${ghost.body?.message ?? ''}`,
  )

  const blank = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: '   ' } })
  check('空的菜谱 id → 400（空格不算一道菜）', blank.status === 400, `${blank.status}`)

  const notString = await callWithRetry('POST', '/favorites/toggle', { token: mama.token, body: { recipeId: 123 } })
  check('菜谱 id 写成数字 → 400', notString.status === 400, `${notString.status}`)

  // 坏 id 被拒之后，原有的两条收藏不受影响
  const afterJunk = await callWithRetry('GET', '/favorites', { token: mama.token })
  check(
    '被拒的请求不改动已有收藏（失败是失败，不是悄悄删一条）',
    afterJunk.body?.total === 2,
    `total=${afterJunk.body?.total}`,
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
