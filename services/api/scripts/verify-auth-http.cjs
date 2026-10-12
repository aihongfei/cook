#!/usr/bin/env node
/**
 * 注册登录接口 HTTP 验收（真实请求，不 mock）。
 * 用法：先启动服务，再执行 pnpm run test:http:auth
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
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
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 登录接口有 8 次/分钟的防爆破限流（R-07），计数按 IP 存在服务内存里。
 * 因此**连续两次跑本脚本**时，上一轮的计数还没过期，功能用例会被自己的限流误伤成 429。
 * 先探一次：若已限流，就等窗口过期再跑，让每次运行的起点都是干净的。
 */
async function settleThrottleWindow(probe) {
  for (let round = 0; round < 3; round += 1) {
    const attempt = await probe()
    if (attempt.status !== 429) return
    const waitMs = (Number(attempt.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 上一轮限流窗口未过期，等待 ${Math.round(waitMs / 1000)}s 后重跑…\n`)
    await sleep(waitMs)
  }
  throw new Error('登录限流窗口一直未恢复，无法开始验收（服务是否异常？）')
}

async function main() {
  const account = `验收账号${Date.now()}`.toLowerCase().replace(/[^\w.@-]/g, '') || `check${Date.now()}`
  const password = 'cook2026pass'

  await settleThrottleWindow(() => call('POST', '/auth/login', { body: { account: 'throttle-probe', password: 'probe-not-valid' } }))

  // 1. 注册（带上选好的头像，注册页一次提交就完成）
  const registered = await call('POST', '/auth/register', { body: { account, password, nickname: '验收员', avatar: '🍳' } })
  check(
    '注册 201 且返回 token/refreshToken/user',
    registered.status === 201 && Boolean(registered.body?.token) && Boolean(registered.body?.refreshToken) && registered.body?.user?.account === account,
    `${registered.status} user=${registered.body?.user?.account}`,
  )
  check('注册时选的头像被保存', registered.body?.user?.avatar === '🍳', `avatar=${registered.body?.user?.avatar}`)
  check('注册响应里绝不能出现密码或哈希', !JSON.stringify(registered.body ?? {}).includes(password) && !JSON.stringify(registered.body ?? {}).includes('scrypt$'), '检查响应体')

  // 2. 重复注册要冲突
  const duplicated = await call('POST', '/auth/register', { body: { account, password } })
  check('重复注册 409', duplicated.status === 409, `${duplicated.status} ${duplicated.body?.message ?? ''}`)

  // 3. 弱密码与非法账号被拒
  const weak = await call('POST', '/auth/register', { body: { account: `weak${Date.now()}`, password: '12345678' } })
  check('纯数字弱密码 409', weak.status === 409, `${weak.status} ${weak.body?.message ?? ''}`)
  const badAccount = await call('POST', '/auth/register', { body: { account: '妈妈', password } })
  check('中文账号 409', badAccount.status === 409, `${badAccount.status}`)

  // 4. 登录（大小写与空格归一）
  const login = await call('POST', '/auth/login', { body: { account: `  ${account.toUpperCase()}  `, password } })
  check('登录 200（账号大小写/空格已归一）', login.status === 200 && Boolean(login.body?.token), `${login.status} ${login.body?.message ?? ''}`)

  // 5. 密码错误与账号不存在返回同一句话（不泄漏账号是否存在）
  const wrongPassword = await call('POST', '/auth/login', { body: { account, password: 'cook2026wrong' } })
  const noSuchUser = await call('POST', '/auth/login', { body: { account: `nobody${Date.now()}`, password } })
  check(
    '密码错误与账号不存在：都 401 且文案一致',
    wrongPassword.status === 401 && noSuchUser.status === 401 && wrongPassword.body?.message === noSuchUser.body?.message,
    `${wrongPassword.status}/${wrongPassword.body?.message} vs ${noSuchUser.status}/${noSuchUser.body?.message}`,
  )

  // 6. 未登录访问受保护接口
  const anonymous = await call('GET', '/auth/me')
  check('未带 token 访问 /auth/me → 401', anonymous.status === 401, `${anonymous.status}`)
  const badToken = await call('GET', '/auth/me', { token: 'not-a-real-token' })
  check('伪造 token → 401', badToken.status === 401, `${badToken.status}`)

  // 7. 带 token 取当前账号
  const token = login.body?.token
  const me = await call('GET', '/auth/me', { token })
  check('带 token 访问 /auth/me → 200 且账号一致', me.status === 200 && me.body?.account === account, `${me.status} ${me.body?.account}`)

  // 8. 改资料
  const updated = await call('PATCH', '/auth/me', { token, body: { nickname: '掌勺人', avatar: '🍳' } })
  check('改昵称/头像 200', updated.status === 200 && updated.body?.nickname === '掌勺人' && updated.body?.avatar === '🍳', `${updated.status} ${updated.body?.nickname}/${updated.body?.avatar}`)
  const badAvatar = await call('PATCH', '/auth/me', { token, body: { avatar: '💀' } })
  check('白名单外头像 409', badAvatar.status === 409, `${badAvatar.status}`)

  // 9. 刷新即轮换：旧刷新令牌只能成功用一次
  const refreshToken = login.body?.refreshToken
  const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken } })
  check('刷新 200 且换到新的一对令牌', refreshed.status === 200 && Boolean(refreshed.body?.token) && refreshed.body?.refreshToken !== refreshToken, `${refreshed.status}`)
  const reused = await call('POST', '/auth/refresh', { body: { refreshToken } })
  check('旧刷新令牌复用 → 401（已轮换吊销）', reused.status === 401, `${reused.status}`)

  // 10. 退出登录后刷新令牌失效
  const freshToken = refreshed.body?.token
  const freshRefresh = refreshed.body?.refreshToken
  const loggedOut = await call('POST', '/auth/logout', { token: freshToken, body: { refreshToken: freshRefresh } })
  check('退出登录 200 且吊销 1 个会话', loggedOut.status === 200 && loggedOut.body?.revoked === 1, `${loggedOut.status} revoked=${loggedOut.body?.revoked}`)
  const afterLogout = await call('POST', '/auth/refresh', { body: { refreshToken: freshRefresh } })
  check('退出后该刷新令牌 → 401', afterLogout.status === 401, `${afterLogout.status}`)
  const meAfterLogout = await call('GET', '/auth/me', { token: freshToken })
  check('退出后 access token 仍可用直到过期（JWT 无状态，属预期）', meAfterLogout.status === 200, `${meAfterLogout.status}`)

  // 11. 登录限流（R-07 防爆破）：连续错密码触发 429
  // 起点已在上面的 settle 里确认是干净窗口，因此这里出现的 429 只能是本轮连续错误触发的；
  // 同时要求 429 之前确实是一串 401（而不是一上来就被拦），否则限流可能早已生效、结论不可信。
  let throttled = false
  let unauthorizedBefore = 0
  for (let i = 0; i < 12; i += 1) {
    const attempt = await call('POST', '/auth/login', { body: { account, password: 'cook2026wrong' } })
    if (attempt.status === 429) {
      throttled = true
      break
    }
    if (attempt.status === 401) unauthorizedBefore += 1
  }
  check(
    '连续错误登录触发 429 限流',
    throttled && unauthorizedBefore > 0,
    `触发前 401 次数=${unauthorizedBefore}`,
  )

  // 12. 注册口径接口
  const options = await call('GET', '/auth/options')
  check('注册口径 200 且含头像白名单', options.status === 200 && Array.isArray(options.body?.avatars) && options.body.avatars.length > 0, `${options.status} avatars=${options.body?.avatars?.length}`)

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
