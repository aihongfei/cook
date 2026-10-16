#!/usr/bin/env node
/**
 * 消息提醒**扩容**的验收（用户 2026-10-16：「订单有变化、打卡墙有上传、评论、
 * 家庭有变化、冰箱有变化，就是家庭相关修改的都需要通知」）。真实请求，不 mock。
 *
 * 用法：先启动服务，再执行 `node services/api/scripts/verify-notifications-change.cjs`
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 自带全部前置数据（自己注册、建家庭、三个人），不依赖别的验收留下的东西。
 *
 * 覆盖（每一条都对应这次改动的一句话）：
 * ① 订单变动：加菜 / 撤菜 / 整桌退 / 改人数 / 取消这一餐 —— 家人都收得到，自己收不到；
 * ② 冰箱变动：放进 / 改动 / 拿走 —— 家人收得到，归**冰箱**那个区（底栏红点在冰箱上）；
 * ③ 打卡与评论：上传、评论 —— 家人收得到，归 family 区，去处是打卡墙；
 * ④ 家庭变动：加入 / 改角色 / 改设置 / 换邀请码 / 退出 —— 家人收得到；
 * ⑤ 菜谱变动：上传 / 改动 / 删除 —— 家人收得到；
 * ⑥ **状态型那四类照旧**（菜单定了 / 做好了 / 快过期 / 该备菜）——扩范围没把旧的弄坏；
 * ⑦ **不重复**：同一件事（同一次上传/同一条评论）取两次列表不新增第二条；
 * ⑧ **开关**：关掉"冰箱有变化"之后，新的冰箱变动不再进他的列表；别人照旧；
 * ⑨ **自己做的事不提醒自己**；
 * ⑩ 那条边界：`GET /notifications` 的 `prefs` 返回**九个键**（少一个前端就画不出那个开关）；
 * ⑪ **巡查那条路也认得事件型**（用户要的四块在应用外只有这条路：F10-06 每约 15 分钟一圈）——
 *    第一次不弹、之后新发生的挑得到、同一条不重复弹。
 *
 * ⚠️ 每一步都看状态码：这个脚本自己造前置数据，某一步 400/409 而没检查的话，
 * 后面的"没有收到通知"会被误当成通知的 bug（上一版就在这上面栽过，见那个脚本的说明）。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'

let failed = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function call(method, path, { body, token, patrol } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  // 巡查那条路走 `x-patrol-token`（只读、不能当登录凭据用，见 D-081）
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

/**
 * 限流（60 次/分钟）会返回 429：等到它说的秒数再重试，别把 429 当数据读。
 *
 * **这个脚本自己就会触发限流**：它一个人跑几十个请求（每步都要取一次通知列表），
 * 很容易撞上。等的是响应头里那个 `retry-after`（服务端说等多久就等多久），
 * 不是拍一个数——拍小了会连环撞、拍大了白等。
 */
async function callWithRetry(method, path, options = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await call(method, path, options)
    if (result.status !== 429) return result
    const wait = Math.min(Number(result.retryAfter ?? 5) + 1, 70)
    console.log(`  ⏳ 触发限流，等 ${wait}s…`)
    await sleep(wait * 1000)
  }
  throw new Error(`重试多次仍是 429：${method} ${path}`)
}

const stamp = Date.now()
const account = (tag) => `notif${tag}${stamp}`
const PASS = 'cook-dev-1234'

async function register(acc, nickname) {
  const result = await callWithRetry('POST', '/auth/register', {
    body: { account: acc, password: PASS, nickname },
  })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`注册 ${acc} 失败：${result.status} ${JSON.stringify(result.body)}`)
  }
  return { token: result.body.token, user: result.body.user, body: result.body }
}

/**
 * 取通知看板（列表 + 未读数 + 开关）。
 *
 * 注册接口回的字段是 `token`（不是 `accessToken`）——照抄 `verify-notifications-http.cjs`，
 * 那一份是真跑通过的。
 */
