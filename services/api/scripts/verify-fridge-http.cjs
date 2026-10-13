#!/usr/bin/env node
/**
 * 冰箱库存接口 HTTP 验收（真实请求，不 mock）。M6 / F6-01~F6-05，形态见 D-049。
 * 用法：先启动服务，再执行 pnpm run test:http:fridge
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：未登录 401 → 没家庭 404 → 空冰箱（真 0，不是"还没做"）→ 记一样（含四区/数量/保质期）
 *       → **同名同区转成"改它"而不是再加一条**（409，人话）→ 改数量/位置/保质期
 *       → 改名撞名被拒（409）→ 保质期非法值被拒（400）→ 四区非法值被拒（400）
 *       → 概览数字与"今日先吃"（过期/今天/三天内；第 4 天不算）→ 没写保质期的不进提醒
 *       → 共享关掉后吃货只看自己放的 → 拿出来（删）→ 跨家庭看不到彼此的冰箱。
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
  const account = `fr${Date.now()}${seq}`.toLowerCase()
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

/** 加入某人的家庭（用邀请码） */
async function joinFamily(token, inviteCode) {
  return callWithRetry('POST', '/family/join', { token, body: { inviteCode } })
}

function dateKeyOf(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const flatten = (board) => (board?.zones ?? []).flatMap((group) => group.items)
const itemNamed = (board, name) => flatten(board).find((item) => item.name === name) ?? null

async function main() {
  await settleThrottleWindow()

  // ---------- 未登录 / 没家庭 ----------

  const anonymous = await callWithRetry('GET', '/fridge')
  check('未登录访问冰箱：401', anonymous.status === 401, `status=${anonymous.status}`)

  const noFamily = await newUser('冰箱验收无家')
  const withoutFamily = await callWithRetry('GET', '/fridge', { token: noFamily.token })
  check(
    '没加入家庭：404 并说明先去建家庭',
    withoutFamily.status === 404 && /家庭/.test(JSON.stringify(withoutFamily.body)),
    `status=${withoutFamily.status} body=${JSON.stringify(withoutFamily.body)?.slice(0, 80)}`,
  )

  // ---------- 空冰箱是真 0 ----------

  const mama = await newUser('冰箱验收妈')
  await newFamily(mama.token, '冰箱验收之家')

  const empty = await callWithRetry('GET', '/fridge', { token: mama.token })
  check(
    '空冰箱：四个区都在、数字是真 0（不是"还没做"）',
    empty.status === 200
      && (empty.body?.zones ?? []).length === 4
      && empty.body?.summary?.total === 0
      && empty.body?.summary?.attention === 0
      && (empty.body?.soon ?? []).length === 0,
    `zones=${(empty.body?.zones ?? []).length} total=${empty.body?.summary?.total}`,
  )
  check(
    '四个存放区的顺序固定为 常温/保鲜/冷藏/冷冻（3D 预览要按它摆位）',
    JSON.stringify((empty.body?.zones ?? []).map((group) => group.zone)) === JSON.stringify(['常温', '保鲜', '冷藏', '冷冻']),
    JSON.stringify((empty.body?.zones ?? []).map((group) => group.zone)),
  )

  // ---------- 记一样：数量/位置/保质期 ----------

  const added = await callWithRetry('POST', '/fridge', {
    token: mama.token,
    body: { name: '鸡蛋', amount: '一盒', zone: '冷藏', expiresOn: dateKeyOf(2), note: '给奶奶买的' },
  })
  const egg = itemNamed(added.body, '鸡蛋')
  check(
    '记一样食材：进到指定区、数量/保质期/备注都对',
    added.status === 201 && egg && egg.zone === '冷藏' && egg.amount === '一盒'
      && egg.expiresOn === dateKeyOf(2) && egg.note === '给奶奶买的',
    `status=${added.status} item=${JSON.stringify(egg)}`,
  )
  check(
    '保质期那句话由后端算好（三天内是「有 N 天/明天到期」）',
    egg?.expiryLabel === '还有 2 天' || egg?.expiryLabel === '明天到期',
    `expiryLabel=${egg?.expiryLabel}`,
  )
  check('放进冰箱的人显示昵称（不是 id）', egg?.addedBy === '冰箱验收妈', `addedBy=${egg?.addedBy}`)

  // 不填数量/保质期也能记（很多食材就是"有一点"）
  const bare = await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '小葱' } })
  const scallion = itemNamed(bare.body, '小葱')
  check(
    '不填数量与保质期也能记，且默认落在冷藏',
    bare.status === 201 && scallion && scallion.amount === null && scallion.expiresOn === null
      && scallion.zone === '冷藏' && scallion.attention === false,
    `item=${JSON.stringify(scallion)}`,
  )

  // ---------- 同名同区：转成"改它"，不是再加一条 ----------

  const duplicate = await callWithRetry('POST', '/fridge', {
    token: mama.token, body: { name: '鸡蛋', zone: '冷藏' },
  })
  check(
    '同名同区再记一次：409 并说"直接改它就行"（不悄悄叠加、也不建第二条）',
    duplicate.status === 409 && /直接改/.test(JSON.stringify(duplicate.body)),
    `status=${duplicate.status} body=${JSON.stringify(duplicate.body)?.slice(0, 100)}`,
  )
  // 但换个区就是另一样东西（常温的鸡蛋 vs 冷藏的鸡蛋是两回事吗？——按区去重，允许分开记）
  const otherZone = await callWithRetry('POST', '/fridge', {
    token: mama.token, body: { name: '鸡蛋', zone: '常温' },
  })
  check(
    '同一个名字放在**不同区**：允许（两处各有一条）',
    otherZone.status === 201 && flatten(otherZone.body).filter((item) => item.name === '鸡蛋').length === 2,
    `status=${otherZone.status} 鸡蛋条数=${flatten(otherZone.body).filter((item) => item.name === '鸡蛋').length}`,
  )
  // 收尾：把常温那条删掉，别影响后面的断言
  const warmEgg = flatten(otherZone.body).find((item) => item.name === '鸡蛋' && item.zone === '常温')
  await callWithRetry('DELETE', `/fridge/${warmEgg.id}`, { token: mama.token })

  // ---------- 校验：保质期与四区的非法值 ----------

  const badDate = await callWithRetry('POST', '/fridge', {
    token: mama.token, body: { name: '牛奶', expiresOn: '2026-02-31' },
  })
  check(
    '不存在的日期被拒（2 月 31 号不能悄悄滚成 3 月）',
    badDate.status === 400 && /这个日期不存在|保质期要写成/.test(JSON.stringify(badDate.body)),
    `status=${badDate.status} body=${JSON.stringify(badDate.body)?.slice(0, 90)}`,
  )
  const badFormat = await callWithRetry('POST', '/fridge', {
    token: mama.token, body: { name: '牛奶', expiresOn: '10/20' },
  })
  check(
    '非 YYYY-MM-DD 被拒（说清该怎么写）',
    badFormat.status === 400 && /保质期要写成/.test(JSON.stringify(badFormat.body)),
    `status=${badFormat.status}`,
  )
  const badZone = await callWithRetry('POST', '/fridge', {
    token: mama.token, body: { name: '牛奶', zone: '冷冻室' },
  })
  check(
    '非法存放区被拒（不能悄悄记成冷藏）',
    badZone.status === 400 && /存放区/.test(JSON.stringify(badZone.body)),
    `status=${badZone.status} body=${JSON.stringify(badZone.body)?.slice(0, 90)}`,
  )
  const noName = await callWithRetry('POST', '/fridge', { token: mama.token, body: { amount: '一盒' } })
  check('不写名字被拒', noName.status === 400, `status=${noName.status}`)

  // ---------- 改一条：数量/位置/保质期/名字 ----------

  const eggId = itemNamed(added.body, '鸡蛋').id
  const edited = await callWithRetry('PATCH', `/fridge/${eggId}`, {
    token: mama.token,
    body: { amount: '还剩半盒', zone: '保鲜', expiresOn: dateKeyOf(0) },
  })
  const editedEgg = flatten(edited.body).find((item) => item.id === eggId)
  check(
    '改数量/位置/保质期都生效（跨区跟着搬）',
    edited.status === 200 && editedEgg && editedEgg.amount === '还剩半盒'
      && editedEgg.zone === '保鲜' && editedEgg.expiresOn === dateKeyOf(0),
    `item=${JSON.stringify(editedEgg)}`,
  )
  check(
    '今天到期：state 进"今日先吃"，那句话是「今天到期」',
    editedEgg?.expiryLabel === '今天到期' && editedEgg?.attention === true,
    `label=${editedEgg?.expiryLabel} attention=${editedEgg?.attention}`,
  )

  // 清空数量：应该真的清掉（不是留个空字符串）
  const cleared = await callWithRetry('PATCH', `/fridge/${eggId}`, { token: mama.token, body: { amount: '' } })
  check(
    '把数量清空：真的变成 null（不是空字符串）',
    flatten(cleared.body).find((item) => item.id === eggId)?.amount === null,
    `amount=${JSON.stringify(flatten(cleared.body).find((item) => item.id === eggId)?.amount)}`,
  )

  // 改成与另一条同区同名：要被拒并给一句人话
  const clash = await callWithRetry('PATCH', `/fridge/${eggId}`, {
    token: mama.token, body: { name: '小葱', zone: '冷藏' },
  })
  check(
    '改成与另一条同区同名：409 并建议合成一条',
    clash.status === 409 && /合成一条/.test(JSON.stringify(clash.body)),
    `status=${clash.status} body=${JSON.stringify(clash.body)?.slice(0, 90)}`,
  )

  // ---------- 概览与「今日先吃」（F6-05） ----------

  // 造三样：已过期 / 三天后（该提醒）/ 十天后（不提醒）；再加一样没写保质期的
  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '过期酸奶', zone: '冷藏', expiresOn: dateKeyOf(-2) } })
  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '三天后到期的豆腐', zone: '冷藏', expiresOn: dateKeyOf(3) } })
  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '十天后到期的酱', zone: '常温', expiresOn: dateKeyOf(10) } })

  const board = await callWithRetry('GET', '/fridge', { token: mama.token })
  const expired = itemNamed(board.body, '过期酸奶')
  const soon3 = itemNamed(board.body, '三天后到期的豆腐')
  const far = itemNamed(board.body, '十天后到期的酱')

  check('已过期的：attention=true，话是「过期 N 天」', expired?.attention === true && /^过期 \d+ 天$/.test(expired?.expiryLabel ?? ''), `label=${expired?.expiryLabel}`)
  check('三天内的：attention=true', soon3?.attention === true, `label=${soon3?.expiryLabel}`)
  check('十天后的：attention=false（第四天起不提醒），但话仍明说', far?.attention === false && !!far?.expiryLabel, `label=${far?.expiryLabel}`)
  check(
    '概览：过期数与提醒数都是真数字',
    board.body?.summary?.expired === 1 && board.body?.summary?.attention >= 3,
    `expired=${board.body?.summary?.expired} attention=${board.body?.summary?.attention}`,
  )
  check(
    '没写保质期的（小葱）不进提醒',
    itemNamed(board.body, '小葱')?.attention === false && itemNamed(board.body, '小葱')?.expiryLabel === null,
    `item=${JSON.stringify(itemNamed(board.body, '小葱'))}`,
  )
  check(
    '「今日先吃」只含该提醒的，且**临期的排在最前**',
    (board.body?.soon ?? []).length === board.body?.summary?.attention
      && (board.body?.soon ?? []).every((item) => item.attention === true)
      && (board.body?.soon ?? [])[0]?.name === '过期酸奶',
    `soon=${(board.body?.soon ?? []).map((item) => `${item.name}(${item.expiryLabel})`).join(', ')}`,
  )
  check(
    '没写保质期的样数单独算（回答"为什么没提醒某些东西"）',
    board.body?.summary?.withExpiry === board.body?.summary?.total - 1,
    `withExpiry=${board.body?.summary?.withExpiry} total=${board.body?.summary?.total}`,
  )

  // ---------- 最近录入（F6-06） ----------

  /*
   * 刚记的那几样必须排在**最前**（时间倒序），而且"什么时候记的"那句话是真的。
   * 这一块的排序与上面那套（临期优先）**不是同一套**：混用会让人以为
   * "最近记的是那盒快过期的奶"。
   */
  /*
   * **先故意拉开时间戳**再断言倒序：连续几条记下去时 `createdAt` 可能落在同一毫秒，
   * 那时"倒序"与"不排序"给出的结果一样。
   *
   * ⚠️ 而且这一条**必须挑对地方放**，否则它验的不是倒序而是运气（R-45 那条教训的又一次）：
   * 反证时把服务端换成"不排序"，这条一开始**照样绿**——因为 MySQL 在没有 ORDER BY 时
   * 的返回顺序碰巧就是那几样的插入顺序（`[familyId, zone, name]` 索引给的顺序，
   * 而"保鲜"恰好排在前面）。于是"最后记的排第一"在**没排序**时也成立。
   *
   * 修法：把最后记的那一样放进**自然顺序会排在最后**的位置（`冷冻` + 名字靠后），
   * 这样"不排序"时它必然不在第一条——反证才会真的红（已实测）。
   */
  await sleep(1100)
  await callWithRetry('POST', '/fridge', { token: mama.token, body: { name: '最后记的柠檬', zone: '冷冻' } })
  const board2 = await callWithRetry('GET', '/fridge', { token: mama.token })
  const recent = board2.body?.recent ?? []
  check(
    '最近录入按**记的时间倒序**：最后记的那样必须排第一（时间戳拉开后才有意义）',
    recent.length >= 4 && recent[0]?.name === '最后记的柠檬',
    `前 5 条=${recent.slice(0, 5).map((item) => `${item.name}(${item.addedLabel})`).join(', ')}`,
  )
  check(
    '每条都带「什么时候记的」那句话（F6-06），而且刚记的算"刚刚"',
    recent.every((item) => typeof item.addedLabel === 'string' && item.addedLabel !== '')
      && recent[0]?.addedLabel === '刚刚',
    `addedLabel=${recent[0]?.addedLabel}`,
  )
  check(
    '每页最多 8 条（界面按 `recentTotal` 说"还有 N 样"）',
    recent.length <= 8 && board2.body?.recentTotal === board2.body?.summary?.total,
    `recent=${recent.length} recentTotal=${board2.body?.recentTotal} total=${board2.body?.summary?.total}`,
  )
  check(
    '最近录入带**谁记的**（F6-06 的意义就是"家里最近添了什么"，不看人就没意义）',
    recent.every((item) => typeof item.addedBy === 'string' && item.addedBy !== ''),
    `addedBy=${recent.slice(0, 3).map((item) => item.addedBy).join(', ')}`,
  )

  // ---------- 共享关掉：吃货只看自己放的 ----------

  const son = await newUser('冰箱验收娃')
  const joined = await joinFamily(son.token, (await callWithRetry('GET', '/family', { token: mama.token })).body.inviteCode)
  check('成员加入家庭成功', joined.status === 201 || joined.status === 200, `status=${joined.status}`)

  const sonAdd = await callWithRetry('POST', '/fridge', {
    token: son.token, body: { name: '汽水', zone: '冷藏', amount: '两瓶' },
  })
  check('家人都能往冰箱里记东西', sonAdd.status === 201, `status=${sonAdd.status}`)

  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  const sonView = await callWithRetry('GET', '/fridge', { token: son.token })
  const mamaView = await callWithRetry('GET', '/fridge', { token: mama.token })

  check(
    '共享关掉后：吃货只看到自己放的',
    sonView.body?.scope === 'mine' && flatten(sonView.body).every((item) => item.addedBy === '冰箱验收娃')
      && flatten(sonView.body).length === 1,
    `scope=${sonView.body?.scope} items=${flatten(sonView.body).map((item) => item.name).join(', ')}`,
  )
  check(
    '同一时刻掌勺人仍看全量（要负责做饭）',
    mamaView.body?.scope === 'family' && flatten(mamaView.body).length > 1,
    `scope=${mamaView.body?.scope} count=${flatten(mamaView.body).length}`,
  )
  // 收窄时吃货不能动别人放的
  const notMine = flatten(mamaView.body).find((item) => item.name === '小葱')
  const sonEditOther = await callWithRetry('PATCH', `/fridge/${notMine.id}`, {
    token: son.token, body: { amount: '偷改' },
  })
  check(
    '共享关掉后：吃货改不了别人放的',
    sonEditOther.status === 403,
    `status=${sonEditOther.status}`,
  )
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

  // ---------- 拿出来（删） ----------

  const sonItem = flatten((await callWithRetry('GET', '/fridge', { token: mama.token })).body).find((item) => item.name === '汽水')
  const removed = await callWithRetry('DELETE', `/fridge/${sonItem.id}`, { token: mama.token })
  check(
    '拿出来了：这条消失，其它仍在',
    removed.status === 200 && !flatten(removed.body).some((item) => item.name === '汽水') && flatten(removed.body).length > 0,
    `剩 ${flatten(removed.body).length} 样`,
  )

  // ---------- 跨家庭隔离 ----------

  const stranger = await newUser('冰箱验收邻居')
  await newFamily(stranger.token, '邻居家')
  const strangerBoard = await callWithRetry('GET', '/fridge', { token: stranger.token })
  check(
    '另一家的冰箱是空的（看不到别人的库存）',
    strangerBoard.body?.summary?.total === 0,
    `邻居家 total=${strangerBoard.body?.summary?.total}`,
  )
  const strangerEdit = await callWithRetry('PATCH', `/fridge/${eggId}`, { token: stranger.token, body: { amount: '改别人家的' } })
  check(
    '改别人家的食材：404（不泄露它存在与否之外的信息）',
    strangerEdit.status === 404,
    `status=${strangerEdit.status}`,
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
