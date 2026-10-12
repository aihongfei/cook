#!/usr/bin/env node
/**
 * 家庭与成员 / 找回密码 接口 HTTP 验收（真实请求，不 mock）。F2-04~F2-07、F2-09。
 * 用法：先启动服务，再执行 pnpm run test:http:family
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
  return { status: response.status, body: parsed }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 限流窗口自愈（与 verify-auth-http.cjs 同一套做法）：
 * 加入家庭 10 次/分、忘记密码 5 次/分、登录 8 次/分都按 IP 计数且存在服务内存里，
 * 连着跑两遍本脚本时，上一轮的窗口还没过期，功能用例会被自己的限流误伤成 429。
 */
async function settleThrottleWindow(probes) {
  for (let round = 0; round < 3; round += 1) {
    const attempt = await probes()
    if (attempt.status !== 429) return
    const waitMs = (Number(attempt.retryAfter) || 60) * 1000 + 1000
    console.log(`⏳ 上一轮限流窗口未过期，等待 ${Math.round(waitMs / 1000)}s 后重跑…\n`)
    await sleep(waitMs)
  }
  throw new Error('限流窗口一直未恢复，无法开始验收（服务是否异常？）')
}

/** 每个用例用自己的账号，避免互相影响（家庭成员有唯一约束） */
let seq = 0
async function newUser(nickname) {
  seq += 1
  const account = `fam${Date.now()}${seq}`.toLowerCase()
  const password = 'cook2026pass'
  const registered = await call('POST', '/auth/register', { body: { account, password, nickname: nickname ?? account } })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, password, token: registered.body.token, refreshToken: registered.body.refreshToken, user: registered.body.user }
}

/**
 * 加入家庭限流 10 次/分（防猜码，F2-06）。本脚本一轮就要用掉 7 次左右，
 * 于是**连着跑两遍时第二遍必然被自己的限流挡住**。这里遇到 429 就等窗口过去重试一次，
 * 并把等待原因打印出来——不是把限流关掉，而是让验收脚本本身可重复运行。
 */
async function joinFamily(token, inviteCode) {
  const first = await call('POST', '/family/join', { token, body: { inviteCode } })
  if (first.status !== 429) return first
  const waitMs = (Number(first.retryAfter) || 60) * 1000 + 1000
  console.log(`⏳ 加入家庭已触发限流（10 次/分），等待 ${Math.round(waitMs / 1000)}s 后重试…\n`)
  await sleep(waitMs)
  return call('POST', '/family/join', { token, body: { inviteCode } })
}