async function titles(token) {
  const result = await callWithRetry('GET', '/notifications', { token })
  if (result.status !== 200) throw new Error(`取通知失败：${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

function has(items, predicate) {
  return items.some(predicate)
}

async function main() {
  // ---------- 前置：掌勺人建家，另两人加入 ----------
  const owner = await register(account('o'), '妈妈')
  const cook = await register(account('c'), '爸爸')
  const eater = await register(account('e'), '小满')

  const family = await callWithRetry('POST', '/family', { token: owner.token, body: { name: `提醒验收${stamp}` } })
  check('前置：建家庭', family.status === 201 || family.status === 200, `${family.status}`)
  const inviteCode = family.body.inviteCode

  const join1 = await callWithRetry('POST', '/family/join', { token: cook.token, body: { inviteCode } })
  const join2 = await callWithRetry('POST', '/family/join', { token: eater.token, body: { inviteCode } })
  check('前置：两人加入家庭', join1.status === 200 && join2.status === 200, `${join1.status}/${join2.status}`)

  const ownerToken = owner.token
  const cookToken = cook.token
  const eaterToken = eater.token

  /*
   * 加入这件事本身就该通知先到的人（用户 2026-10-16 的"家庭有变化"）。
   * 第一条就验它——此时妈妈家里已经有两位新人，她该收到两条"加入了家庭"。
   */
  const afterJoin = await titles(ownerToken)
  const joinNotices = afterJoin.items.filter((item) => item.kind === 'family' && item.title.includes('加入了家庭'))
  check('①家庭变动：有人加入 → 家里人收到（两条）', joinNotices.length === 2, `收到 ${joinNotices.length} 条`)
  check('①家庭变动：加入那条归 family 区（不亮底栏）', joinNotices[0]?.kind === 'family', `kind=${joinNotices[0]?.kind}`)

  // 自己加入不提醒自己（妈妈是建家的，没加入动作；用爸爸自己那份看）
  const cookAfterJoin = await titles(cookToken)
  check('⑨自己不提醒自己：新加入的人没有"自己加入"那条', !has(cookAfterJoin.items, (i) => i.kind === 'family' && i.title.includes('爸爸加入了家庭')), '')
  // 但他看得见"别人后来加入"（小满在他后面加入）
  check('①家庭变动：后加入的人收到"别人加入"那条', has(cookAfterJoin.items, (i) => i.title.includes('小满加入了家庭')), '')

  // ---------- 订单变动 ----------
  const date = new Date()
  const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const mealKey = `${dayKey}-DINNER`

  // 爸爸加两道菜（找两道真实存在的菜谱）
  const recipes = await callWithRetry('GET', '/recipes?pageSize=3', {})
  const dishIds = (recipes.body?.items ?? []).map((r) => r.id)
  check('前置：能取到菜谱（用来点菜）', dishIds.length >= 2, `拿到 ${dishIds.length} 道`)

  const add1 = await callWithRetry('POST', '/orders/items', { token: cookToken, body: { recipeId: dishIds[0], mealDate: dayKey, meal: 'DINNER' } })
  check('前置：加第一道菜', add1.status === 201 || add1.status === 200, `${add1.status} ${JSON.stringify(add1.body)?.slice(0, 120)}`)

  const ownerAfterAdd = await titles(ownerToken)
  const addNotices = ownerAfterAdd.items.filter((i) => i.kind === 'order' && i.tag === '加菜')
  check('②订单变动：加菜 → 家人收到', addNotices.length >= 1, `收到 ${addNotices.length} 条`)
  check('②订单变动：那条带 mealKey（点单卡要标角标）', addNotices[0]?.mealKey === mealKey, `mealKey=${addNotices[0]?.mealKey}`)
  check('②订单变动：归订单区', ownerAfterAdd.unreadByArea.order >= 1, `order=${ownerAfterAdd.unreadByArea.order}`)

  // 爸爸自己不该收到"自己加菜"
  const cookAfterAdd = await titles(cookToken)
  check('⑨自己不提醒自己：加菜的人没收到自己那条', !has(cookAfterAdd.items, (i) => i.kind === 'order' && i.title.includes('爸爸点了')), '')

  // 整组加菜（摇一桌）合成一条
  const bulk = await callWithRetry('POST', '/orders/items/bulk', { token: cookToken, body: { recipeIds: dishIds.slice(1, 3), mealDate: dayKey, meal: 'DINNER' } })
  check('前置：批量加菜', bulk.status === 201 || bulk.status === 200, `${bulk.status}`)
  const ownerAfterBulk = await titles(ownerToken)
  const bulkNotices = ownerAfterBulk.items.filter((i) => i.kind === 'order' && i.title.includes('一次点了'))
  check('②订单变动：整组加菜**合成一条**（不刷三行）', bulkNotices.length === 1, `收到 ${bulkNotices.length} 条`)

  /*
   * 改人数：`POST /orders/meals/:mealKey/diners` 要 `menu.manage`（掌勺人/帮厨），
   * 而**通过邀请码加入的人是 EATER**（见 family.service 的 join）——所以这一步由妈妈做。
   * 顺带把"谁做的不重要，家里人照样收到"也验到了：爸爸（没做这件事的人）该收到。
   */
  const diners = await callWithRetry('POST', `/orders/meals/${mealKey}/diners`, { token: ownerToken, body: { dinerCount: 4 } })
  check('前置：改人数', diners.status === 200, `${diners.status} ${JSON.stringify(diners.body)?.slice(0, 100)}`)
  const cookAfterDiners = await titles(cookToken)
  check('②订单变动：改人数 → 家人收到', has(cookAfterDiners.items, (i) => i.kind === 'order' && i.tag === '改人数'), '')

  // 撤一道菜（拿卡片上的条目 id）
  const board = await callWithRetry('GET', '/orders', { token: cookToken })
  const card = (board.body?.cards ?? []).find((c) => c.mealKey === mealKey)
  const itemId = card?.items?.find((it) => it.isMe)?.id
  check('前置：拿到要撤的那一条 id', Boolean(itemId), `itemId=${itemId}`)
  const removed = await callWithRetry('DELETE', `/orders/items/${itemId}`, { token: cookToken })
  check('前置：撤菜', removed.status === 200, `${removed.status}`)
  const ownerAfterRemove = await titles(ownerToken)
  check('②订单变动：撤菜 → 家人收到', has(ownerAfterRemove.items, (i) => i.kind === 'order' && i.tag === '撤菜'), '')

  // 取消这一餐（需要 menu.manage：爸爸是 COOK，没有；用妈妈）
  const canceled = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token: ownerToken, body: { status: 'CANCELED' } })
  check('前置：取消这一餐', canceled.status === 200, `${canceled.status} ${JSON.stringify(canceled.body)?.slice(0, 120)}`)
  const cookAfterCancel = await titles(cookToken)
  check('②订单变动：取消 → 家人收到', has(cookAfterCancel.items, (i) => i.kind === 'order' && i.tag === '取消了'), '')

  // 整桌退（先加回来一餐清空的）
  await callWithRetry('POST', '/orders/items', { token: cookToken, body: { dishName: '验收自由菜', mealDate: dayKey, meal: 'LUNCH' } })
  const lunchKey = `${dayKey}-LUNCH`
  const cleared = await callWithRetry('DELETE', `/orders/meals/${lunchKey}/items`, { token: cookToken })
  check('前置：整桌退', cleared.status === 200, `${cleared.status}`)
  const ownerAfterClear = await titles(ownerToken)
  check('②订单变动：整桌退 → 家人收到', has(ownerAfterClear.items, (i) => i.title.includes('整桌退了')), '')

  // ---------- 冰箱变动 ----------
  const added = await callWithRetry('POST', '/fridge', { token: cookToken, body: { name: `验收牛奶${stamp}`, amount: '2 盒', zone: '冷藏' } })
  check('前置：冰箱录入', added.status === 201, `${added.status} ${JSON.stringify(added.body)?.slice(0, 120)}`)
  const ownerAfterFridgeAdd = await titles(ownerToken)
  const fridgeAdd = ownerAfterFridgeAdd.items.filter((i) => i.kind === 'fridge' && i.tag === '入库')
  check('③冰箱变动：放进 → 家人收到', fridgeAdd.length === 1, `收到 ${fridgeAdd.length} 条`)
  check('③冰箱变动：归**冰箱**区（底栏红点在冰箱上，不在订单）', ownerAfterFridgeAdd.unreadByArea.fridge >= 1, `fridge=${ownerAfterFridgeAdd.unreadByArea.fridge}`)

  // 找它那条的 id 改一改。冰箱看板按**区**分组（zones），平铺的那份是 `recent`——
  // 用 `recent` 最简单（刚放进来的必然在里面）。
  const fridgeBoard = await callWithRetry('GET', '/fridge', { token: cookToken })
  const milk = (fridgeBoard.body?.recent ?? []).find((it) => it.name === `验收牛奶${stamp}`)
  check('前置：拿到冰箱那条 id', Boolean(milk), `recent=${(fridgeBoard.body?.recent ?? []).length} 条`)
  const edited = await callWithRetry('PATCH', `/fridge/${milk.id}`, { token: cookToken, body: { amount: '1 盒' } })
  check('前置：改冰箱那条', edited.status === 200, `${edited.status}`)
  const ownerAfterFridgeEdit = await titles(ownerToken)
  check('③冰箱变动：改动 → 家人收到', has(ownerAfterFridgeEdit.items, (i) => i.kind === 'fridge' && i.tag === '改了'), '')

  const taken = await callWithRetry('DELETE', `/fridge/${milk.id}`, { token: cookToken })
  check('前置：拿走', taken.status === 200, `${taken.status}`)
  const ownerAfterFridgeRemove = await titles(ownerToken)
  check('③冰箱变动：拿走 → 家人收到', has(ownerAfterFridgeRemove.items, (i) => i.kind === 'fridge' && i.tag === '拿走'), '')

  // ---------- 打卡与评论 ----------
  // 1×1 的 PNG（base64），够过前端的类型嗅探与大小校验
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const photo = await callWithRetry('POST', '/checkins', { token: cookToken, body: { image: `data:image/png;base64,${png}`, contentType: 'image/png', note: '验收那一张' } })
  check('前置：上传打卡', photo.status === 201, `${photo.status} ${JSON.stringify(photo.body)?.slice(0, 140)}`)
  const ownerAfterPhoto = await titles(ownerToken)
  const photoNotice = ownerAfterPhoto.items.filter((i) => i.kind === 'checkin')
  check('④打卡：上传 → 家人收到', photoNotice.length === 1, `收到 ${photoNotice.length} 条`)
  check('④打卡：归 family 区（红点在「我的」页那几行上）', photoNotice[0]?.kind === 'checkin', '')
  check('④打卡：去处是打卡墙', photoNotice[0]?.to === '/checkins', `to=${photoNotice[0]?.to}`)

  const comment = await callWithRetry('POST', `/checkins/${photo.body.id}/comments`, { token: eaterToken, body: { body: '这个火候刚好' } })
  check('前置：评论', comment.status === 201, `${comment.status} ${JSON.stringify(comment.body)?.slice(0, 120)}`)
  const ownerAfterComment = await titles(ownerToken)
  check('④评论 → 家人收到（归评论那一类）', has(ownerAfterComment.items, (i) => i.kind === 'comment'), '')
  // 上传者本人（爸爸）会收到评论那条，但不会收到自己上传的那条
  const cookAfterComment = await titles(cookToken)
  check('⑨自己不提醒自己：上传的人没有"自己上传"那条', !has(cookAfterComment.items, (i) => i.kind === 'checkin'), '')
  check('④别人评论：他自己收得到', has(cookAfterComment.items, (i) => i.kind === 'comment' && i.title.includes('小满')), '')

  // ---------- 家庭变动 ----------
  const renamed = await callWithRetry('PATCH', '/family', { token: ownerToken, body: { name: `验收之家${stamp}` } })
  check('前置：改家庭名', renamed.status === 200, `${renamed.status}`)
  const cookAfterRename = await titles(cookToken)
  check('⑤家庭变动：改设置 → 家人收到', has(cookAfterRename.items, (i) => i.kind === 'family' && i.tag === '设置'), '')

  const codeReset = await callWithRetry('POST', '/family/invite/reset', { token: ownerToken })
  check('前置：换邀请码', codeReset.status === 200, `${codeReset.status}`)
  const cookAfterCode = await titles(cookToken)
  const codeNotice = cookAfterCode.items.find((i) => i.kind === 'family' && i.tag === '邀请码')
  check('⑤家庭变动：换邀请码 → 家人收到', Boolean(codeNotice), '')
  check('⑤换码那条**不写新码**（那是进家的凭据，不该躺进通知正文）',
    Boolean(codeNotice) && !codeNotice.title.includes(codeReset.body.inviteCode) && !String(codeNotice.body ?? '').includes(codeReset.body.inviteCode), '')

  const role = await callWithRetry('PATCH', `/family/members/${eater.user.id}`, { token: ownerToken, body: { role: 'COOK' } })
  check('前置：改角色', role.status === 200, `${role.status} ${JSON.stringify(role.body)?.slice(0, 120)}`)
  const cookAfterRole = await titles(cookToken)
  check('⑤家庭变动：改角色 → 家人收到', has(cookAfterRole.items, (i) => i.kind === 'family' && i.tag === '角色'), '')

  // ---------- 菜谱变动 ----------
  const newRecipe = await callWithRetry('POST', '/recipes', {
    token: cookToken,
    body: {
      name: `验收菜${stamp}`,
      category: '家常',
      cuisine: '川菜',
      ingredients: [{ name: '鸡蛋', amount: '2 个' }],
      steps: ['打蛋', '下锅'],
    },
  })
  check('前置：上传自建菜谱', newRecipe.status === 201, `${newRecipe.status} ${JSON.stringify(newRecipe.body)?.slice(0, 160)}`)
  const ownerAfterRecipe = await titles(ownerToken)
  const recipeNotice = ownerAfterRecipe.items.filter((i) => i.kind === 'recipe' && i.tag === '新菜谱')
  check('⑥菜谱变动：上传 → 家人收到', recipeNotice.length === 1, `收到 ${recipeNotice.length} 条`)
  check('⑥菜谱变动：去处是那道菜谱的详情', recipeNotice[0]?.to === `/recipes/${newRecipe.body.id}`, `to=${recipeNotice[0]?.to}`)

  const recipeId = newRecipe.body.id
  const editedRecipe = await callWithRetry('PATCH', `/recipes/${recipeId}`, { token: cookToken, body: { notes: ['验收改一下'] } })
  check('前置：改菜谱', editedRecipe.status === 200, `${editedRecipe.status}`)
  const ownerAfterRecipeEdit = await titles(ownerToken)
  check('⑥菜谱变动：改动 → 家人收到', has(ownerAfterRecipeEdit.items, (i) => i.kind === 'recipe' && i.tag === '改了'), '')

  const removedRecipe = await callWithRetry('DELETE', `/recipes/${recipeId}`, { token: cookToken })
  check('前置：删菜谱', removedRecipe.status === 200, `${removedRecipe.status}`)
  const ownerAfterRecipeDel = await titles(ownerToken)
  check('⑥菜谱变动：删除 → 家人收到', has(ownerAfterRecipeDel.items, (i) => i.kind === 'recipe' && i.tag === '删了'), '')

  // ---------- 幂等：同一件事取两次不新增 ----------
  const first = await titles(ownerToken)
  const second = await titles(ownerToken)
  check('⑦幂等：连着取两次列表，条数一样（事件不会越读越多）', first.items.length === second.items.length, `${first.items.length} → ${second.items.length}`)

  // ---------- 开关 ----------
  const offFridge = await callWithRetry('POST', '/notifications/prefs', { token: ownerToken, body: { fridgeChange: false } })
  check('⑧开关：能单独关掉"冰箱有变化"', offFridge.status === 200 && offFridge.body.fridgeChange === false, `${offFridge.status} ${JSON.stringify(offFridge.body)?.slice(0, 120)}`)

  await callWithRetry('POST', '/fridge', { token: cookToken, body: { name: `验收关掉后${stamp}`, zone: '冷藏' } })
  const ownerAfterMute = await titles(ownerToken)
  const newFridgeAfterMute = ownerAfterMute.items.filter((i) => i.kind === 'fridge' && i.title.includes(`验收关掉后${stamp}`))
  check('⑧开关：关掉之后新的冰箱变动**不再进他的列表**', newFridgeAfterMute.length === 0, `收到 ${newFridgeAfterMute.length} 条`)
  check('⑧开关：关掉不影响别的类（订单的还在）', has(ownerAfterMute.items, (i) => i.kind === 'order'), '')

  // 别人没关，照旧收得到 → 用妈妈自己再放进冰箱看看爸爸那份（爸爸没关）
  await callWithRetry('POST', '/fridge', { token: ownerToken, body: { name: `验收反向${stamp}`, zone: '冷藏' } })
  const cookAfterMute = await titles(cookToken)
  check('⑧开关是按账号的：我关了不影响他（爸爸仍收得到妈妈放进冰箱）', has(cookAfterMute.items, (i) => i.kind === 'fridge' && i.title.includes(`验收反向${stamp}`)), '')

  // ---------- 巡查（手机后台那条路）：新加的事件型照样挑得到 ----------
  /*
   * 用户要的那四块里，"打卡墙有上传/评论""家庭有变化"**在应用外只有巡查这一条路**
   * （F10-06 的 15 分钟一圈）。这条链路与通知中心共用 `list()`，所以口径必然一致——
   * 但"能一致"是设计，不是证据：这里真打一次巡查接口。
   *
   * 老脚本 `verify-patrol-http.cjs`（33/33）覆盖的是**状态型**那几类，
   * 它上线时事件型还不存在——这一段补的正是"新类别能不能进那条通道"。
   */
  const issued = await callWithRetry('POST', '/notifications/patrol/token', {
    token: cookToken,
    body: { deviceId: `verify-notif-${stamp}` },
  })
  check('⑫巡查：能领到只读令牌', issued.status === 201 || issued.status === 200, `${issued.status}`)
  const patrolToken = issued.body?.token

  // 第一次（不带 since）一条都不弹，但会给出"我看到哪儿了"（见 patrol.rules 的 since 说明）
  const patrolFirst = await callWithRetry('GET', '/notifications/patrol', { patrol: patrolToken })
  check('⑫巡查：第一次一条不弹（历史一次性糊到脸上是伪新）',
    Array.isArray(patrolFirst.body?.items) && patrolFirst.body.items.length === 0, `弹了 ${patrolFirst.body?.items?.length ?? 'x'} 条`)
  const since = patrolFirst.body?.since
  check('⑫巡查：第一次带回 since（下次从这一刻往后挑）', typeof since === 'string' && since.length > 0, `since=${since}`)

  // 之后家里发生一件事（妈妈传一条打卡），巡查该挑得到它
  const photoForPatrol = await callWithRetry('POST', '/checkins', {
    token: ownerToken,
    body: { image: `data:image/png;base64,${png}`, contentType: 'image/png', note: '巡查验收' },
  })
  check('前置：为巡查再传一条打卡', photoForPatrol.status === 201, `${photoForPatrol.status}`)
  const patrolSecond = await callWithRetry('GET', `/notifications/patrol?since=${encodeURIComponent(since)}`, { patrol: patrolToken })
  const patrolItems = patrolSecond.body?.items ?? []
  check('⑫巡查：**事件型**（打卡）手机在后台也挑得到',
    has(patrolItems, (i) => i.tag === '打卡'), `弹了 ${patrolItems.length} 条：${patrolItems.map((i) => i.title).join(' / ') || '（空）'}`)
  check('⑫巡查：每条都带上系统通知要的数字 id（后台那段代码 import 不了我们的模块，见 patrol.rules）',
    patrolItems.length > 0 && patrolItems.every((i) => Number.isInteger(i.notifyId) && i.notifyId > 0), '')

  // 再巡查一次：同一条不该被重复弹（`since` 推进到全部提醒里最新的那个时刻）
  const patrolThird = await callWithRetry('GET', `/notifications/patrol?since=${encodeURIComponent(patrolSecond.body?.since ?? since)}`, { patrol: patrolToken })
  check('⑫巡查：同一条不重复弹（否则每 15 分钟响一次）',
    (patrolThird.body?.items ?? []).length === 0, `又弹了 ${(patrolThird.body?.items ?? []).length} 条`)

  // ---------- 九个开关都在 ----------
  const board9 = await titles(ownerToken)
  const keys = Object.keys(board9.prefs ?? {})
  const expected = ['mealPlan', 'mealDone', 'expiry', 'prep', 'orderChange', 'fridgeChange', 'checkin', 'family', 'recipe']
  check('⑩`prefs` 返回九个键（少一个前端就画不出那个开关）',
    expected.every((k) => keys.includes(k)) && keys.length === 9, keys.join(','))

  // ---------- 旧四类没被弄坏 ----------
  check('⑪状态型那四类照旧：plan/done/expiry/prep 的 kind 仍认得出来',
    board9.items.every((i) => typeof i.kind === 'string' && typeof i.title === 'string' && typeof i.to === 'string'), '')
  check('⑪每条都带 origin（derived / event 两种，用来区分"会自己消失的"与"发生过的"）',
    board9.items.every((i) => i.origin === 'derived' || i.origin === 'event'), '')

  // ---------- 退出家庭 ----------
  const quit = await callWithRetry('POST', '/family/leave', { token: eaterToken })
  check('前置：小满退出家庭', quit.status === 200, `${quit.status}`)
  const ownerAfterLeave = await titles(ownerToken)
  check('⑤家庭变动：有人退出 → 家人收到', has(ownerAfterLeave.items, (i) => i.kind === 'family' && i.title.includes('退出了家庭')), '')

  // ---------- 汇总 ----------
  const pass = results.filter((r) => r.ok).length
  for (const r of results) {
    if (!r.ok) console.log(`  ✗ ${r.name}  ${r.detail}`)
  }
  console.log(`\n通知扩容验收：${pass}/${results.length} 通过`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('验收跑挂了：', error)
  process.exitCode = 1
})
