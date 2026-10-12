#!/usr/bin/env node
/**
 * 打卡照片接口 HTTP 验收（真实请求，不 mock）。M9 / F9-03、F9-07、F9-08，口径见 D-023。
 * 用法：先启动服务，再执行 pnpm run test:http:checkins
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：上传（真图字节）→ 家庭墙 → 我的统计/热力图 → 照片读取的**双重校验**
 *       （签名 + 家庭成员，两者缺一不可）→ 只能挂"已做好"的一餐 → 非图片/超限/类型不符被拒
 *       → 共享开关收窄吃货可见范围。
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
  return { status: response.status, body: parsed, contentType, retryAfter: response.headers.get('retry-after') }
}

/** 取原始字节（验图片接口用，不能按 JSON 解析） */
async function callRaw(method, path, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, bytes, contentType: response.headers.get('content-type') ?? '' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 全局限流 60 次/分（按 IP 计数）。本脚本一轮 40+ 请求，连跑第二遍会被自己的限流打到一片 429。
 * 遇到 429 就等窗口过去重试（本脚本没有"必须 429"的用例，所以重试不会掩盖断言）。
 * 上传接口另有 12 次/分，同样靠这层兜住——脚本本身只上传 4 次。
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

/** 从点单列表里取某一餐的卡片（成品照张数的断言用它） */
async function orderCard(mealKey, token) {
  const list = await callWithRetry('GET', '/orders?status=ALL', { token })
  const cards = list.body?.cards ?? []
  return cards.find(card => card.mealKey === mealKey) ?? null
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

async function joinFamily(token, inviteCode) {
  const first = await call('POST', '/family/join', { token, body: { inviteCode } })
  if (first.status !== 429) return first
  const waitMs = (Number(first.retryAfter) || 60) * 1000 + 1000
  console.log(`⏳ 加入家庭已触发限流，等待 ${Math.round(waitMs / 1000)}s 后重试…\n`)
  await sleep(waitMs)
  return call('POST', '/family/join', { token, body: { inviteCode } })
}

let seq = 0
async function newUser(nickname) {
  seq += 1
  const account = `ck${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: nickname ?? account },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, refreshToken: registered.body.refreshToken, user: registered.body.user }
}

/**
 * 造一张**真的 PNG**（最小合法文件头 + 数据），而不是随手拼几个字节：
 * 后端会按文件头判断真实类型，随便造的字节会被正确地拒掉。
 * 用不同尺寸保证两张图的 sha256 不同（否则对象存储里会是同一份）。
 */
function pngBytes(seed) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(8, seed % 256)
  return Buffer.concat([header, ihdr, Buffer.from(`checkins-acceptance-${seed}`)])
}

function jpegBytes(seed) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-${seed}`)])
}

function toDataUrl(bytes, type = 'image/png') {
  return `data:${type};base64,${bytes.toString('base64')}`
}

function todayKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function main() {
  await settleThrottleWindow()

  // ---------- 前置：家庭 + 一道菜 + 一餐"已做好" ----------
  const mama = await newUser('妈妈')
  const created = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '打卡验收家' } })
  if (created.status !== 201) throw new Error(`建家失败：${created.status}`)
  const inviteCode = created.body.inviteCode

  const dishes = await call('GET', '/recipes?pageSize=2')
  const [dishA, dishB] = dishes.body?.items ?? []
  if (!dishA || !dishB) throw new Error('菜谱库不足 2 道，无法验收（先跑种子导入）')

  // ---------- 未登录 / 未加入家庭 ----------
  const anonymous = await call('GET', '/checkins')
  check('未带 token 访问打卡墙 → 401', anonymous.status === 401, `${anonymous.status}`)

  const loner = await newUser('独居者')
  const noFamily = await callWithRetry('POST', '/checkins', {
    token: loner.token,
    body: { image: toDataUrl(pngBytes(1)) },
  })
  check(
    '没有家庭的人打卡 → 404 且话术可读',
    noFamily.status === 404 && typeof noFamily.body?.message === 'string',
    `${noFamily.status} ${noFamily.body?.message ?? ''}`,
  )

  // ---------- 上传（F9-07） ----------
  const son = await newUser('小满')
  const joined = await joinFamily(son.token, inviteCode)
  if (joined.status !== 200) throw new Error(`小满加入失败：${joined.status}`)

  // 这一轮成功上传的张数——后面的可见范围断言按它算，不写死数字（写死过一次，加了张照片就红）
  let mamaPhotos = 0
  let sonPhotos = 0

  const first = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(11)), note: '  今晚的红烧排骨  ' },
  })
  if (first.status === 201) mamaPhotos += 1
  check(
    '上传打卡照片 201：返回签名短链、打卡日与备注',
    first.status === 201
      && typeof first.body?.id === 'string'
      && first.body?.photoUrl?.startsWith('/checkins/photos/')
      && first.body?.checkDate === todayKey()
      && first.body?.note === '今晚的红烧排骨',
    `${first.status} url=${String(first.body?.photoUrl).slice(0, 40)}… date=${first.body?.checkDate}`,
  )
  check(
    '打卡卡片带上上传者身份标记（前端据此显示"我"）',
    first.body?.isMe === true && first.body?.nickname === '妈妈' && typeof first.body?.avatar === 'string',
    `isMe=${first.body?.isMe} nickname=${first.body?.nickname}`,
  )
  check(
    '响应里不含对象存储的 key 与桶名（不泄漏存储结构；URL 只是我们自己的签名路径）',
    !/checkins\/[0-9a-f]{64}\.(jpg|png|webp)/.test(JSON.stringify(first.body ?? {}))
      && !JSON.stringify(first.body ?? {}).includes('cook-checkins'),
    JSON.stringify(first.body).slice(0, 120),
  )

  // 家庭成员都能传（用户要求"家庭中的每个人都可以上传"）
  const sonUpload = await callWithRetry('POST', '/checkins', {
    token: son.token,
    body: { image: toDataUrl(jpegBytes(22), 'image/jpeg'), note: '我洗的菜' },
  })
  if (sonUpload.status === 201) sonPhotos += 1
  check(
    '家里的吃货也能上传（人人可打卡，不比点菜更严）',
    sonUpload.status === 201 && sonUpload.body?.isMe === true && sonUpload.body?.nickname === '小满',
    `${sonUpload.status} ${sonUpload.body?.nickname}`,
  )

  // ---------- 家庭墙（F9-03） ----------
  const wall = await callWithRetry('GET', '/checkins', { token: mama.token })
  check(
    '家庭墙能看到全家人的照片（同家庭一起看）',
    wall.status === 200 && wall.body?.items?.length === 2 && wall.body?.scope === 'family',
    `${wall.status} items=${wall.body?.items?.length} scope=${wall.body?.scope}`,
  )
  check(
    '墙按时间倒序（最新的在最前）',
    wall.body?.items?.[0]?.nickname === '小满',
    JSON.stringify((wall.body?.items ?? []).map(i => i.nickname)),
  )
  check(
    '每张照片都有可用的签名链接与有效期',
    (wall.body?.items ?? []).every(item => item.photoUrl?.startsWith('/checkins/photos/') && item.photoExpiresAt > Date.now() / 1000),
    JSON.stringify((wall.body?.items ?? []).map(i => i.photoExpiresAt)),
  )

  const mineOnly = await callWithRetry('GET', '/checkins?family=false', { token: mama.token })
  check(
    '「只看我的」只剩下自己上传的',
    mineOnly.status === 200 && mineOnly.body?.scope === 'mine'
      && mineOnly.body?.items?.length === 1 && mineOnly.body?.items?.[0]?.isMe === true,
    `${mineOnly.status} items=${mineOnly.body?.items?.length}`,
  )

  // ---------- 取图：两道门 ----------
  const firstId = first.body.id
  const signedPath = first.body.photoUrl
  const expires = new URL(signedPath, 'http://x').searchParams.get('e')
  const signature = new URL(signedPath, 'http://x').searchParams.get('s')

  const photoWithAuth = await callRaw('GET', signedPath, { token: mama.token })
  check(
    '带签名 + 登录令牌取图 → 200 且真的返回图片字节',
    photoWithAuth.status === 200
      && photoWithAuth.contentType.includes('image/png')
      && photoWithAuth.bytes.equals(pngBytes(11)),
    `${photoWithAuth.status} ${photoWithAuth.contentType} ${photoWithAuth.bytes.length}B`,
  )

  const photoNoAuth = await callRaw('GET', signedPath)
  check(
    '只有签名、没有登录令牌 → 401（链接被转发也看不到别人家的照片）',
    photoNoAuth.status === 401,
    `${photoNoAuth.status}`,
  )

  const photoNoSignature = await callRaw('GET', `/checkins/photos/${encodeURIComponent(firstId)}?e=${expires}`, { token: mama.token })
  check('只有令牌、没有签名 → 401', photoNoSignature.status === 401, `${photoNoSignature.status}`)

  const photoForged = await callRaw('GET', `/checkins/photos/${encodeURIComponent(firstId)}?e=${expires}&s=forged-signature`, { token: mama.token })
  check('签名被伪造 → 401', photoForged.status === 401, `${photoForged.status}`)

  const photoExpired = await callRaw('GET', `/checkins/photos/${encodeURIComponent(firstId)}?e=${Number(expires) - 100000}&s=${signature}`, { token: mama.token })
  check('链接过期（或篡改有效期）→ 401', photoExpired.status === 401, `${photoExpired.status}`)

  // 家里人能看别人的照片；家庭外的登录用户即使拿到签名也看不了
  const stranger = await newUser('外人')
  await callWithRetry('POST', '/family', { token: stranger.token, body: { name: '另一家' } })
  const strangerPeek = await callRaw('GET', signedPath, { token: stranger.token })
  check(
    '别的家庭（有签名、也登录了）取图 → 404（不属于同一家庭）',
    strangerPeek.status === 404,
    `${strangerPeek.status}`,
  )
  const familyPeek = await callRaw('GET', signedPath, { token: son.token })
  check('同家庭成员能看（小满能看妈妈的打卡）', familyPeek.status === 200, `${familyPeek.status}`)

  // 注意：想构造"签名正确但不存在的 id"必须知道服务端的签名密钥（故意拿不到），
  // 所以外部能验的是——用甲照片的签名去取乙照片会被签名这一关拦下（401，早于任何数据查询）。
  const crossSignature = await callRaw('GET', `/checkins/photos/${encodeURIComponent(sonUpload.body.id)}?e=${expires}&s=${signature}`, { token: mama.token })
  check('拿另一张照片的签名去取图 → 401（签名绑定到具体照片）', crossSignature.status === 401, `${crossSignature.status}`)
  const missing = await callRaw('GET', `/checkins/photos/no-such-id?e=${expires}&s=${signature}`, { token: mama.token })
  check('不存在的照片 id（签名也不匹配）→ 401', missing.status === 401, `${missing.status}`)

  // ---------- 统计与热力图（F9-03） ----------
  const stats = await callWithRetry('GET', '/checkins/stats', { token: mama.token })
  const today = todayKey()
  const flat = (stats.body?.mine?.weeks ?? []).flat()
  check(
    '统计接口给出我的热力图：今天这一格有打卡、等级不为 0',
    stats.status === 200
      && flat.find(cell => cell.date === today)?.count === 1
      && flat.find(cell => cell.date === today)?.level >= 1,
    `${stats.status} todayCount=${flat.find(c => c.date === today)?.count}`,
  )
  check(
    '热力图是 18 周、按周分组、每格都有日期（没打卡的是 0 级不是缺格）',
    stats.body?.mine?.weeks?.length === 18
      && (stats.body?.mine?.weeks ?? []).every(week => week.length >= 1 && week.length <= 7)
      && new Set(flat.map(cell => cell.date)).size === flat.length,
    `weeks=${stats.body?.mine?.weeks?.length} cells=${flat.length}`,
  )
  check(
    '我的今天上传 1 张 → 连续天数至少 1；全家累计包含小满那张',
    (stats.body?.mine?.streak ?? 0) >= 1 && stats.body?.familyTotal === 2 && stats.body?.mineTotal === 1,
    `streak=${stats.body?.mine?.streak} mineTotal=${stats.body?.mineTotal} familyTotal=${stats.body?.familyTotal}`,
  )
  check(
    '统计里全家累计与我的分开给（同一张图不能只算一次到错的人头上）',
    stats.body?.family?.totalCount === 2 && stats.body?.mine?.totalCount === 1,
    `family=${stats.body?.family?.totalCount} mine=${stats.body?.mine?.totalCount}`,
  )

  // ---------- 挂到"已做好"的一餐（F9-08） ----------
  const mealKey = `${today}-DINNER`
  const order = await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: dishA.id, mealDate: today, meal: 'DINNER' },
  })
  if (order.status !== 201) throw new Error(`点菜失败：${order.status} ${JSON.stringify(order.body)}`)

  // 小满也点一道（这一餐要"他参与过"）——否则共享关闭后这张卡根本不在他的列表里（M3 口径），
  // 就没法验"照片藏了、张数也得跟着藏"这一条
  const sonOrder = await callWithRetry('POST', '/orders/items', {
    token: son.token,
    body: { recipeId: dishB.id, mealDate: today, meal: 'DINNER' },
  })
  if (sonOrder.status !== 201) throw new Error(`小满点菜失败：${sonOrder.status} ${JSON.stringify(sonOrder.body)}`)

  const attachPending = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(33)), mealKey },
  })
  check(
    '还没做好就想挂到这一餐 → 400（照片是"做出来了"的证据，不能替代状态流转）',
    attachPending.status === 400 && typeof attachPending.body?.message === 'string',
    `${attachPending.status} ${attachPending.body?.message ?? ''}`,
  )

  await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'PLANNED' } })
  await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'COOKING' } })
  const done = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: mama.token, body: { status: 'DONE' } })
  check('前置：这一餐已推送到「已做好」', done.status === 200 && done.body?.status === 'DONE', `${done.status}`)

  const attached = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(44)), note: '成品', mealKey },
  })
  if (attached.status === 201) mamaPhotos += 1
  check(
    '「已做好」之后能传成品照，并带上这一餐的标识（F9-08）',
    attached.status === 201 && attached.body?.mealKey === mealKey && attached.body?.mealLabel === '晚餐',
    `${attached.status} mealKey=${attached.body?.mealKey} mealLabel=${attached.body?.mealLabel}`,
  )

  // 家里另一个人也往这一餐传一张：点单卡上的张数要能对上（F9-08）
  const sonAttached = await callWithRetry('POST', '/checkins', {
    token: son.token,
    body: { image: toDataUrl(pngBytes(45)), mealKey },
  })
  if (sonAttached.status === 201) sonPhotos += 1
  check(
    '家里其他人也能给同一餐传成品照',
    sonAttached.status === 201 && sonAttached.body?.mealKey === mealKey,
    `${sonAttached.status} mealKey=${sonAttached.body?.mealKey}`,
  )

  const doneCardForMama = await orderCard(mealKey, mama.token)
  check(
    '点单卡带上成品照张数（F9-08：这一餐 2 张）',
    doneCardForMama?.photoCount === 2,
    `photoCount=${doneCardForMama?.photoCount}`,
  )
  const doneCardForSon = await orderCard(mealKey, son.token)
  check(
    '共享开着时，家里人都看得到这一餐有几张成品照',
    doneCardForSon?.photoCount === 2,
    `photoCount=${doneCardForSon?.photoCount}`,
  )

  const badMealKey = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(55)), mealKey: 'not-a-meal-key' },
  })
  check('畸形的餐次标识 → 400', badMealKey.status === 400, `${badMealKey.status} ${badMealKey.body?.message ?? ''}`)

  const missingMeal = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(66)), mealKey: '2029-01-01-LUNCH' },
  })
  check('挂到不存在的餐 → 404', missingMeal.status === 404, `${missingMeal.status}`)

  // ---------- 输入校验 ----------
  const notImage = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'), contentType: 'image/png' },
  })
  check(
    '声称是 PNG、内容其实是 HTML → 400（按文件头判断真实类型，不存打不开的图）',
    notImage.status === 400 && typeof notImage.body?.message === 'string',
    `${notImage.status} ${notImage.body?.message ?? ''}`,
  )

  const gifLike = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(77)), contentType: 'image/gif' },
  })
  check('不支持的图片类型（gif）→ 400', gifLike.status === 400, `${gifLike.status}`)

  const noImage = await callWithRetry('POST', '/checkins', { token: mama.token, body: { note: '只有文字' } })
  check('没有图片内容 → 400', noImage.status === 400, `${noImage.status}`)

  const longNote = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: toDataUrl(pngBytes(88)), note: '好'.repeat(61) },
  })
  check('备注超长（>60 字）→ 400', longNote.status === 400, `${longNote.status}`)

  const badBase64 = await callWithRetry('POST', '/checkins', {
    token: mama.token,
    body: { image: 'not base64 at all !!!' },
  })
  check('不是合法 base64 → 400', badBase64.status === 400, `${badBase64.status}`)

  const unknownQuery = await callWithRetry('GET', '/checkins?limit=999', { token: mama.token })
  check('limit 超出范围 → 400', unknownQuery.status === 400, `${unknownQuery.status}`)

  const badFamily = await callWithRetry('GET', '/checkins?family=maybe', { token: mama.token })
  check('family 参数非法值 → 400', badFamily.status === 400, `${badFamily.status}`)

  // ---------- 共享开关（F2-07 口径与点单一致） ----------
  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  check('掌勺人关掉共享开关 200', sharedOff.status === 200 && sharedOff.body?.shared === false, `${sharedOff.status}`)

  const sonNarrowed = await callWithRetry('GET', '/checkins', { token: son.token })
  check(
    '共享关闭后吃货只看得到自己上传的（数量与"自己传过几张"对得上，且全是本人）',
    sonNarrowed.status === 200 && sonNarrowed.body?.scope === 'mine'
      && sonNarrowed.body?.items?.length === sonPhotos
      && (sonNarrowed.body?.items ?? []).length > 0
      && (sonNarrowed.body?.items ?? []).every(item => item.isMe === true),
    `${sonNarrowed.status} scope=${sonNarrowed.body?.scope} items=${sonNarrowed.body?.items?.length} 自己传过=${sonPhotos}`,
  )
  const mamaStillAll = await callWithRetry('GET', '/checkins', { token: mama.token })
  check(
    '共享关闭不影响掌勺人看全家（照片是家里的记录，他要能看全）',
    mamaStillAll.status === 200 && mamaStillAll.body?.scope === 'family'
      && mamaStillAll.body?.items?.length === mamaPhotos + sonPhotos,
    `${mamaStillAll.status} scope=${mamaStillAll.body?.scope} items=${mamaStillAll.body?.items?.length} 全家成功上传=${mamaPhotos + sonPhotos}`,
  )
  const sonPhotoStillReadable = await callRaw('GET', sonUpload.body.photoUrl, { token: son.token })
  check('收窄可见范围后，自己那张照片仍读得到', sonPhotoStillReadable.status === 200, `${sonPhotoStillReadable.status}`)

  // 张数也要跟着收窄：否则照片藏了、数字却把别人传了几张漏出去
  const narrowedCardForSon = await orderCard(mealKey, son.token)
  check(
    '共享关闭后，吃货在点单卡上只数得到自己传的那张成品照（照片藏了数字不能漏）',
    narrowedCardForSon?.photoCount === 1,
    `photoCount=${narrowedCardForSon?.photoCount}（共享开着时是 2）`,
  )
  const narrowedCardForMama = await orderCard(mealKey, mama.token)
  check(
    '共享关闭不影响掌勺人在点单卡上看到全部成品照张数',
    narrowedCardForMama?.photoCount === 2,
    `photoCount=${narrowedCardForMama?.photoCount}`,
  )

  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

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