async function main() {
  await settleThrottleWindow(() => call('POST', '/auth/login', { body: { account: 'throttle-probe', password: 'probe-not-valid' } }))

  // ---------- 口径接口 ----------
  const options = await call('GET', '/family/options')
  const roles = options.body?.roles ?? []
  check(
    '口径接口下发 3 个角色与各自能力（前端不硬编码权限）',
    options.status === 200 && roles.length === 3 && roles.every(r => Array.isArray(r.capabilities) && r.capabilities.length > 0),
    `${options.status} roles=${roles.map(r => r.value).join('/')}`,
  )
  const ownerRole = roles.find(r => r.value === 'OWNER')
  const eaterRole = roles.find(r => r.value === 'EATER')
  check(
    '掌勺人能力多于吃货（纯角色制：能力由角色决定）',
    (ownerRole?.capabilities?.length ?? 0) > (eaterRole?.capabilities?.length ?? 0),
    `OWNER=${ownerRole?.capabilities?.length} EATER=${eaterRole?.capabilities?.length}`,
  )

  // ---------- 未加入家庭 ----------
  const mama = await newUser('妈妈')
  const anonymous = await call('GET', '/family')
  check('未带 token 访问家庭接口 → 401', anonymous.status === 401, `${anonymous.status}`)

  const empty = await call('GET', '/family', { token: mama.token })
  check('还没加入家庭时返回 null（前端据此显示创建/加入）', empty.status === 200 && empty.body === null, `${empty.status} body=${JSON.stringify(empty.body)}`)

  const earlyLeave = await call('POST', '/family/leave', { token: mama.token })
  check('不在家庭里就退出 → 404', earlyLeave.status === 404, `${earlyLeave.status}`)

  // ---------- 创建家庭 ----------
  const created = await call('POST', '/family', { token: mama.token, body: { name: '小满一家' } })
  check(
    '创建家庭 201：创建者即掌勺人，默认带邀请码与共享开关',
    created.status === 201
      && created.body?.name === '小满一家'
      && created.body?.myRole === 'OWNER'
      && /^[A-Z2-9]{6}$/.test(created.body?.inviteCode ?? '')
      && created.body?.shared === true,
    `${created.status} role=${created.body?.myRole} code=${created.body?.inviteCode}`,
  )
  check('创建者出现在成员列表里，且被标记为"我"', created.body?.members?.length === 1 && created.body?.members?.[0]?.isMe === true, `members=${created.body?.members?.length}`)
  check('创建响应不含密码哈希', !JSON.stringify(created.body ?? {}).includes('scrypt$'), '检查响应体')

  const inviteCode = created.body?.inviteCode

  const twice = await call('POST', '/family', { token: mama.token, body: { name: '重开一家' } })
  check('已有家庭的人再创建 → 409（一个账号只属于一个家庭）', twice.status === 409, `${twice.status} ${twice.body?.message ?? ''}`)

  // ---------- 加入家庭 ----------
  const son = await newUser('小满')
  const wrongCode = await joinFamily(son.token, 'ZZZZZZ')
  check('邀请码不存在 → 404 且提示可读', wrongCode.status === 404 && typeof wrongCode.body?.message === 'string', `${wrongCode.status} ${wrongCode.body?.message ?? ''}`)

  // 小写 + 空格输入也要能进（口头/手抄场景）
  const joined = await joinFamily(son.token, ` ${inviteCode.toLowerCase()} `)
  check(
    '凭邀请码加入 200：新成员默认是吃货，能看到已有成员',
    joined.status === 200 && joined.body?.myRole === 'EATER' && joined.body?.members?.length === 2,
    `${joined.status} role=${joined.body?.myRole} members=${joined.body?.members?.length}`,
  )
  check(
    '成员列表按角色排序（掌勺人在前）',
    joined.body?.members?.[0]?.role === 'OWNER' && joined.body?.members?.[1]?.role === 'EATER',
    JSON.stringify((joined.body?.members ?? []).map(m => m.role)),
  )
  check('吃货的能力表里没有管成员/改家庭', !(joined.body?.myCapabilities ?? []).includes('member.manage') && !(joined.body?.myCapabilities ?? []).includes('family.edit'), JSON.stringify(joined.body?.myCapabilities))

  const joinAgain = await call('POST', '/family/join', { token: son.token, body: { inviteCode } })
  check('已在家庭里的人再加入 → 409', joinAgain.status === 409, `${joinAgain.status}`)

  // ---------- 权限（F2-09：能力在后端强制校验，不只是前端藏按钮） ----------
  const sonRename = await call('PATCH', '/family', { token: son.token, body: { name: '我改的' } })
  check('吃货改家庭名 → 403（后端强制，不只是前端隐藏）', sonRename.status === 403, `${sonRename.status} ${sonRename.body?.message ?? ''}`)
  const sonResetCode = await call('POST', '/family/invite/reset', { token: son.token })
  check('吃货重置邀请码 → 403', sonResetCode.status === 403, `${sonResetCode.status}`)
  const sonPromote = await call('PATCH', `/family/members/${son.user.id}`, { token: son.token, body: { role: 'OWNER' } })
  check('吃货给自己升权 → 403', sonPromote.status === 403, `${sonPromote.status}`)

  // ---------- 掌勺人的管理操作 ----------
  const renamed = await call('PATCH', '/family', { token: mama.token, body: { name: '小满的家', shared: false } })
  check('掌勺人改家庭名与共享开关 200', renamed.status === 200 && renamed.body?.name === '小满的家' && renamed.body?.shared === false, `${renamed.status} ${renamed.body?.name} shared=${renamed.body?.shared}`)

  const badRole = await call('PATCH', `/family/members/${son.user.id}`, { token: mama.token, body: { role: 'ADMIN' } })
  check('非法角色 → 400', badRole.status === 400, `${badRole.status}`)

  const promoted = await call('PATCH', `/family/members/${son.user.id}`, { token: mama.token, body: { role: 'COOK' } })
  check('把成员升为帮厨 200', promoted.status === 200 && promoted.body?.members?.find(m => m.userId === son.user.id)?.role === 'COOK', `${promoted.status}`)

  // 转让：掌勺人只有一个，把自己转给别人后原掌勺人降为帮厨
  const transferred = await call('PATCH', `/family/members/${son.user.id}`, { token: mama.token, body: { role: 'OWNER' } })
  const rolesAfterTransfer = (transferred.body?.members ?? []).map(m => `${m.nickname}:${m.role}`).sort()
  check(
    '转让掌勺人：新人上位，原掌勺人自动降为帮厨（唯一掌勺人）',
    transferred.status === 200
      && (transferred.body?.members ?? []).filter(m => m.role === 'OWNER').length === 1
      && (transferred.body?.members ?? []).find(m => m.userId === mama.user.id)?.role === 'COOK',
    JSON.stringify(rolesAfterTransfer),
  )

  // 身份互换后，原先的吃货现在能重置邀请码了（能力随角色实时生效，不是登录时快照）
  const sonReset = await call('POST', '/family/invite/reset', { token: son.token })
  check(
    '能力随角色实时生效：新掌勺人可重置邀请码，且新码与旧码不同',
    sonReset.status === 200 && /^[A-Z2-9]{6}$/.test(sonReset.body?.inviteCode ?? '') && sonReset.body?.inviteCode !== inviteCode,
    `${sonReset.status} 新码=${sonReset.body?.inviteCode}`,
  )
  const oldCodeDead = await newUser('路人')
  const oldCodeJoin = await joinFamily(oldCodeDead.token, inviteCode)
  check('重置后旧邀请码立即失效', oldCodeJoin.status === 404, `${oldCodeJoin.status}`)

  const newCode = sonReset.body?.inviteCode
  const grandma = await newUser('奶奶')
  const joinedByNew = await joinFamily(grandma.token, newCode)
  check('新邀请码可用', joinedByNew.status === 200 && joinedByNew.body?.members?.length === 3, `${joinedByNew.status} members=${joinedByNew.body?.members?.length}`)

  // ---------- 移出成员、退出、解散 ----------
  const removeSelf = await call('DELETE', `/family/members/${son.user.id}`, { token: son.token })
  check('掌勺人移出自己 → 400（提示改用退出家庭）', removeSelf.status === 400, `${removeSelf.status} ${removeSelf.body?.message ?? ''}`)

  const removed = await call('DELETE', `/family/members/${grandma.user.id}`, { token: son.token })
  check('掌勺人移出成员 200，成员数回落', removed.status === 200 && removed.body?.members?.length === 2, `${removed.status} members=${removed.body?.members?.length}`)

  const kickedOut = await call('GET', '/family', { token: grandma.token })
  check('被移出的人看到自己已不在家庭', kickedOut.status === 200 && kickedOut.body === null, `${kickedOut.status} body=${JSON.stringify(kickedOut.body)}`)

  const ownerLeave = await call('POST', '/family/leave', { token: son.token })
  check('掌勺人家里还有人时退出 → 409（要先把掌勺人转让出去）', ownerLeave.status === 409, `${ownerLeave.status} ${ownerLeave.body?.message ?? ''}`)

  const memberLeave = await call('POST', '/family/leave', { token: mama.token })
  check('普通成员退出 200 且不是解散', memberLeave.status === 200 && memberLeave.body?.left === true && memberLeave.body?.disbanded === false, `${memberLeave.status} ${JSON.stringify(memberLeave.body)}`)

  const afterLeave = await call('GET', '/family', { token: mama.token })
  check('退出后回到"没有家庭"状态', afterLeave.status === 200 && afterLeave.body === null, `${afterLeave.status}`)

  // 退出后还能用同一个邀请码回来（邀请码长期有效）。这里**必须用新账号**：
  // 若让 mama 直接重新加入，紧接着的"解散家庭"就会因为家里又有了第二个人而无法成立。
  const returning = await newUser('回来的妈妈')
  const rejoined = await joinFamily(returning.token, newCode)
  check('退出后还能用同一个邀请码重新加入（邀请码长期有效）', rejoined.status === 200, `${rejoined.status}`)
  const returningLeave = await call('POST', '/family/leave', { token: returning.token })
  check('新加入的成员可以自己退出', returningLeave.status === 200 && returningLeave.body?.disbanded === false, `${returningLeave.status}`)

  const sonLeave = await call('POST', '/family/leave', { token: son.token })
  check('只剩掌勺人自己时退出 = 解散家庭', sonLeave.status === 200 && sonLeave.body?.disbanded === true, `${sonLeave.status} ${JSON.stringify(sonLeave.body)}`)

  const afterDisband = await call('GET', '/family', { token: mama.token })
  check('解散后成员的家庭关系一并清除（级联）', afterDisband.status === 200 && afterDisband.body === null, `${afterDisband.status} body=${JSON.stringify(afterDisband.body)}`)

  // ---------- 找回密码（F2-04） ----------
  const emailUser = await newUser('要找回密码的人')
  const boundEmail = `findme${Date.now()}@example.com`
  const bound = await call('PATCH', '/auth/me', { token: emailUser.token, body: { email: boundEmail } })
  check('资料接口能绑定邮箱（小写归一）', bound.status === 200 && bound.body?.email === boundEmail.toLowerCase(), `${bound.status} ${bound.body?.email}`)
  check('绑定邮箱的响应里不含密码哈希', !JSON.stringify(bound.body ?? {}).includes('scrypt$'), '检查响应体')

  const badEmail = await call('PATCH', '/auth/me', { token: emailUser.token, body: { email: '不是邮箱' } })
  check('非法邮箱格式 → 409', badEmail.status === 409, `${badEmail.status} ${badEmail.body?.message ?? ''}`)

  const takenEmail = await call('PATCH', '/auth/me', { token: mama.token, body: { email: boundEmail } })
  check('邮箱已被别的账号绑定 → 409', takenEmail.status === 409, `${takenEmail.status} ${takenEmail.body?.message ?? ''}`)

  const forgot = await call('POST', '/auth/password/forgot', { body: { email: boundEmail } })
  const resetUrl = forgot.body?.devResetUrl
  check(
    '申请找回密码 200（开发期 console 邮件直接把重置链接回给调用方）',
    forgot.status === 200 && forgot.body?.sent === true && typeof resetUrl === 'string' && resetUrl.includes('/reset-password?token='),
    `${forgot.status} sent=${forgot.body?.sent}`,
  )
  const noSuchEmail = await call('POST', '/auth/password/forgot', { body: { email: `nobody${Date.now()}@example.com` } })
  check(
    '没绑过该邮箱也返回同样的 200（不泄漏邮箱是否注册过）',
    noSuchEmail.status === 200 && noSuchEmail.body?.sent === true && noSuchEmail.body?.devResetUrl === undefined,
    `${noSuchEmail.status} devResetUrl=${noSuchEmail.body?.devResetUrl ?? 'none'}`,
  )

  const token = new URL(resetUrl).searchParams.get('token')
  const weakReset = await call('POST', '/auth/password/reset', { body: { token, password: '12345678' } })
  check('重置时弱密码被拒 → 409', weakReset.status === 409, `${weakReset.status} ${weakReset.body?.message ?? ''}`)

  const reset = await call('POST', '/auth/password/reset', { body: { token, password: 'newcook2026' } })
  check('用令牌重设密码 200', reset.status === 200 && reset.body?.ok === true, `${reset.status}`)

  const reuseToken = await call('POST', '/auth/password/reset', { body: { token, password: 'another2026pw' } })
  check('同一个重置令牌不能用第二次（一次性）', reuseToken.status === 400, `${reuseToken.status} ${reuseToken.body?.message ?? ''}`)

  const oldPasswordLogin = await call('POST', '/auth/login', { body: { account: emailUser.account, password: emailUser.password } })
  check('旧密码已失效 → 401', oldPasswordLogin.status === 401, `${oldPasswordLogin.status}`)
  const newPasswordLogin = await call('POST', '/auth/login', { body: { account: emailUser.account, password: 'newcook2026' } })
  check('新密码可以登录 200', newPasswordLogin.status === 200 && Boolean(newPasswordLogin.body?.token), `${newPasswordLogin.status}`)

  const oldRefresh = await call('POST', '/auth/refresh', { body: { refreshToken: emailUser.refreshToken } })
  check('重设密码后，改密前的会话被吊销（旧刷新令牌 → 401）', oldRefresh.status === 401, `${oldRefresh.status}`)
  const newSessionRefresh = await call('POST', '/auth/refresh', { body: { refreshToken: newPasswordLogin.body?.refreshToken } })
  check('重设密码后新登录的会话正常（刷新可用）', newSessionRefresh.status === 200, `${newSessionRefresh.status}`)

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
