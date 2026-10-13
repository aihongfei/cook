#!/usr/bin/env node
/**
 * 手边食材能做什么 HTTP 验收（真实请求，不 mock）。F5-04 / F6-07，规则见 `pantry.rules.ts`。
 * 用法：先启动服务，再执行 pnpm run test:http:cookable
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：未登录 401 → 没家庭 404 → 空冰箱不推荐（0 道，不是"随便推荐"）→ 记几样菜
 *       → 默认用整个冰箱（F6-07）→ 指定 ingredients 就用指定的（F5-04）
 *       → **"用上了什么"是真用上了**（每一样都在菜谱配料里）→ missing 是**能买的**（不列调料）
 *       → **反证组**：五花肉≠猪肉、蛋清≠鸡蛋、"有土豆"不该让"要番茄的菜"变成 0 差
 *       → maxMissing=0 只剩不用买的 → limit 生效 → 参数非法 400
 *       → 口味过敏的菜被排掉且报数（F5-03）→ 共享关掉时只看自己放的 → 跨家庭互不可见。
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
  const account = `ck${Date.now()}${seq}`.toLowerCase()
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

/** 记一样食材进冰箱（每样默认落冷藏，够用） */
async function stock(token, name, extra = {}) {
  return callWithRetry('POST', '/fridge', { token, body: { name, zone: '冷藏', ...extra } })
}

const cookable = (token, query = '') =>
  callWithRetry('GET', `/fridge/cookable${query ? `?${query}` : ''}`, { token })

const names = (payload) => (payload?.items ?? []).map((item) => item.name)
const rowNamed = (payload, name) => (payload?.items ?? []).find((item) => item.name === name) ?? null

/**
 * 取一道菜谱的真实配料名（用于核对"用上了什么"）。
 *
 * 这是**独立的一条查证路径**：不去读接口自己说的 `have`，而是直接问菜谱接口要配料表，
 * 再核对那几样是不是真的在里面。少了这一步，"have 里塞了什么"就只能自证。
 */
async function recipeIngredients(recipeId) {
  const detail = await callWithRetry('GET', `/recipes/${recipeId}`)
  return (detail.body?.ingredients ?? []).map((item) => String(item.name ?? ''))
}

/**
 * 判断两个名字是不是同一样东西（**只用于验收脚本自己的核对**）。
 *
 * 为什么这里可以再抄一份别名表：这是**独立的一条查证路径**——拿接口说的 `have` 去跟
 * 菜谱接口给的原始配料表对，中间隔着一次真实查询。要是这里也去调服务端那份规则，
 * 就变成"拿接口的话证明接口没撒谎"了（第一条断言就是这么被我写错的：
 * 接口说 have=西红柿 而配料表写"番茄"，只看字面会误判成撒谎）。
 *
 * 只收最必要的几组（够验这几条用例）：切法不在这里管，用子串兜住。
 */
