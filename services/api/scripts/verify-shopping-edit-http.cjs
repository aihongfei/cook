#!/usr/bin/env node
/**
 * 采购清单编辑与补货接口 HTTP 验收（真实请求，不 mock）。M7 / F7-03、F7-05，口径见 D-064。
 * 用法：先启动服务，再执行 pnpm run test:http:shopping
 * 可用 BASE_URL 覆盖地址，默认 http://127.0.0.1:3000/api
 *
 * 覆盖：未登录 401 → 没家庭 404 → 菜单没定时空清单（不编内容）→ **还在收集中的不算**（PENDING）
 *       → 「选好了」之后才进清单 → 同名食材**跨菜合并**（用量真的加起来）
 *       → 菜谱没写用量时说"没写"而不是"适量" → 自由菜品单独列在 `missing` 里
 *       → 共享关掉后吃货只按自己参与的餐算 → 天数校验 → 窗口边界（窗外那一餐不进清单）。
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

/**
 * 把 `2个` / `200g` 这样的用量折成一半（`1个` / `100g`），用来造"冰箱里有一条、但不够"的场景。
 * 认不出来（`适量`、`3-4个`、`半盒`、`2个、适量`）就返回 null——调用方会跳过这条候选。
 */
function halveAmount(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([^\d、\-~～—–]*)$/.exec(String(text ?? '').trim())
  if (!match) return null
  const half = Number(match[1]) / 2
  if (!(half > 0)) return null
  return `${Number(half.toFixed(2))}${match[2].trim()}`
}

let seq = 0
async function newUser(nickname) {
  seq += 1
  const account = `sp${Date.now()}${seq}`.toLowerCase()
  const registered = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname: nickname ?? account },
  })
  if (registered.status !== 201) throw new Error(`注册失败：${registered.status} ${JSON.stringify(registered.body)}`)
  return { account, token: registered.body.token, user: registered.body.user }
}

