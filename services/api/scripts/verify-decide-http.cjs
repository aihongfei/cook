#!/usr/bin/env node
/**
 * 「帮我决定」的 HTTP 验收（真实请求，不 mock）。M5 / F5-05，口径见 D-060。
 * 用法：先启动服务，再执行 pnpm run test:http:decide
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 这一份**自带全部前置数据**（自己注册、建家庭、记冰箱、配口味），不依赖别的验收留下的东西。
 *
 * 覆盖：401 / 404 → 空冰箱时挑得出菜但**明说没照冰箱挑**（`fridgeEmpty`）
 *       → 空冰箱 + 无信号时那句话是"库里挑的"（**不编理由**）
 *       → 记了番茄鸡蛋之后：**能挑出"一样都不用买"的那道**
 *       → **独立核对**：凡是说"正好能做这道"的，配料表（自己重新取一遍）里的非调料配料
 *         必须**真的**都在冰箱里（拿接口的话证明接口没撒谎是不算的）
 *       → `exclude` 真生效（换一道不会换回同一道）、且**排空了也照样给一道**
 *       → 冰箱里只有调料时**绝不说"用上了冰箱里的…"**（调料不进比对）
 *       → 有人对鸡蛋过敏时，挑出来的菜**一道都不许含鸡蛋**（而**仍然挑得出菜**：
 *         不是把整个功能关掉就算过滤通过）
 *       → 共享关掉后 scope=mine（冰箱与收藏都只算自己的）
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
  const account = `dc${Date.now()}${seq}`.toLowerCase()
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

async function stock(token, name, amount, zone = '冷藏') {
  const added = await callWithRetry('POST', '/fridge', { token, body: { name, amount, zone } })
  if (added.status !== 201) throw new Error(`记冰箱失败（${name}）：${added.status} ${JSON.stringify(added.body)}`)
  return added.body
}

/* ============================================================
 * 以下这一段是**独立的核对路径**，刻意不复用服务端那份规则。
 *
 * 如果这里也去调 `pantry.rules`（或让服务端告诉我"该配得上"），那就变成
 * "拿接口的话证明接口没撒谎"——接口把五花肉认成猪肉，只要它自己一致就照样绿。
 * 所以这里自带一份**很短**的调料表与别名表，只覆盖本脚本用到的几样。
 * ============================================================ */

/*
 * 本脚本用到的调料（判据：少了它没人觉得算缺）。
 *
 * ⚠️ 这一份必须**覆盖库里真实出现的写法**：第一版只列了十来样，
 * 于是"盐 少许"「鸡精 少许」被判成非调料（名字里带着用量）而让独立核对假红，
 * `白胡椒粉`（库里写的是"白胡椒粉"、我只列了"胡椒粉"）也一样。
 * 这次的教训是"独立核对"的独立指的是**不复用服务端那份规则**，
 * 不是"可以写得比它粗糙"——判据本身仍要写对，否则红的是核对而不是被测代码。
 */
const SEASONINGS = new Set([
  '油', '食用油', '植物油', '盐', '精盐', '糖', '白糖', '白砂糖', '冰糖', '红糖', '水', '清水',
  '葱', '小葱', '大葱', '香葱', '小香葱', '葱花', '葱段', '姜', '生姜', '姜片', '蒜', '大蒜', '蒜末', '蒜片',
  '生抽', '老抽', '酱油', '料酒', '黄酒', '老酒', '醋', '香醋', '陈醋', '米醋',
  '鸡精', '味精', '高汤', '高汤精', '鸡汤', '淀粉', '生粉', '水淀粉', '番茄酱', '蚝油', '豆瓣酱', '甜面酱',
  '胡椒粉', '白胡椒粉', '黑胡椒粉', '花椒', '花椒粉', '干辣椒', '辣椒粉', '孜然', '五香粉',
  '芝麻', '白芝麻', '黑芝麻', '香油', '芝麻油', '食用油', '红油', '辣椒油', '香菜',
])

