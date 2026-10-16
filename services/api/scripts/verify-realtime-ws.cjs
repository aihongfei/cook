#!/usr/bin/env node
/**
 * 实时通道的验收（F10-08 / D-099）。真实请求 + 真实 WebSocket，不 mock。
 *
 * 用法：先启动服务，再执行 `node services/api/scripts/verify-realtime-ws.cjs`
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 自带全部前置数据（自己注册、建家庭），不依赖别的验收留下的东西。
 *
 * ## 这份脚本必须验到的东西（每一条都对应这次改动的一个结论）
 *
 * ① **两台设备真的"立马"收到**：一个连接、另一个账号做事 → 那条连接在
 *    **毫秒级**收到信号（这是用户的原话："另一台同家庭的设备要立马收到"）；
 * ② **不做这件事的人不该收到**（扇出排掉 actor，与通知那条同一条口径）；
 * ③ **家里以外的人收不到**（另一个家庭完全不受影响——家庭隔离是这套东西的底线）；
 * ④ **不是自己造的事也会推**：菜单"选好了"与"做好了"走的是**状态型**那条
 *    （不写事件型提醒），它们仍然要推——漏了这一步，这两件事在"两台都开着"时
 *    反而最慢；
 * ⑤ **巡查令牌那条路也能连**（原生服务用它，它不能拿登录令牌：2 小时就过期）；
 * ⑥ **退出登录（吊销令牌）之后**：那条连接不该还能用（重连会被拒）；
 * ⑦ **伪造/过期的凭据连不上**（401），**没有凭据也连不上**；
 * ⑧ **推送的内容是"信号"而不是提醒正文**（`{type:'changed', area}`）——
 *    正文由客户端自己重取，这样"谁能看什么"只有服务端一处判断。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'
const wsBase = base.replace(/^http/, 'ws')

let failed = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function call(method, path, { body, token, patrol } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (patrol) headers['x-patrol-token'] = patrol
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

/** 限流（60 次/分）：等响应头说的秒数再重试（这个脚本自己就会撞上，见 R-089 第三节） */
async function callWithRetry(method, path, options = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await call(method, path, options)
    if (result.status !== 429) return result
    const wait = Math.min(Number(result.retryAfter ?? 5) + 1, 70)
    console.log(`  ⏳ 触发限流，等 ${wait}s…`)
    await sleep(wait * 1000)
  }
  throw new Error(`${method} ${path} 连续被限流`)
}

const PASS = 'cook-dev-1234'

async function register(acc, nickname) {
  const result = await callWithRetry('POST', '/auth/register', {
    body: { account: acc, password: PASS, nickname },
  })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`注册 ${acc} 失败：${result.status} ${JSON.stringify(result.body)}`)
  }
  return { token: result.body.token, user: result.body.user }
}

/**
 * 开一条实时连接，把**收到的每一条**都记进 `received`，并记下到达时刻。
 *
 * 用 Node 内置的 `WebSocket`（Node 22+ 全局有）；它和服务端用的是同一条协议，
 * 与浏览器/Android 客户端没有差别——所以这里验到的东西对那两端同样成立。
 */
function connect(url) {
  const socket = new WebSocket(`${wsBase}${url}`)
  const received = []
  const opened = new Promise((resolve, reject) => {
    socket.onopen = () => resolve('open')
    socket.onerror = () => {}
    socket.onclose = (event) => {
      // 握手失败（401/403）会以 close 的形式到达；用 code 判断
      reject(new Error(`closed ${event.code}`))
    }
    setTimeout(() => reject(new Error('connect timeout')), 5000)
  })
  socket.onmessage = (event) => {
    try {
      received.push({ at: Date.now(), payload: JSON.parse(String(event.data)) })
    } catch {
      received.push({ at: Date.now(), payload: null })
    }
  }
  return { socket, received, opened }
}

/** 等一条消息到达（最多等 `timeoutMs`）；返回它，或 null */
async function waitFor(received, from, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = received.find((entry) => entry.at > from)
    if (hit) return hit
    await sleep(25)
  }
  return null
}

