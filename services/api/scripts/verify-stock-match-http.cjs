#!/usr/bin/env node
/**
 * 采购清单与库存比对的 HTTP 验收（真实请求，不 mock）。M7 / F7-02「只买缺的」，口径见 D-059。
 * 用法：先启动服务，再执行 pnpm run test:http:stock-match
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 这一份**自带菜单**（自己选两道真实菜谱加进某一餐并「选好了」），所以不依赖别的验收留下的数据。
 *
 * 覆盖：冰箱空时一句"家里有"都不编（每条都照买）→ 家里够的**从要买的里拿掉**
 *       → 家里不够的**给出还要买多少**（真减法）→ **单位对不上就算不清**（写"半罐"时不给数字）
 *       → **菜谱写"适量"也算不清** → **冰箱那侧没写量也算不清** → 别名/切法认得出（西红柿↔番茄、猪肉↔猪肉末）
 *       → **反证：五花肉不算猪肉**（要猪肉的菜仍列进"要买"）
 *       → 共享关掉时只用自己放的那些 → `stockEmpty` 与各计数自洽。
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
  const account = `sm${Date.now()}${seq}`.toLowerCase()
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

const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 记一样冰箱食材（同一个家庭里同名同区会 409，所以每样只用一次） */
async function stock(token, name, amount, zone = '冷藏') {
  return callWithRetry('POST', '/fridge', { token, body: { name, amount, zone } })
}

const list = (token, days = 3) => callWithRetry('GET', `/shopping-list?days=${days}`, { token })
const itemOf = (payload, name) => (payload?.items ?? []).find((item) => item.name === name) ?? null

/**
 * 找一道**只要 1～2 样非调料配料**的真实菜谱（这样它的采购条目少、断言好写）。
 *
 * 独立于被验的接口：直接搜菜谱列表、再取它的详情看配料。挑"配料少"的是为了让
 * 采购清单里那几样是可预期的。
 */
async function findSimpleRecipe(keyword, wantedName) {
  const found = await callWithRetry('GET', `/recipes?q=${encodeURIComponent(keyword)}`)
  const candidates = (found.body?.items ?? []).filter((item) => item.name?.includes(wantedName))
  for (const candidate of candidates) {
    const detail = await callWithRetry('GET', `/recipes/${candidate.id}`)
    const ingredients = (detail.body?.ingredients ?? []).map((item) => ({
      name: String(item.name ?? '').trim(),
      amount: String(item.amount ?? '').trim(),
    }))
    if (ingredients.length > 0) return { id: candidate.id, name: candidate.name, ingredients }
  }
  return null
}

/**
 * 把几道菜加进今天的晚餐并「选好了」——采购清单只认定了的菜单。
 *
 * **必须先全部加完再「选好了」**：这餐一变成 `PLANNED` 就不能再加菜了
 * （状态机刻意的，`canAddItem` 只放 PENDING/CANCELED）。第一版一道一确认，
 * 第二道就撞上 409「这餐已经"已安排"了」——那是接口对的，是我的脚本顺序错了。
 */
async function planDishes(token, recipeIds) {
  const mealDate = today()
  for (const recipeId of recipeIds) {
    const added = await callWithRetry('POST', '/orders/items', {
      token,
      // 契约是 `mealDate` + `meal` 两段，不是拼好的 `mealKey`（那个只用于 status 那条路由）
      body: { recipeId, mealDate, meal: 'DINNER' },
    })
    if (added.status !== 201 && added.status !== 200) {
      throw new Error(`加菜失败：${added.status} ${JSON.stringify(added.body)}`)
    }
  }
  const mealKey = `${mealDate}-DINNER`
  const settled = await callWithRetry('POST', `/orders/meals/${mealKey}/status`, {
    token,
    body: { status: 'PLANNED' },
  })
  if (settled.status !== 200) throw new Error(`「选好了」失败：${settled.status} ${JSON.stringify(settled.body)}`)
}

/** 只加一道的简写 */
const planDish = (token, recipeId) => planDishes(token, [recipeId])