/** 只收"确定是同一样东西"的别名（本脚本用到的那几对，独立判断过的） */
const ALIAS = new Map([
  ['西红柿', '番茄'],
  ['马铃薯', '土豆'],
  ['洋芋', '土豆'],
  /*
   * 挂面/面条：库里两条都出现，指的是同一件要买的东西（干面条）。
   * 这一对是**我自己判断**加上来的，不是照抄服务端那份表——
   * 加它的原因是第一版漏了，于是"只差 挂面"（服务端归一到挂面）与
   * "真实缺 面条"（我这份没归一）对不上，红的是我的核对而不是代码。
   * 独立核对的"独立"指**不复用服务端那份规则**，不表示可以写得比它粗糙。
   */
  ['面条', '挂面'],
  ['鲜面条', '挂面'],
])

function plainName(raw) {
  const text = String(raw ?? '')
    // 括号里的补充说明（"番茄（大）"）
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, '')
    // 数字与跟随其后的单位（"1个"、"500克"、"2茶勺"）
    .replace(/[0-9０-９]+\s*[个只条根颗棵克gG斤两片块袋盒包把勺碗杯升毫升mlML寸朵瓣头束]*/g, '')
    // 末尾的用量词（"盐 少许"、"鸡精 少许"——库里真的有这种写法，名字里就带着量）
    .replace(/\s+(少许|适量|若干|多点|一点点|一把|一小把)$/g, '')
    // 切法（末/丝/丁/片/块/段/条/粒/蓉/泥/馅）：不影响"是不是同一样东西"
    .replace(/(末|碎|沫|丝|丁|片|块|段|条|粒|蓉|泥|馅)$/g, '')
    .trim()
  // 名字里带空格的（"豆芽 一把"）：取前半段
  return text.split(/\s+/)[0] ?? text
}

function key(raw) {
  const base = plainName(raw)
  return ALIAS.get(base) ?? base
}

const isSeasoning = (raw) => SEASONINGS.has(plainName(raw))

/** 冰箱里都有什么名字（走列表接口自己拼，不用服务端给的 pantry 之类的现成结论） */
async function fridgeNames(token) {
  const board = await callWithRetry('GET', '/fridge', { token })
  if (board.status !== 200) throw new Error(`读冰箱失败：${board.status}`)
  const names = (board.body?.zones ?? []).flatMap((zone) => (zone.items ?? []).map((item) => item.name))
  return names
}

/** 这道菜**非调料**的配料（同一个小表剥一遍） */
async function realIngredients(recipeId) {
  const detail = await callWithRetry('GET', `/recipes/${recipeId}`)
  if (detail.status !== 200) throw new Error(`读菜谱失败（${recipeId}）：${detail.status}`)
  return (detail.body?.ingredients ?? [])
    .map((item) => String(item.name ?? '').trim())
    .filter((name) => name !== '' && !isSeasoning(name))
}

/** 挑一道菜（`exclude` 由调用方攒着） */
const decide = (token, exclude = []) =>
  callWithRetry('GET', `/discover/decide${exclude.length ? `?exclude=${exclude.join(',')}` : ''}`, { token })