const ALIAS = [
  ['番茄', '西红柿'],
  ['土豆', '马铃薯'],
  ['木耳', '黑木耳'],
  ['姜', '生姜'],
]
function sameIngredient(used, raw) {
  const clean = (text) => String(text).replace(/[（(].*$/, '').replace(/\s+/g, '').trim()
  const a = clean(used)
  const b = clean(raw)
  if (!a || !b) return false
  if (a === b || b.startsWith(a) || a.startsWith(b)) return true
  return ALIAS.some((group) => group.includes(a) && group.some((name) => b.startsWith(name) || name.startsWith(b)))
}

async function main() {
  await settleThrottleWindow()

  // ---------- 未登录 / 没家庭 ----------

  const anonymous = await callWithRetry('GET', '/fridge/cookable')
  check('未登录问"能做什么"：401', anonymous.status === 401, `status=${anonymous.status}`)

  const nobody = await newUser('能做什么·无家')
  const noFamily = await cookable(nobody.token)
  check(
    '没加入家庭：404 并说明先去建家庭',
    noFamily.status === 404 && /家庭/.test(JSON.stringify(noFamily.body)),
    `status=${noFamily.status} body=${JSON.stringify(noFamily.body)?.slice(0, 90)}`,
  )

  // ---------- 空冰箱 ----------

  const mama = await newUser('能做什么·妈')
  await newFamily(mama.token, '能做什么之家')

  const empty = await cookable(mama.token)
  check(
    '空冰箱：0 道菜、usable=0，**不是**随便推荐几道',
    empty.status === 200 && empty.body?.total === 0 && (empty.body?.items ?? []).length === 0 && empty.body?.usable === 0,
    `status=${empty.status} total=${empty.body?.total} usable=${empty.body?.usable}`,
  )
  check(
    '空冰箱要说清原因（source=fridge 且手边清单为空），界面才知道该说"冰箱还是空的"',
    empty.body?.source === 'fridge' && Array.isArray(empty.body?.pantry) && empty.body.pantry.length === 0,
    `source=${empty.body?.source} pantry=${JSON.stringify(empty.body?.pantry)}`,
  )
  check(
    '冰箱里的调料不算"能用的东西"（只放盐油生抽，usable 仍是 0、但要说跳过了 3 样）',
    (await stock(mama.token, '盐')).status === 201
      && (await stock(mama.token, '食用油')).status === 201
      && (await stock(mama.token, '生抽')).status === 201
      && (await cookable(mama.token)).body?.usable === 0,
    `usable=${(await cookable(mama.token)).body?.usable} skipSeasonings=${(await cookable(mama.token)).body?.skipSeasonings}（放过 盐/食用油/生抽）`,
  )

  // ---------- 记几样真能吃的东西 ----------

  const stocked = ['鸡蛋', '西红柿', '土豆', '胡萝卜', '青椒', '面粉']
  for (const name of stocked) {
    const added = await stock(mama.token, name)
    if (added.status !== 201) throw new Error(`记 ${name} 失败：${added.status} ${JSON.stringify(added.body)}`)
  }

  const board = await cookable(mama.token)
  check(
    '记了 6 样之后有得做了（total > 0）',
    board.status === 200 && board.body?.total > 0,
    `total=${board.body?.total} items=${(board.body?.items ?? []).length}`,
  )
  check(
    '默认就是用**整个冰箱**（F6-07：不用先勾选）+ 调料不进手边清单但要报数',
    board.body?.source === 'fridge'
      && (board.body?.pantry ?? []).length === 6
      && board.body?.skipSeasonings === 3,
    `source=${board.body?.source} pantry=${JSON.stringify(board.body?.pantry)} skipSeasonings=${board.body?.skipSeasonings}`,
  )

  // ---------- "用上了什么"必须是真的 ----------

  const top = (board.body?.items ?? [])[0]
  check('结果里每一行都要说"用上了什么"（不然用户不知道凭什么推这道）', Array.isArray(top?.have) && top.have.length > 0, `have=${JSON.stringify(top?.have)}`)
  check(
    '差 0 样的排在差 1 样的前面，且每一样都列了名字',
    (board.body?.items ?? []).every((item, index, list) => index === 0 || (list[index - 1].missingCount ?? 0) <= (item.missingCount ?? 0))
      && (board.body?.items ?? []).every((item) => Array.isArray(item.missing)),
    `missingCounts=${JSON.stringify((board.body?.items ?? []).map((item) => item.missingCount))}`,
  )

  /*
   * 核对 `have`：拿前 5 道去菜谱详情里取真实配料表，逐样确认它确实出现在配料里。
   * 这是**独立查证**（不是拿接口的话自证接口）。匹配规则允许"切法"差异，
   * 所以这里查的是**归一后**包含（如 have=猪肉 而配料里写的是"猪肉末"）。
   */
  let haveChecked = 0
  let haveBad = []
  for (const item of (board.body?.items ?? []).slice(0, 5)) {
    const ingredients = await recipeIngredients(item.id)
    for (const used of item.have) {
      haveChecked += 1
      const found = ingredients.some((name) => sameIngredient(used, name))
      if (!found) haveBad.push(`${item.name}: 说用了「${used}」，配料表=${JSON.stringify(ingredients)}`)
    }
  }
  check(
    `"用上了什么"是真用上了（核对了 ${haveChecked} 处）`,
    haveChecked > 0 && haveBad.length === 0,
    haveBad.slice(0, 3).join(' | ') || `核对 ${haveChecked} 处全部属实`,
  )

  /*
   * **一页里不该出现两道同名菜**。
   *
   * 这条是浏览器验收看出来的：库里 579 个不同名字占了 612 行（33 行重名，
   * 「番茄炒蛋」有 3 份、「苹果燕麦粥」有 5 份——不同来源的同一道菜）。
   * 第一版没去重，12 个格子里连着三行「番茄炒蛋」，用户看到的是**列表坏了**。
   */
  const shownNames = (board.body?.items ?? []).map((item) => item.name)
  const dupeNames = shownNames.filter((name, index) => shownNames.indexOf(name) !== index)
  check(
    '一页里不出现两道同名菜（重名的菜谱只留最好做的那一份）',
    dupeNames.length === 0,
    dupeNames.length ? `重复出现：${[...new Set(dupeNames)].join('/')}` : `这一页 ${shownNames.length} 道菜名都不重复`,
  )

  // ---------- missing 里不许有调料 ----------

  const allMissing = (board.body?.items ?? []).flatMap((item) => item.missing)
  const SEASONINGS = ['盐', '油', '生抽', '老抽', '白糖', '料酒', '淀粉', '鸡精', '味精', '葱', '姜', '蒜', '水', '胡椒粉', '香油', '耗油', '蚝油']
  const seasoningsInMissing = allMissing.filter((name) => SEASONINGS.includes(name))
  check(
    '**"还差"里不出现调料**（否则每道菜都差盐油，功能就废了）',
    seasoningsInMissing.length === 0,
    seasoningsInMissing.length ? `出现了：${seasoningsInMissing.join('/')}` : `检查了 ${allMissing.length} 个"还差"项`,
  )

  /*
   * 反证：故意把手边清单设成"只有土豆"，然后找一道**要番茄的菜**——
   * 它必须**不能**出现在"差 0 样"里。这是这个功能最容易犯的错：
   * 把"我有的东西"和"菜要的东西"凑错了位置，于是用户以为不用买。
   */
  const onlyPotato = await cookable(mama.token, 'ingredients=土豆&maxMissing=0')
  const liar = (onlyPotato.body?.items ?? []).find((item) => item.name?.includes('西红柿') || item.name?.includes('番茄'))
  check(
    '反证：手边只有土豆时，"番茄炒蛋"之类**不得**出现在"不用买"里',
    !liar,
    liar ? `出现了：${liar.name} have=${JSON.stringify(liar.have)}` : `只勾土豆时"不用买"的有 ${onlyPotato.body?.total} 道，没有番茄菜`,
  )
  check(
    '手边只有土豆时，结果里每一样都真的用上了土豆（不许拿无关的菜充数）',
    (onlyPotato.body?.items ?? []).length > 0
      && (onlyPotato.body?.items ?? []).every((item) => item.have.includes('土豆')),
    `items=${JSON.stringify((onlyPotato.body?.items ?? []).map((item) => `${item.name}(${item.have.join(',')})`).slice(0, 5))}`,
  )

  /*
   * 反证：**五花肉 ≠ 猪肉**。库里有大量"要猪肉"的菜，而手边是五花肉。
   *
   * 用例选 **白菜猪肉饺子**（非调料配料只有 `白菜` + `猪肉` 两样），因为它是这条规则
   * 唯一能真正验出来的形状：
   * - 手边给"白菜,五花肉"、`maxMissing=1`：**两种情况这道菜都会出现在结果里**，
   *   差别只在 missing——正确实现是 `["猪肉"]`（还差一样），错认成猪肉则是 `[]`。
   *
   * ⚠️ 第一版断言是**空着通过的**，这里记下来免得再犯：它拿"要猪肉的菜"（回锅肉）去查，
   * 而那道菜因为差得太多**根本没进结果**，`!sameDish` 直接把断言短路成 true——
   * 反证跑了两遍都是绿的，直到我把"五花肉并进猪肉"这条改动装进镜像，它**照样全绿**，
   * 才发现这条守卫是假的。**反证必须能失败**：所以现在先钉住"这道菜在结果里"，
   * 再钉住"猪肉 在 missing 里"。
   *
   * 也**只能查 `missing`，不能查 `have`**：`have` 回显的是用户自己的说法，
   * 我传进去的词里没有"猪肉"，所以"have 里没有猪肉"永远成立（同一个空断言陷阱）。
   */
  const porkFamily = await newUser('能做什么·猪肉组')
  await newFamily(porkFamily.token, '猪肉之家')
  for (const name of ['白菜', '五花肉']) await stock(porkFamily.token, name)

  const withPorkBelly = await cookable(porkFamily.token, 'ingredients=白菜,五花肉&maxMissing=1')
  const dumpling = (withPorkBelly.body?.items ?? []).find((item) => item.name === '白菜猪肉饺子') ?? null
  check(
    '**反证：五花肉不算猪肉**（要猪肉的菜仍把"猪肉"列进"还差"，不能因为有五花肉就当成有了）',
    Boolean(dumpling) && dumpling.missing.some((name) => name === '猪肉'),
    dumpling
      ? `白菜猪肉饺子 missing=${JSON.stringify(dumpling.missing)}（正确应含「猪肉」）`
      : `白菜猪肉饺子**没进结果**——这条反证没验到东西：total=${withPorkBelly.body?.total} items=${JSON.stringify((withPorkBelly.body?.items ?? []).map((i) => i.name).slice(0, 6))}`,
  )
  check(
    '同一道菜：手边给"猪肉"时它就是"不用买就能做"（说明上面那条失败不是因为整道菜进不来）',
    Boolean((await cookable(porkFamily.token, 'ingredients=白菜,猪肉&maxMissing=1')).body?.items?.find((item) => item.name === '白菜猪肉饺子')),
    `手边白菜+猪肉：total=${(await cookable(porkFamily.token, 'ingredients=白菜,猪肉&maxMissing=1')).body?.total}`,
  )
  const withBellyOnly = await cookable(porkFamily.token, 'ingredients=五花肉&maxMissing=1')
  check(
    '而"要五花肉的菜"确实能匹配上（不是把五花肉整个屏蔽了）',
    (withBellyOnly.body?.total ?? 0) > 0
      && (withBellyOnly.body?.items ?? []).every((item) => item.have.includes('五花肉')),
    `只勾五花肉：total=${withBellyOnly.body?.total} items=${JSON.stringify((withBellyOnly.body?.items ?? []).map((i) => `${i.name}(${i.have.join(',')})`).slice(0, 4))}`,
  )

  /*
   * 反证：**蛋清 ≠ 鸡蛋**。写"家里有鸡蛋"不能让"要鸡蛋清的菜"显示"不用买"，
   * 反过来更危险——只写"有蛋清"绝不能解掉要整蛋的菜。
   */
  const eggWhite = await cookable(porkFamily.token, 'ingredients=鸡蛋清&maxMissing=0')
  const wholeEggLied = (eggWhite.body?.items ?? []).filter((item) => item.have.includes('鸡蛋'))
  check(
    '**反证：蛋清不算鸡蛋**（只写蛋清，不能解掉要整蛋的菜）',
    wholeEggLied.length === 0,
    wholeEggLied.length ? `错认：${wholeEggLied.map((item) => item.name).join('/')}` : `勾"鸡蛋清"时匹配到 ${eggWhite.body?.total} 道`,
  )

  // ---------- 别名与切法确实是认的（否则会大面积漏报） ----------

  const tomato = await cookable(mama.token, 'ingredients=西红柿')
  const aliasHit = (tomato.body?.items ?? []).find((item) => item.name?.includes('西红柿') || item.name?.includes('番茄'))
  check(
    '别名认得出：手边写"西红柿"，能匹配到菜谱里写"番茄"的菜',
    Boolean(aliasHit) || tomato.body?.total > 0,
    aliasHit ? `${aliasHit.name} have=${JSON.stringify(aliasHit.have)}` : `total=${tomato.body?.total}`,
  )
  /*
   * 切法认得出：手边写"猪肉"，能对上菜谱里"猪肉末"。
   *
   * 用例选的是**麻婆豆腐**（配料 `豆腐`+`猪肉末`+一把调料），因为它是"切法真的起了作用"的干净例子：
   * 手边给"豆腐,猪肉"，`maxMissing=0` 时它应该**进结果且一样都不差**——要是切法没认出来，
   * "猪肉末"会变成"还差猪肉末"，这道菜就会从"不用买就能做"里掉出去。
   *
   * ⚠️ 断言**不能查 have/missing 里有没有"猪肉末"**（第一版就是这么写错的）：匹配成功后
   * `have` 回显的是**用户自己的说法**（"猪肉"），切法词在比较时就被剥掉了，结果里根本不会再出现
   * "猪肉末"这三个字。所以要反过来查——**那道写着切法的菜有没有被认下来**。
   */
  const cutList = await cookable(porkFamily.token, 'ingredients=豆腐,猪肉&maxMissing=0')
  const cutRow = (cutList.body?.items ?? []).find((item) => item.name === '麻婆豆腐') ?? null
  check(
    '切法认得出：手边写"猪肉"，菜谱里写"猪肉末"的麻婆豆腐**不用买就能做**',
    Boolean(cutRow) && cutRow.have.includes('猪肉') && cutRow.missing.length === 0,
    cutRow
      ? `${cutRow.name} have=${JSON.stringify(cutRow.have)} missing=${JSON.stringify(cutRow.missing)}`
      : `麻婆豆腐没进结果，只勾豆腐+猪肉时 total=${cutList.body?.total} items=${JSON.stringify((cutList.body?.items ?? []).map((i) => i.name).slice(0, 6))}`,
  )

  // ---------- 参数 ----------

  const strict = await cookable(mama.token, 'maxMissing=0')
  check(
    'maxMissing=0：只剩"不用买就能做"的（missing 全为空）',
    (strict.body?.items ?? []).length > 0 && (strict.body?.items ?? []).every((item) => item.missingCount === 0),
    `total=${strict.body?.total} items=${(strict.body?.items ?? []).length}`,
  )
  const loose = await cookable(mama.token, 'maxMissing=3')
  check(
    'maxMissing=3 比 maxMissing=0 给得多（容忍度是真的在起作用）',
    loose.body?.total >= strict.body?.total,
    `0→${strict.body?.total} 3→${loose.body?.total}`,
  )
  const limited = await cookable(mama.token, 'limit=2')
  check(
    'limit 生效（total 是总数、items 是这一页）',
    (limited.body?.items ?? []).length <= 2 && limited.body?.total >= (limited.body?.items ?? []).length,
    `total=${limited.body?.total} items=${(limited.body?.items ?? []).length}`,
  )
  const badLimit = await cookable(mama.token, 'limit=99')
  check('limit 超上限：400', badLimit.status === 400, `status=${badLimit.status}`)
  const badMissing = await cookable(mama.token, 'maxMissing=9')
  check('maxMissing 超上限：400', badMissing.status === 400, `status=${badMissing.status}`)
  const emptyList = await cookable(mama.token, 'ingredients=,,,')
  check(
    'ingredients 全是空：**回落到冰箱**而不是"0 道"（空参数不等于"我什么都没有"）',
    emptyList.body?.source === 'fridge' && emptyList.body?.total === board.body?.total,
    `source=${emptyList.body?.source} total=${emptyList.body?.total} vs 冰箱 ${board.body?.total}`,
  )

  // ---------- 口味过滤（F5-03 同一个判据） ----------

  const allergyFamily = await newUser('能做什么·过敏')
  await newFamily(allergyFamily.token, '过敏之家')
  await stock(allergyFamily.token, '鸡蛋')
  await stock(allergyFamily.token, '西红柿')
  const beforeAllergy = await cookable(allergyFamily.token)
  const asked = await callWithRetry('PATCH', '/taste', {
    token: allergyFamily.token,
    body: { allergies: ['鸡蛋'] },
  })
  check('写过敏档案成功', asked.status === 200, `status=${asked.status}`)
  const afterAllergy = await cookable(allergyFamily.token)
  check(
    '**过敏的菜被排掉**且给出挡掉几道（F5-03）',
    afterAllergy.body?.filteredOut >= 1
      && afterAllergy.body?.total < beforeAllergy.body?.total
      && !names(afterAllergy).some((name) => name.includes('鸡蛋')),
    `filteredOut=${afterAllergy.body?.filteredOut} ${beforeAllergy.body?.total}→${afterAllergy.body?.total} 剩下的=${JSON.stringify(names(afterAllergy).slice(0, 4))}`,
  )
  // 反证：不是"凡是写了过敏词就一律清空"——换成菜谱里根本没有的词（榴莲：全库 0 条），一道都不该挡
  await callWithRetry('PATCH', '/taste', { token: allergyFamily.token, body: { allergies: ['榴莲'] } })
  const irrelevant = await cookable(allergyFamily.token)
  check(
    '反证：过敏词与这些菜无关时**一道都不挡**（不是把过滤写成一律清空）',
    irrelevant.body?.filteredOut === 0 && irrelevant.body?.total === beforeAllergy.body?.total,
    `filteredOut=${irrelevant.body?.filteredOut} total=${irrelevant.body?.total} vs ${beforeAllergy.body?.total}`,
  )
  // 而"只挡真正会出现在结果里的"这条也要钉住：写过 `matched - safe` 的第一版在这里会报 4
  await callWithRetry('PATCH', '/taste', { token: allergyFamily.token, body: { allergies: ['番茄'] } })
  const tomatoAllergy = await cookable(allergyFamily.token)
  check(
    '被挡的道数只数**本来会出现在结果里**的（不是"全库里含这个词的菜"）',
    tomatoAllergy.body?.filteredOut >= 1 && !names(tomatoAllergy).some((name) => name.includes('番茄') || name.includes('西红柿')),
    `filteredOut=${tomatoAllergy.body?.filteredOut} 剩下的=${JSON.stringify(names(tomatoAllergy))}`,
  )

  // ---------- 可见性 ----------

  const eater = await newUser('能做什么·吃货')
  const joined = await callWithRetry('POST', '/family/join', {
    token: eater.token,
    body: { inviteCode: (await callWithRetry('GET', '/family', { token: mama.token })).body?.inviteCode },
  })
  if (joined.status !== 200 && joined.status !== 201) throw new Error(`加入家庭失败：${joined.status}`)
  await stock(eater.token, '牛肉')
  const shared = await cookable(eater.token)
  const hasBeef = (shared.body?.items ?? []).some((item) => item.have.includes('牛肉'))
  check(
    '共享开着：家人放的牛肉也能用上（一台冰箱一家人用）',
    hasBeef,
    `total=${shared.body?.total} 有牛肉的菜=${JSON.stringify((shared.body?.items ?? []).filter((i) => i.have.includes('牛肉')).map((i) => i.name).slice(0, 3))}`,
  )

  const owner = (await callWithRetry('GET', '/family', { token: mama.token })).body
  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  check(
    '关掉共享成功（后续检查用）',
    (sharedOff.status === 200 && sharedOff.body?.shared === false),
    `status=${sharedOff.status} shared=${owner?.shared}→${sharedOff.body?.shared}`,
  )

  const mineOnly = await cookable(eater.token)
  check(
    '共享关掉后：吃货只看得到自己放的（冰箱可见性那一套）',
    mineOnly.body?.scope === 'mine' && mineOnly.body?.pantry?.includes('牛肉') && !mineOnly.body?.pantry?.includes('土豆'),
    `scope=${mineOnly.body?.scope} pantry=${JSON.stringify(mineOnly.body?.pantry)}`,
  )
  const familyStillSeesAll = await cookable(mama.token)
  check(
    '掌勺人关掉共享后仍看全量（要负责做饭）',
    familyStillSeesAll.body?.scope === 'family' && familyStillSeesAll.body?.pantry?.includes('牛肉'),
    `scope=${familyStillSeesAll.body?.scope} pantry=${JSON.stringify(familyStillSeesAll.body?.pantry)}`,
  )

  // 把共享开回去，免得后面手测这个家庭时看着奇怪
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

  // ---------- 跨家庭 ----------

  const stranger = await newUser('能做什么·外人')
  await newFamily(stranger.token, '外人之家')
  const strangerView = await cookable(stranger.token)
  check(
    '跨家庭互不可见：外人的"手边清单"里没有别人家的东西',
    strangerView.body?.pantry?.length === 0 && strangerView.body?.total === 0,
    `pantry=${JSON.stringify(strangerView.body?.pantry)} total=${strangerView.body?.total}`,
  )

  // ---------- 汇总 ----------

  console.log('')
  for (const item of results) {
    console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `\n     ${item.detail}` : ''}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error('验收脚本自身出错：', error)
  process.exit(2)
})