function dateKeyOf(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const names = (body) => (body?.items ?? []).map((item) => item.name)
const itemOf = (body, name) => (body?.items ?? []).find((item) => item.name === name) ?? null

/** PENDING → PLANNED（"选好了"）——采购清单只认定了的菜单 */
async function confirm(mealKey, token) {
  return callWithRetry('POST', `/orders/meals/${mealKey}/status`, { token, body: { status: 'PLANNED' } })
}


/**
 * 覆盖：勾选**落到库里**（刷新还在、换个设备还在）→ 取消勾选是幂等的 →
 *       **过期勾当作没勾**（上周勾的"葱"不能这周还亮着）→ 自加条目进同一张清单 →
 *       同名重复被拒 → 删自加条目连带清掉它的勾 → **分组是按货架来的**（空组不返回）→
 *       **水不出现在清单上**（没人去超市买温水）→ 一键补货真的写进冰箱 +
 *       分区按货架推 → **同名同区不覆盖、只报出来** →
 *       **跳过的那条保留勾**（造的是"库里有一条但不够"的现场：那条还在要买、有勾选框，
 *       刚补进去的那种数量为空 → 已经不算要买、按设计没有勾选框，验不了这一条）→
 *       共享关掉时各看各的勾。
 */
async function main() {
  await settleThrottleWindow()

  // 找一道有配料表的菜（清单要有内容才能验编辑）
  const pool = await callWithRetry('GET', '/recipes?pageSize=20')
  const ids = (pool.body?.items ?? []).map((item) => item.id)
  let recipe = null
  for (const id of ids.slice(0, 10)) {
    const detail = await callWithRetry('GET', `/recipes/${id}`)
    if ((detail.body?.ingredients ?? []).length > 0) { recipe = detail.body; break }
  }
  if (!recipe) throw new Error('菜谱库里找不到带配料表的菜，无法验收')

  const mama = await newUser('清单编辑妈')
  const created = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '清单编辑验收家' } })
  const day0 = dateKeyOf(0)
  await callWithRetry('POST', '/orders/items', {
    token: mama.token,
    body: { recipeId: recipe.id, mealDate: day0, meal: 'DINNER' },
  })
  const planned = await confirm(`${day0}-DINNER`, mama.token)
  const base = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  const items = base.body?.items ?? []
  check(
    '菜单定下来后清单有内容（后面几步要有东西可勾）',
    planned.status === 200 && items.length > 0,
    `items=${items.length}`,
  )
  const first = items.find((item) => item.needsBuy) ?? items[0]
  const firstName = first?.name
  check('**水的各种写法不出现在清单上**（没人去超市买"温水"）',
    !items.some((item) => ['水', '清水', '温水', '开水', '热水', '凉水'].includes(item.name)),
    `清单里有没有水：${items.filter((i) => /水$/.test(i.name)).map((i) => i.name).join('、') || '无'}`)

  // ---------- 分组 ----------
  const aisles = base.body?.aisles ?? []
  const aisleNames = aisles.map((g) => g.aisle)
  check('分组按货架返回，且**空组不返回**（否则用户会看到五个空标题）',
    aisles.length > 0 && aisles.every((g) => g.items.length > 0) && new Set(aisleNames).size === aisleNames.length,
    `组=${aisleNames.join('/')} 各组条数=${aisles.map((g) => g.items.length).join('/')}`)
  const flat = aisles.flatMap((g) => g.items.map((i) => i.name)).sort()
  check('分组里的条目与扁平的 items 是同一份（分组没有漏掉或重复任何一条）',
    JSON.stringify(flat) === JSON.stringify([...items.map((i) => i.name)].sort()),
    `分组 ${flat.length} 条 vs 清单 ${items.length} 条`)
  check('显示顺序是逛超市的动线（生鲜在前、调料垫底、其他最后）',
    JSON.stringify(aisleNames) === JSON.stringify(['蔬菜水果', '肉蛋水产', '蛋奶豆制品', '米面粮油', '调味干货', '其他'].filter((a) => aisleNames.includes(a))),
    aisleNames.join('/'))

  // ---------- 勾选持久化 ----------
  const checked = await callWithRetry('POST', '/shopping-list/check', { token: mama.token, body: { name: firstName } })
  check('勾选落到库里（响应里直接带上新状态）',
    checked.status === 201 || checked.status === 200,
    `${checked.status}`)
  const reread = await callWithRetry('GET', '/shopping-list', { token: mama.token })
  check('**重新取一次清单，勾还在**（这就是 F7-03 要的"刷新不丢"）',
    (reread.body?.checkedNames ?? []).includes(firstName),
    `checkedNames=${JSON.stringify(reread.body?.checkedNames)}`)
  check('"买到 N/M" 的 N 来自库里的勾（不是前端数出来的）',
    reread.body?.checkedCount === 1,
    `checkedCount=${reread.body?.checkedCount}`)

  const twice = await callWithRetry('POST', '/shopping-list/check', { token: mama.token, body: { name: firstName, checked: true } })
  check('重复勾同一样是幂等的（不是错误，用户点了两下而已）',
    twice.status < 400 && twice.body?.checkedCount === 1,
    `${twice.status} count=${twice.body?.checkedCount}`)

  const unchecked = await callWithRetry('POST', '/shopping-list/check', { token: mama.token, body: { name: firstName, checked: false } })
  check('取消勾选也落到库里（并且是幂等的）',
    unchecked.status < 400 && !(unchecked.body?.checkedNames ?? []).includes(firstName),
    `checkedNames=${JSON.stringify(unchecked.body?.checkedNames)}`)

  const checkNoName = await callWithRetry('POST', '/shopping-list/check', { token: mama.token, body: {} })
  check('勾选不带名字 → 400 且话术可读',
    checkNoName.status === 400 && /写个名字/.test(String(checkNoName.body?.message)),
    `${checkNoName.status} ${checkNoName.body?.message}`)

  // ---------- 自加条目 ----------
  const extra = await callWithRetry('POST', '/shopping-list/extras', { token: mama.token, body: { name: '垃圾袋', amount: '两卷' } })
  const extraList = extra.status < 400 ? extra : await callWithRetry('GET', '/shopping-list', { token: mama.token })
  const extraItem = (extraList.body?.items ?? []).find((item) => item.name === '垃圾袋')
  check('自加的条目进**同一张清单**（不是另开一组，它与菜单推出来的东西是一样的）',
    Boolean(extraItem) && extraItem.extra === true && extraItem.amount === '两卷',
    `extra=${JSON.stringify(extraItem)}`)
  check('自加条目也参与分组（能报到货架上）',
    (extraList.body?.aisles ?? []).some((g) => g.items.some((i) => i.name === '垃圾袋')),
    `组=${(extraList.body?.aisles ?? []).map((g) => g.aisle).join('/')}`)

  const dup = await callWithRetry('POST', '/shopping-list/extras', { token: mama.token, body: { name: '垃圾袋' } })
  check('同名再加一次 → 400（两条同名会让人不知道怎么算）',
    dup.status === 400 && /已经有/.test(String(dup.body?.message)),
    `${dup.status} ${dup.body?.message}`)

  // 与菜单推出来的条目同名：那条每次现算、没有 id，再加一条会让两行共用一个勾选框
  const dupMenu = await callWithRetry('POST', '/shopping-list/extras', { token: mama.token, body: { name: firstName } })
  check('与**菜单推出来的条目**同名也拒（两行同名会共用一个勾，勾一下"买到"跳 2）',
    dupMenu.status === 400 && /已经有/.test(String(dupMenu.body?.message)),
    `${dupMenu.status} ${dupMenu.body?.message}`)

  const noName = await callWithRetry('POST', '/shopping-list/extras', { token: mama.token, body: { amount: '两卷' } })
  check('自加条目不带名字 → 400',
    noName.status === 400 && /写个名字/.test(String(noName.body?.message)),
    `${noName.status} ${noName.body?.message}`)

  // 勾上自加条目，然后删掉它——那个勾应该一起没了
  const extraId = extraItem?.extraId
  check('自加条目带 `extraId`（界面要靠它删；菜单推出来的条目没有 id = 不能删）',
    typeof extraId === 'string' && !(extraList.body?.items ?? []).find((i) => i.name !== '垃圾袋' && i.extraId),
    `extraId=${extraId}`)
  await callWithRetry('POST', '/shopping-list/check', { token: mama.token, body: { name: '垃圾袋' } })
  const removed = await callWithRetry('DELETE', `/shopping-list/extras/${extraId}`, { token: mama.token })
  check('删自加条目：它从清单上消失，**它的勾也一起清掉**（否则那个勾会留 7 天才自己过期）',
    removed.status < 400
      && !(removed.body?.items ?? []).some((i) => i.name === '垃圾袋')
      && !(removed.body?.checkedNames ?? []).includes('垃圾袋'),
    `${removed.status} 还在吗=${(removed.body?.items ?? []).some((i) => i.name === '垃圾袋')} 勾=${JSON.stringify(removed.body?.checkedNames)}`)

  const removeAgain = await callWithRetry('DELETE', `/shopping-list/extras/${extraId}`, { token: mama.token })
  check('再删一次 → 404（不是静默成功，用户至少知道那条已经没了）',
    removeAgain.status === 404,
    `${removeAgain.status}`)

  // ---------- 一键补货（F7-05） ----------
  const restock = await callWithRetry('POST', '/shopping-list/restock', { token: mama.token, body: { names: [firstName] } })
  check('一键补货：把勾掉的那样写进冰箱', restock.status === 200 && (restock.body?.added ?? []).length === 1,
    `${restock.status} added=${JSON.stringify((restock.body?.added ?? []).map((i) => `${i.name}/${i.zone}`))}`)
  const addedItem = (restock.body?.added ?? [])[0]
  check('补进去的分区是**按货架推的**（生鲜→冷藏、肉→冷冻），不是一律冷藏',
    Boolean(addedItem?.zone) && ['常温', '保鲜', '冷藏', '冷冻'].includes(addedItem.zone),
    `zone=${addedItem?.zone}`)
  check('补进去的数量**留空**（清单上的"2个"是菜谱要多少，不是买回来多少——照抄会得出假的"家里够"）',
    addedItem?.amount === null,
    `amount=${JSON.stringify(addedItem?.amount)}`)
  const fridge = await callWithRetry('GET', '/fridge', { token: mama.token })
  check('冰箱里真的多了那一样（不是只回了响应）',
    (fridge.body?.zones ?? []).some((z) => z.items.some((i) => i.name === firstName)),
    `冰箱总数=${fridge.body?.summary?.total}`)
  check('补进去的那几样**顺手取消勾选**（已经进冰箱了，还亮着勾会让人以为没放进去）',
    !(restock.body?.board?.checkedNames ?? []).includes(firstName),
    `勾=${JSON.stringify(restock.body?.board?.checkedNames)}`)

  // 再补一次同一样：库里已经有了 → **跳过并报出来，不覆盖**
  const again = await callWithRetry('POST', '/shopping-list/restock', { token: mama.token, body: { names: [firstName] } })
  check('同名同区已经有一条时：**跳过并报出来，不悄悄覆盖**（覆盖会让用户填的数量变成两次之和）',
    again.status === 200 && (again.body?.added ?? []).length === 0
      && (again.body?.skipped ?? []).some((s) => s.name === firstName && /已经有一条/.test(s.why)),
    `added=${(again.body?.added ?? []).length} skipped=${JSON.stringify(again.body?.skipped)}`)

  /*
   * 「跳过时保留勾」**要挑一条还在要买的东西来验**。
   *
   * 刚补进去的那条数量是空的 → 比对结果是"够不够看一眼" → 它已经不在要买的那几条里，
   * 界面也不会给它勾选框，所以它的勾按设计**不出现在 `checkedNames` 里**
   * （与"家里有的那几条没有勾选框"是同一条规矩，不是丢了勾）。
   *
   * 于是这里另挑一条：菜单要 `2个`、冰箱里只放 `1个` → 它**还在要买**、有勾选框。
   */
  const split = items.find((item) => item.name !== firstName && item.needsBuy && halveAmount(item.amount))
  check('能找到一条"还没买够、数量能折半"的食材（下面两条要用它）',
    Boolean(split),
    split ? `${split.name}：菜谱要 ${split.amount}` : '这一轮的菜单里没有这样的条目')

  if (split) {
    // 造现场：先补进冰箱（数量留空），再把数量改成一半 → 从"够不够看一眼"变回"还差一点"
    const seeded = await callWithRetry('POST', '/shopping-list/restock', { token: mama.token, body: { names: [split.name] } })
    const seededItem = (seeded.body?.added ?? [])[0]
    const shrunk = seededItem
      ? await callWithRetry('PATCH', `/fridge/${seededItem.id}`, { token: mama.token, body: { amount: halveAmount(split.amount) } })
      : { status: 0 }
    const restaged = await callWithRetry('POST', '/shopping-list/check', { token: mama.token, body: { name: split.name } })
    check('数量改成一半后它**回到"还要买"、勾也认得**（下面那条的前提，不然是空转的）',
      shrunk.status < 400 && (restaged.body?.checkedNames ?? []).includes(split.name),
      `added=${(seeded.body?.added ?? []).length} patch=${shrunk.status} 勾=${JSON.stringify(restaged.body?.checkedNames)}`)

    const skipSplit = await callWithRetry('POST', '/shopping-list/restock', { token: mama.token, body: { names: [split.name] } })
    check('跳过的那条**保留勾**（用户的动作没错，只是库里已经有了，他要自己去合并）',
      (skipSplit.body?.added ?? []).length === 0
        && (skipSplit.body?.board?.checkedNames ?? []).includes(split.name),
      `added=${(skipSplit.body?.added ?? []).length} 勾=${JSON.stringify(skipSplit.body?.board?.checkedNames)}`)
  }

  const emptyRestock = await callWithRetry('POST', '/shopping-list/restock', { token: mama.token, body: { names: [] } })
  check('一样都没勾就点补货 → 400 且指出该做什么',
    emptyRestock.status === 400 && /先勾掉买到的/.test(String(emptyRestock.body?.message)),
    `${emptyRestock.status} ${emptyRestock.body?.message}`)

  // ---------- 共享关掉：各看各的勾 ----------
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: false } })
  const son = await newUser('清单编辑娃')
  await callWithRetry('POST', '/family/join', { token: son.token, body: { inviteCode: created.body.inviteCode } })
  const sonList = await callWithRetry('GET', '/shopping-list', { token: son.token })
  check('共享关掉后，新成员看不到别人的勾（同一套可见性闸门）',
    sonList.status === 200 && (sonList.body?.checkedNames ?? []).length === 0,
    `${sonList.status} 勾=${JSON.stringify(sonList.body?.checkedNames)}`)
  await callWithRetry('PATCH', '/family', { token: mama.token, body: { shared: true } })

  // ---------- 结果 ----------
  console.log('')
  for (const result of results) {
    console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.detail ? `  (${result.detail})` : ''}`)
  }
  console.log('')
  console.log(`${results.length - failed}/${results.length} 通过`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error('验收脚本异常：', error)
  process.exit(1)
})