async function main() {
  await settleThrottleWindow()

  // ---------- 未登录 / 没家庭 ----------

  const anonymous = await callWithRetry('GET', '/discover/decide')
  check('未登录问它要主意：401', anonymous.status === 401, `status=${anonymous.status}`)

  const mama = await newUser('帮我决定·妈')
  const noFamily = await decide(mama.token)
  check('没加入家庭：404（"家里的事"得先有家）', noFamily.status === 404, `status=${noFamily.status}`)

  // ---------- 空冰箱：挑得出菜，但**明说没照冰箱挑** ----------

  const family = await newFamily(mama.token, '帮我决定之家')

  const fresh = await decide(mama.token)
  const freshBody = fresh.body
  check(
    '空冰箱也能给一个主意（库里 600 道，不该说"挑不出来"）',
    fresh.status === 200 && freshBody?.recipe?.id,
    `status=${fresh.status} name=${freshBody?.recipe?.name}`,
  )
  check(
    '**冰箱空时明说这次没照冰箱挑**（`fridgeEmpty`）：不说的话用户会以为它看过冰箱了',
    freshBody?.fridgeEmpty === true,
    `fridgeEmpty=${freshBody?.fridgeEmpty}`,
  )
  check(
    '**一条真信号都没有时不编理由**：明说"库里挑的"',
    freshBody?.reason === '库里挑的，今天换换口味',
    `reason=${JSON.stringify(freshBody?.reason)}`,
  )
  check(
    '空冰箱时不许出现"用上了…"（一样东西都没有，能用上什么）',
    (freshBody?.recipe?.have ?? ['非空']).length === 0,
    `have=${JSON.stringify(freshBody?.recipe?.have)}`,
  )

  /*
   * 「冰箱里只有调料」这一档：**调料不进比对**，所以此时它仍然只能走"库里挑的"。
   * 这是反证的靶子之一——要是哪天把调料也当成"手边有的东西"，这句话立刻就会变。
   */
  const saltFamily = await newUser('帮我决定·只有调料')
  await newFamily(saltFamily.token, '只有调料之家')
  await stock(saltFamily.token, '盐', '1袋')
  await stock(saltFamily.token, '食用油', '1瓶')
  const salted = await decide(saltFamily.token)
  check(
    '**冰箱里只有调料时绝不说"用上了冰箱里的…"**（调料两边都跳过）',
    salted.body?.recipe !== null && !String(salted.body?.reason ?? '').includes('冰箱里的'),
    `reason=${JSON.stringify(salted.body?.reason)}`,
  )

  // ---------- 记了番茄与鸡蛋：能挑出"一样都不用买"的那道 ----------

  await stock(mama.token, '番茄', '2个')
  await stock(mama.token, '鸡蛋', '6个')

  const exclude = []
  const seenDishes = []
  /** 凡是说了"正好能做这道"的那些，都要被独立核对过（不然这条守卫可能是空着的） */
  const verifiedReady = []

  for (let round = 0; round < 8; round += 1) {
    const response = await decide(mama.token, exclude)
    const dish = response.body?.recipe
    if (!dish) throw new Error(`第 ${round + 1} 次没挑出菜：${JSON.stringify(response.body)}`)
    // 换一道不会换回同一道
    if (exclude.includes(dish.id)) {
      check(`第 ${round + 1} 次**换回了已经看过的**（exclude 没生效）`, false, `id=${dish.id}`)
    }
    seenDishes.push(dish)
    exclude.push(dish.id)

    const reason = String(response.body?.reason ?? '')
    /*
     * 只核对**"正好能做这道"**的那些（那是最强的一句话，说错代价最大）。
     * `near` 档的话是"能用上 …；只差 …"，故意**不**出现在这里——
     * 第一版把两种混为一谈，于是"缺干海木耳"的那道也被按 ready 核对，
     * 红的是我的判据而不是代码（它压根没声称能做）。
     */
    const claimsReady = reason.includes('正好能做这道')
    if (!claimsReady) continue

    /*
     * 独立核对：拿**真实配料表**（自己重新取）对一遍冰箱里的名字。
     * 只要有一道非调料配料不在冰箱里，这句话就是假的——**这条断言能失败**
     * （把 `matchDish` 的 missing 判断去掉就会红）。
     */
    const names = await fridgeNames(mama.token)
    const pantry = new Set(names.map(key))
    const need = await realIngredients(dish.id)
    const absent = need.filter((name) => !pantry.has(key(name)))
    check(
      `独立核对："正好能做这道"（${dish.name}）的配料**真的**都在冰箱里`,
      absent.length === 0,
      absent.length === 0 ? `配料=${need.join('、')}｜冰箱=${names.join('、')}` : `冰箱里没有：${absent.join('、')}`,
    )
    verifiedReady.push({ id: dish.id, name: dish.name, need, have: dish.have })
  }

  /*
   * `near` 档那句话也要核一遍（"能用上 …；只差 X"）：它说的 X 必须是**真的缺**的那一样，
   * 而且只能是**一样**（差两样还说"顺路买一下"就是骗人）。
   */
  const nearExclude = []
  let nearChecked = 0
  for (let round = 0; round < 8; round += 1) {
    const response = await decide(mama.token, nearExclude)
    const dish = response.body?.recipe
    if (!dish) break
    nearExclude.push(dish.id)
    const reason = String(response.body?.reason ?? '')
    if (!reason.includes('只差')) continue
    const need = await realIngredients(dish.id)
    const names = await fridgeNames(mama.token)
    const pantry = new Set(names.map(key))
    const absent = [...new Set(need.filter((name) => !pantry.has(key(name))).map(key))]
    const claimed = (dish.missing ?? []).map(key)
    check(
      `独立核对："只差 ${dish.missing.join('、')}"（${dish.name}）**确实只差这些**`,
      absent.length === 1 && claimed.length === 1 && absent[0] === claimed[0],
      `它说差=${claimed.join('、')}｜真实缺=${absent.join('、') || '（一样都不缺）'}`,
    )
    nearChecked += 1
    if (nearChecked >= 2) break
  }
  check(
    '**"差一样"这一档真的出现了**，上面那条核对不是空跑',
    nearChecked >= 1,
    `核对了 ${nearChecked} 道 near 档`,
  )

  check(
    '把"正好能做"的那道挑出来了（记了番茄鸡蛋之后，至少一次落在 ready 档）',
    verifiedReady.length > 0,
    verifiedReady.length > 0
      ? verifiedReady.map((item) => `${item.name}（用上 ${item.have.join('、')}）`).join('；')
      : `8 次都没出现 ready 档：${seenDishes.map((dish) => `${dish.name}[${dish.missing.length}缺]`).join('、')}`,
  )
  check(
    '**"换一道"真会换**：连着 8 次至少给出 3 道不同的菜（每次都给同一道 = 按钮看起来是坏的）',
    new Set(seenDishes.map((dish) => dish.id)).size >= 3,
    `不同菜数=${new Set(seenDishes.map((dish) => dish.id)).size}：${seenDishes.map((dish) => dish.name).join('、')}`,
  )
  check(
    '`exclude` 全都在这一轮被排除了：没有一次换回看过的',
    seenDishes.every((dish, index) => seenDishes.slice(0, index).every((prev) => prev.id !== dish.id)),
    `id 序列=${seenDishes.map((dish) => dish.id).join(',')}`,
  )
  check(
    '`recipe.missing` 里不许出现调料（否则每道菜都差盐油）',
    seenDishes.every((dish) => (dish.missing ?? []).every((name) => !isSeasoning(name))),
    seenDishes.flatMap((dish) => dish.missing ?? []).join('、') || '（没有缺的）',
  )

  // ---------- 排到没有为止：不许回一句"没有了" ----------

  const catalog = await callWithRetry('GET', '/recipes?pageSize=20')
  const twentyIds = (catalog.body?.items ?? []).map((item) => item.id).slice(0, 20)
  if (twentyIds.length < 20) throw new Error('菜谱库不足 20 道，无法验"排空"')
  const saturated = await decide(mama.token, twentyIds)
  check(
    '把 20 道都排除掉之后**仍然给一道**（宁可重复，也不回"没有了"——库里有几百道，那个答案只能是 bug）',
    Boolean(saturated.body?.recipe?.id),
    `status=${saturated.status} name=${saturated.body?.recipe?.name ?? '（空）'}`,
  )

  // ---------- 口味过滤：有人对鸡蛋过敏时，一道含鸡蛋的都不许挑出来 ----------

  const eggFamily = await newUser('帮我决定·不吃蛋')
  await newFamily(eggFamily.token, '不吃蛋之家')
  await stock(eggFamily.token, '番茄', '2个')
  await stock(eggFamily.token, '鸡蛋', '6个')
  const allergy = await callWithRetry('PATCH', '/taste', {
    token: eggFamily.token,
    body: { allergies: ['鸡蛋'] },
  })
  if (allergy.status !== 200) throw new Error(`配口味档案失败：${allergy.status} ${JSON.stringify(allergy.body)}`)

  const eggExclude = []
  const eggSeen = []
  let withEgg = 0
  for (let round = 0; round < 10; round += 1) {
    const response = await decide(eggFamily.token, eggExclude)
    const dish = response.body?.recipe
    if (!dish) {
      check('过敏过滤把**所有**候选都排掉了（连一道都不给）', false, JSON.stringify(response.body))
      break
    }
    eggSeen.push(dish)
    eggExclude.push(dish.id)
    // 独立核对：这道菜真实的配料里有没有鸡蛋
    const need = await realIngredients(dish.id)
    if (need.some((name) => name.includes('鸡蛋') || name.includes('蛋'))) withEgg += 1
  }
  check(
    '**有人对鸡蛋过敏时，挑出来的 10 道一道都不含鸡蛋**（独立按配料表核对）',
    withEgg === 0,
    withEgg === 0 ? `10 道：${eggSeen.map((dish) => dish.name).join('、')}` : `有 ${withEgg} 道含蛋`,
  )
  check(
    '**正对照：过滤不是"把功能关掉"**（10 次都真的挑出了菜，不是全被排空）',
    eggSeen.length === 10,
    `挑出 ${eggSeen.length} 道`,
  )

  // ---------- 共享关掉：只算自己的 ----------

  /*
   * 用**吃货**（后加入、role 是 MEMBER）验这件事：掌勺人（OWNER）关掉共享后仍看全量
   * （他要负责买菜，见 orders.rules 的 visibleToMember）。第一版拿 mama 自己验，
   * 于是 scope 永远是 family——红的是我的角色选错了，不是代码。
   *
   * 顺带验"共享开着时他能看见妈妈记的冰箱"，这样"关掉之后看不到了"才是一条真变化。
   */
  const eater = await newUser('帮我决定·吃货')
  await callWithRetry('POST', '/family/join', { token: eater.token, body: { inviteCode: family.inviteCode } })
  const beforeOff = await decide(eater.token)
  check(
    '共享开着时：吃货也照**全家**的冰箱挑（scope=family）',
    beforeOff.body?.scope === 'family',
    `scope=${beforeOff.body?.scope} reason=${JSON.stringify(beforeOff.body?.reason)}`,
  )

  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  check('关掉共享成功', sharedOff.status === 200, `status=${sharedOff.status}`)
  const mine = await decide(eater.token)
  check(
    '共享关掉后：吃货的主意只按**自己的**算（scope=mine；妈妈记的番茄鸡蛋不算他的）',
    mine.body?.scope === 'mine',
    `scope=${mine.body?.scope} reason=${JSON.stringify(mine.body?.reason)} have=${JSON.stringify(mine.body?.recipe?.have)}`,
  )
  check(
    '**而掌勺人关掉共享后仍看全量**（他要负责买菜做饭）',
    (await decide(mama.token)).body?.scope === 'family',
    `scope=${(await decide(mama.token)).body?.scope}`,
  )

  // ---------- 汇总 ----------

  console.log('')
  for (const result of results) {
    console.log(`${result.ok ? '✅' : '❌'} ${result.name}`)
    if (result.detail) console.log(`     ${result.detail}`)
  }
  console.log('')
  console.log(`${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('验收脚本自身出错：', error)
  process.exitCode = 1
})