async function main() {
  const stamp = Date.now().toString(36)

  // ---------- 前置：两个家庭，各两个人 ----------
  const chef = await register(`rt_chef_${stamp}`, '掌勺人')
  const mate = await register(`rt_mate_${stamp}`, '家里人')
  const outsider = await register(`rt_out_${stamp}`, '外人')
  const otherFamily = await register(`rt_of_${stamp}`, '别家的人')

  const created = await callWithRetry('POST', '/family', { token: chef.token, body: { name: `实时验收家${stamp}` } })
  check('前置：建家', created.status === 201 || created.status === 200, `${created.status}`)
  const invite = created.body?.inviteCode
  const joined = await callWithRetry('POST', '/family/join', { token: mate.token, body: { inviteCode: invite } })
  check('前置：家里人加入', joined.status === 201 || joined.status === 200, `${joined.status}`)
  await callWithRetry('POST', '/family/create', { token: outsider.token, body: { name: `外人家${stamp}` } })
  await callWithRetry('POST', '/family/create', { token: otherFamily.token, body: { name: `别家${stamp}` } })

  // ---------- ① 两台设备：一个连接，另一个账号做事 ----------
  const device = connect(`/realtime?t=${encodeURIComponent(mate.token)}`)
  const opened = await device.opened.then(() => true).catch(() => false)
  check('①实时：拿登录令牌能连上（应用前台那条路）', opened, opened ? '' : '握手失败')

  // 让连接稳定下来（避免把连接过程中的任何杂音算成推送）
  await sleep(200)

  const beforeAdd = Date.now()
  const dish = await callWithRetry('GET', '/recipes?pageSize=1', {})
  const dishId = dish.body?.items?.[0]?.id
  await callWithRetry('POST', '/orders/items', {
    token: chef.token,
    body: { recipeId: dishId, mealDate: new Date().toISOString().slice(0, 10), meal: 'DINNER' },
  })
  const addSignal = await waitFor(device.received, beforeAdd)
  check('①实时：另一台**当场**收到"订单有变化"', Boolean(addSignal), addSignal ? `${addSignal.at - beforeAdd}ms` : '4 秒内没到')
  check('①实时：信号里只带 area，不带提醒正文（谁能看什么只有服务端一处判断）',
    addSignal?.payload?.type === 'changed' && addSignal?.payload?.area === 'order'
      && Object.keys(addSignal.payload).length === 2,
    JSON.stringify(addSignal?.payload))

  // 打卡：用户原话里的那一条（"我这边上传了打卡，另一台要立马收到"）
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const beforePhoto = Date.now()
  await callWithRetry('POST', '/checkins', {
    token: chef.token,
    body: { image: `data:image/png;base64,${png}`, contentType: 'image/png', note: '实时验收' },
  })
  const photoSignal = await waitFor(device.received, beforePhoto)
  check('①实时：**打卡上传**当场推（用户 2026-10-16 原话里的那一条）',
    photoSignal?.payload?.area === 'family', JSON.stringify(photoSignal?.payload ?? null))

  // ---------- ② 做事的人自己不该收到 ----------
  const actorDevice = connect(`/realtime?t=${encodeURIComponent(chef.token)}`)
  await actorDevice.opened.catch(() => {})
  await sleep(200)
  const beforeActor = Date.now()
  await callWithRetry('POST', '/fridge', { token: chef.token, body: { name: `实时验收牛奶${stamp}`, zone: '冷藏' } })
  const actorGot = await waitFor(actorDevice.received, beforeActor, 1200)
  const mateGot = await waitFor(device.received, beforeActor, 1200)
  check('②扇出：做事的人自己**不收到**（与通知那条"不提醒自己"同一条口径）', actorGot === null, actorGot ? JSON.stringify(actorGot.payload) : '')
  check('②扇出：家里**其他人**收得到', Boolean(mateGot), mateGot ? JSON.stringify(mateGot.payload) : '')
  actorDevice.socket.close()

  // ---------- ③ 家庭隔离 ----------
  const outsiderDevice = connect(`/realtime?t=${encodeURIComponent(outsider.token)}`)
  await outsiderDevice.opened.catch(() => {})
  await sleep(200)
  const beforeOutsider = Date.now()
  await callWithRetry('POST', '/checkins', {
    token: chef.token,
    body: { image: `data:image/png;base64,${png}`, contentType: 'image/png', note: '不该外流' },
  })
  const outsiderGot = await waitFor(outsiderDevice.received, beforeOutsider, 1200)
  check('③家庭隔离：别家的人**一条都收不到**', outsiderGot === null, outsiderGot ? JSON.stringify(outsiderGot.payload) : '')
  outsiderDevice.socket.close()

  // ---------- ④ 状态型那两档也要推 ----------
  const today = new Date().toISOString().slice(0, 10)
  const mealKey = `${today}-DINNER`
  const beforePlan = Date.now()
  const planned = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: chef.token, body: { status: 'PLANNED' } })
  check('前置：菜单"选好了"', planned.status === 200, `${planned.status}`)
  const planSignal = await waitFor(device.received, beforePlan)
  check('④状态型：菜单"选好了"当场推（它不写事件型提醒，但必须推）',
    planSignal?.payload?.type === 'changed', JSON.stringify(planSignal?.payload ?? null))

  const beforeDone = Date.now()
  const done = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: chef.token, body: { status: 'DONE' } })
  check('前置：标「做好了」', done.status === 200, `${done.status}`)
  const doneSignal = await waitFor(device.received, beforeDone)
  check('④状态型：饭"做好了"当场推', doneSignal?.payload?.type === 'changed', JSON.stringify(doneSignal?.payload ?? null))

  // ---------- ⑤ 巡查令牌那条路（原生服务用的就是它） ----------
  const issued = await callWithRetry('POST', '/notifications/patrol/token', {
    token: mate.token,
    body: { deviceId: `rt-device-${stamp}` },
  })
  check('前置：领巡查令牌', issued.status === 201 || issued.status === 200, `${issued.status}`)
  const patrolToken = issued.body?.token
  const native = connect(`/realtime?p=${encodeURIComponent(patrolToken)}`)
  const nativeOpened = await native.opened.then(() => true).catch(() => false)
  check('⑤原生那条路：巡查令牌也能连（它不能拿登录令牌：2 小时就过期）', nativeOpened, nativeOpened ? '' : '握手失败')

  await sleep(200)
  const beforeNative = Date.now()
  await callWithRetry('POST', '/fridge', { token: chef.token, body: { name: `原生路验收${stamp}`, zone: '冷藏' } })
  const nativeGot = await waitFor(native.received, beforeNative)
  check('⑤原生那条路：同样收得到（手机在后台时由它接）', Boolean(nativeGot), nativeGot ? `${nativeGot.at - beforeNative}ms` : '4 秒内没到')
  native.socket.close()

  // ---------- ⑥ 吊销之后连不上 ----------
  const revoked = await callWithRetry('DELETE', `/notifications/patrol/token?deviceId=rt-device-${stamp}`, { token: mate.token })
  check('前置：吊销那枚巡查令牌', revoked.status === 200, `${revoked.status}`)
  const afterRevoke = connect(`/realtime?p=${encodeURIComponent(patrolToken)}`)
  const revokedOpened = await afterRevoke.opened.then(() => true).catch(() => false)
  check('⑥吊销之后：**连不上**（退出登录 = 这台手机收不到家里的动静）', revokedOpened === false, revokedOpened ? '竟然连上了' : '已拒绝')
  afterRevoke.socket.close()

  // ---------- ⑦ 没有凭据 / 伪造凭据 ----------
  const anon = connect('/realtime')
  const anonOpened = await anon.opened.then(() => true).catch(() => false)
  check('⑦没有凭据：连不上', anonOpened === false, anonOpened ? '竟然连上了' : '已拒绝')
  anon.socket.close()

  const fake = connect('/realtime?t=not-a-real-token')
  const fakeOpened = await fake.opened.then(() => true).catch(() => false)
  check('⑦伪造的登录令牌：连不上', fakeOpened === false, fakeOpened ? '竟然连上了' : '已拒绝')
  fake.socket.close()

  const fakePatrol = connect('/realtime?p=nope')
  const fakePatrolOpened = await fakePatrol.opened.then(() => true).catch(() => false)
  check('⑦伪造的巡查令牌：连不上', fakePatrolOpened === false, fakePatrolOpened ? '竟然连上了' : '已拒绝')
  fakePatrol.socket.close()

  // ---------- ⑧ 断开之后不该再有消息 ----------
  device.socket.close()
  await sleep(150)
  const afterClose = Date.now()
  await callWithRetry('POST', '/fridge', { token: chef.token, body: { name: `断开后${stamp}`, zone: '冷藏' } })
  const nothing = await waitFor(device.received, afterClose, 1200)
  check('⑧关掉之后：不再收（这台设备真的下线了，没有僵尸连接）', nothing === null, nothing ? '竟然还收到' : '')

  // ---------- 汇总 ----------
  const pass = results.filter((r) => r.ok).length
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}  ${r.detail}`)
  console.log(`\n实时通道验收：${pass}/${results.length} 通过`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('验收跑挂了：', error)
  process.exitCode = 1
})