async function main() {
  await settleThrottleWindow()

  // ---------- 未登录 / 没家庭 ----------

  const anonymous = await callWithRetry('GET', '/shopping-list')
  check('未登录看采购清单：401', anonymous.status === 401, `status=${anonymous.status}`)

  const mama = await newUser('只买缺的·妈')
  const noFamily = await list(mama.token)
  check('没加入家庭：404', noFamily.status === 404, `status=${noFamily.status}`)

  // ---------- 准备：两道真实菜谱进菜单 ----------

  const family = await newFamily(mama.token, '只买缺的之家')

  /*
   * 挑两道菜：一道「番茄炒蛋」（配料里必有番茄与鸡蛋）、一道「白菜猪肉饺子」（有猪肉）。
   * 都用真实菜谱，这样"要买什么"是数据说了算，而不是我编的。
   */
  const tomatoDish = await findSimpleRecipe('番茄炒蛋', '番茄炒蛋')
  const porkDish = (await findSimpleRecipe('白菜猪肉', '白菜猪肉饺子')) ?? (await findSimpleRecipe('饺子', '饺子'))
  if (!tomatoDish) throw new Error('库里没找到番茄炒蛋，无法验收')
  if (!porkDish) throw new Error('库里没找到饺子类菜谱，无法验收')

  await planDishes(mama.token, [tomatoDish.id, porkDish.id])

  // ---------- 冰箱空：一条"家里有"都不许编 ----------

  const empty = await list(mama.token)
  const emptyItems = empty.body?.items ?? []
  check(
    '冰箱空时：清单非空、但**每条都是"照买"**（不编"家里有"）',
    empty.status === 200
      && emptyItems.length > 0
      && emptyItems.every((item) => item.stock?.verdict === 'missing')
      && emptyItems.every((item) => item.stockLabel === null)
      && empty.body?.coveredCount === 0
      && empty.body?.stockEmpty === true,
    `items=${emptyItems.length} covered=${empty.body?.coveredCount} stockEmpty=${empty.body?.stockEmpty}`,
  )
  check(
    '`stockEmpty` 为真时说清"没替你扣掉什么"（界面据此给去记冰箱的入口）',
    empty.body?.stockEmpty === true,
    `stockEmpty=${empty.body?.stockEmpty}`,
  )

  // ---------- 家里够：从"要买的"里拿掉 ----------

  const eggItem = itemOf(empty.body, '鸡蛋')
  if (!eggItem) throw new Error(`番茄炒蛋的清单里没有鸡蛋：${JSON.stringify(emptyItems.map((i) => i.name))}`)

  /*
   * 给一个**远超用量**的数字：鸡蛋这道菜最多要几个，给 99 个一定够。
   * 断言"够了"要能与"不够"区分开，所以给量时故意走两个极端（99 与 1）。
   */
  const enoughStock = await stock(mama.token, '鸡蛋', '99个')
  check('记冰箱成功（鸡蛋 99个）', enoughStock.status === 201, `status=${enoughStock.status}`)

  const withEggs = await list(mama.token)
  const eggAfter = itemOf(withEggs.body, '鸡蛋')
  check(
    '家里够的**从"要买的"里拿掉**（`needsBuy:false`、`verdict:enough`）',
    eggAfter
      && eggAfter.needsBuy === false
      && eggAfter.stock.verdict === 'enough'
      && /够了/.test(eggAfter.stockLabel ?? ''),
    `needsBuy=${eggAfter?.needsBuy} verdict=${eggAfter?.stock?.verdict} label=${eggAfter?.stockLabel}`,
  )
  check(
    '那句话里给出**家里有多少**（用户要能核对"99个"是不是他记的）',
    /99个/.test(eggAfter?.stockLabel ?? ''),
    `label=${eggAfter?.stockLabel}`,
  )
  check(
    '计数自洽：要买的 + 家里有的 = 全部',
    withEggs.body?.toBuyCount + withEggs.body?.coveredCount === (withEggs.body?.items ?? []).length,
    `toBuy=${withEggs.body?.toBuyCount} covered=${withEggs.body?.coveredCount} items=${(withEggs.body?.items ?? []).length}`,
  )

  // ---------- 家里不够：真减法 ----------

  /*
   * 换一个家庭专测"不够"：把鸡蛋记成 1 个，而番茄炒蛋要的绝不止 1 个。
   * 用同一个家庭的话，前面那条"99个"已经把结论定死了。
   */
  const tight = await newUser('只买缺的·紧张')
  await newFamily(tight.token, '紧巴巴之家')
  await planDish(tight.token, tomatoDish.id)
  const tightBefore = await list(tight.token)
  const tightEgg = itemOf(tightBefore.body, '鸡蛋')
  const tightEggNeed = tightEgg ? Number(/^(\d+)/.exec(tightEgg.amount ?? '')?.[1] ?? '0') : 0

  const oneEgg = await stock(tight.token, '鸡蛋', '1个')
  check('记冰箱成功（鸡蛋 1个）', oneEgg.status === 201, `status=${oneEgg.status}`)
  const tightAfter = await list(tight.token)
  const tightEggAfter = itemOf(tightAfter.body, '鸡蛋')

  if (tightEggNeed > 1) {
    check(
      '家里不够时：仍在"要买的"里，且**给出还要买多少**（真减出来的数字）',
      tightEggAfter
        && tightEggAfter.needsBuy === true
        && tightEggAfter.stock.verdict === 'notEnough'
        && tightEggAfter.stock.remaining === `${tightEggNeed - 1}个`
        && /还要买/.test(tightEggAfter.stockLabel ?? ''),
      `要 ${tightEgg.amount}、家里 1个 → remaining=${tightEggAfter?.stock?.remaining} label=${tightEggAfter?.stockLabel}`,
    )
  } else {
    check(
      '（这道菜的鸡蛋用量恰好 ≤1，跳过"不够"这条；改验它不是 enough）',
      tightEggAfter?.stock?.verdict !== 'enough' || tightEggNeed === 1,
      `要 ${tightEgg?.amount}、家里 1个 → ${tightEggAfter?.stock?.verdict}`,
    )
  }

  // ---------- 单位对不上：算不清，不许给数字 ----------

  const fuzzy = await newUser('只买缺的·算不清')
  await newFamily(fuzzy.token, '算不清之家')
  await planDish(fuzzy.token, tomatoDish.id)
  await stock(fuzzy.token, '鸡蛋', '半盒')

  const fuzzyList = await list(fuzzy.token)
  const fuzzyEgg = itemOf(fuzzyList.body, '鸡蛋')
  check(
    '**单位对不上就算不清**：不给数字、不写"够了"，而是"够不够看一眼"',
    fuzzyEgg
      && fuzzyEgg.stock.verdict === 'unknown'
      && fuzzyEgg.stock.remaining === null
      && fuzzyEgg.needsBuy === false
      && /够不够看一眼/.test(fuzzyEgg.stockLabel ?? '')
      && !/够了/.test(fuzzyEgg.stockLabel ?? ''),
    `verdict=${fuzzyEgg?.stock?.verdict} remaining=${fuzzyEgg?.stock?.remaining} label=${fuzzyEgg?.stockLabel}`,
  )
  check(
    '算不清的样数要单独报出来（界面用它提醒"这几样下厨前看一眼"）',
    fuzzyList.body?.unsureCount >= 1,
    `unsureCount=${fuzzyList.body?.unsureCount}`,
  )

  // ---------- 冰箱那侧没写量：也算不清 ----------

  const noAmount = await newUser('只买缺的·没写量')
  await newFamily(noAmount.token, '没写量之家')
  await planDish(noAmount.token, tomatoDish.id)
  await callWithRetry('POST', '/fridge', { token: noAmount.token, body: { name: '鸡蛋', zone: '冷藏' } })

  const noAmountList = await list(noAmount.token)
  const noAmountEgg = itemOf(noAmountList.body, '鸡蛋')
  check(
    '**冰箱那侧没写量也算不清**（"有鸡蛋"不等于"有够用的鸡蛋"）',
    noAmountEgg
      && noAmountEgg.stock.verdict === 'unknown'
      && /够不够看一眼/.test(noAmountEgg.stockLabel ?? ''),
    `verdict=${noAmountEgg?.stock?.verdict} label=${noAmountEgg?.stockLabel}`,
  )

  // ---------- 别名与切法：认得出（否则会大面积"多买"） ----------

  const aliasFamily = await newUser('只买缺的·别名')
  await newFamily(aliasFamily.token, '别名之家')
  await planDish(aliasFamily.token, tomatoDish.id)
  // 菜谱写"番茄"，家里记"西红柿"——同一样东西
  await stock(aliasFamily.token, '西红柿', '99个')
  const aliasList = await list(aliasFamily.token)
  const aliasTomato = itemOf(aliasList.body, '番茄') ?? itemOf(aliasList.body, '西红柿')
  check(
    '别名认得出：家里记"西红柿"，能抵掉菜谱要的"番茄"',
    aliasTomato
      && aliasTomato.stock.verdict === 'enough'
      && aliasTomato.stock.stockName === '西红柿',
    `verdict=${aliasTomato?.stock?.verdict} stockName=${aliasTomato?.stock?.stockName} label=${aliasTomato?.stockLabel}`,
  )

  // ---------- 反证：五花肉 ≠ 猪肉 ----------

  const porkFamily = await newUser('只买缺的·猪肉组')
  await newFamily(porkFamily.token, '猪肉组之家')
  await planDish(porkFamily.token, porkDish.id)

  /*
   * 记两样：**五花肉**（反证用：它不该解掉要猪肉的那条）与**白菜**（正对照：
   * 那道菜确实要它，记上就该被认出来）。
   *
   * 正对照是必需的，不是凑数：没有它，"五花肉没解掉猪肉"这句可能只是因为
   * **整个比对都没生效**（每条都返回 missing），而不是因为规则是对的。
   *
   * ⚠️ 白菜这个名字**是从那道菜谱的配料表里选的**（实测：白菜猪肉饺子要 猪肉 500g + 白菜 300g），
   * 不是我猜的——第一版这里用的是"五花肉"，而那道菜压根不要五花肉，
   * 于是"家里那块五花肉被认出来了"这条断言永远没有靶子（与 R-45 是同一个坑）。
   */
  await stock(porkFamily.token, '五花肉', '999g')
  await stock(porkFamily.token, '白菜', '999g')

  const porkList = await list(porkFamily.token)
  const porkItems = porkList.body?.items ?? []
  const porkEntry = itemOf(porkList.body, '猪肉')
  check(
    '反证：**五花肉不算猪肉**（要猪肉的菜仍把"猪肉"列进"要买的"）',
    Boolean(porkEntry) && porkEntry.stock.verdict === 'missing' && porkEntry.needsBuy === true,
    porkEntry
      ? `猪肉 → verdict=${porkEntry.stock.verdict} needsBuy=${porkEntry.needsBuy} label=${porkEntry.stockLabel}`
      : `这道菜的清单里没有"猪肉"，这条反证没验到东西：${JSON.stringify(porkItems.map((i) => i.name))}`,
  )
  const cabbageEntry = itemOf(porkList.body, '白菜')
  check(
    '正对照：同一张清单里，**家里真有的那样被认出来了**（证明上一条不是因为比对整个没生效）',
    Boolean(cabbageEntry) && cabbageEntry.stock.verdict === 'enough' && cabbageEntry.needsBuy === false,
    cabbageEntry
      ? `白菜 → ${cabbageEntry.stockLabel}`
      : `清单里没有"白菜"，这条正对照没验到东西：${JSON.stringify(porkItems.map((i) => i.name))}`,
  )

  // ---------- 共享关掉：只用自己放的那些 ----------

  const eater = await newUser('只买缺的·吃货')
  await callWithRetry('POST', '/family/join', { token: eater.token, body: { inviteCode: family.inviteCode } })
  const sharedList = await list(eater.token)
  const sharedCovered = sharedList.body?.coveredCount ?? 0

  const sharedOff = await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  check('关掉共享成功', sharedOff.status === 200 && sharedOff.body?.shared === false, `status=${sharedOff.status}`)

  const mineList = await list(eater.token)
  check(
    '共享关掉后：吃货的清单里**没有"家里有"**（那些是妈妈记的，他看不到）',
    mineList.body?.scope === 'mine'
      && mineList.body?.coveredCount === 0
      && (mineList.body?.items ?? []).every((item) => item.stock.verdict === 'missing'),
    `scope=${mineList.body?.scope} covered=${mineList.body?.coveredCount}（关之前是 ${sharedCovered}）`,
  )
  const mamaStillSees = await list(mama.token)
  check(
    '掌勺人关掉共享后仍看全量（要负责买菜）',
    mamaStillSees.body?.scope === 'family' && mamaStillSees.body?.coveredCount >= 1,
    `scope=${mamaStillSees.body?.scope} covered=${mamaStillSees.body?.coveredCount}`,
  )

  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

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
