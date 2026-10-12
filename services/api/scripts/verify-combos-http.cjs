/**
 * 常用组合的接口验收（M4 / F4-04，口径见 D-029）。
 *
 * 覆盖：建组（重名/超长/编造 id/去重）、列表（canEdit 按人算）、
 * 一键加入（跳过已有的、不叠加份数、幂等、终态餐拒掉）、改与删的权限、未登录/无家庭。
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'

let failed = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed }
}

async function callWithRetry(method, path, options, attempts = 3) {
  let last
  for (let index = 0; index < attempts; index += 1) {
    last = await call(method, path, options)
    if (last.status !== 429) return last
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return last
}

async function newUser(nickname) {
  const account = `combo${Date.now()}${Math.floor(Math.random() * 1000)}`
  const created = await callWithRetry('POST', '/auth/register', {
    body: { account, password: 'cook2026pass', nickname, avatar: '🍳' },
  })
  if (created.status !== 201) throw new Error(`注册失败：${created.status} ${JSON.stringify(created.body)}`)
  return { token: created.body.token, account, id: created.body.user?.id }
}

function plusDaysKey(offset) {
  const base = new Date()
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const TODAY = plusDaysKey(0)
const TOMORROW = plusDaysKey(1)

async function main() {


// ---------- 前置：一个家 + 四道真实菜 ----------
const mama = await newUser('妈妈')
const kid = await newUser('小满')
const stranger = await newUser('外人')

const created = await callWithRetry('POST', '/family', { token: mama.token, body: { name: '组合验收家' } })
if (created.status !== 201) throw new Error(`建家失败：${created.status} ${JSON.stringify(created.body)}`)
await callWithRetry('POST', '/family/join', { token: kid.token, body: { inviteCode: created.body.inviteCode } })

const recipes = await callWithRetry('GET', '/recipes?pageSize=4')
const dishes = recipes.body?.items ?? []
if (dishes.length < 4) throw new Error(`菜谱库不足：${dishes.length}`)
const [dishA, dishB, dishC, dishD] = dishes

// ---------- 建组 ----------
const unauthorized = await call('GET', '/combos')
check('未登录看组合 → 401', unauthorized.status === 401, `${unauthorized.status}`)

const loner = await callWithRetry('GET', '/combos', { token: stranger.token })
check('没有家庭的人看组合 → 404 + 人话', loner.status === 404 && typeof loner.body?.message === 'string', `${loner.status} ${loner.body?.message ?? ''}`)

const empty = await callWithRetry('GET', '/combos', { token: mama.token })
check('刚建的家没有组合：给空数组（不是 404/500）', empty.status === 200 && Array.isArray(empty.body?.combos) && empty.body.combos.length === 0, `${empty.status} ${JSON.stringify(empty.body)}`)

const built = await callWithRetry('POST', '/combos', {
  token: mama.token,
  body: { name: '  快手三菜一汤  ', note: '工作日的晚上', recipeIds: [dishA.id, dishB.id, dishC.id] },
})
const combo = built.body?.combos?.find((row) => row.name === '快手三菜一汤')
check('建组 → 201，名字去首尾空格、带说明与菜', built.status === 201 && combo?.note === '工作日的晚上' && combo?.dishCount === 3,
  `${built.status} ${combo?.name} ${combo?.dishCount} 道`)
check('组里的菜带真实菜名与图（不是 id）', combo?.dishes?.every((dish) => dish.name && dish.recipeId), JSON.stringify(combo?.dishes?.map((d) => d.name)))

const dup = await callWithRetry('POST', '/combos', {
  token: kid.token, body: { name: '快手三菜一汤', recipeIds: [dishA.id] },
})
check('同家重名 → 409 + 人话（组合该是记得住的那几个）', dup.status === 409 && /已经有一个叫/.test(dup.body?.message ?? ''), `${dup.status} ${dup.body?.message ?? ''}`)

const longName = await callWithRetry('POST', '/combos', {
  token: mama.token, body: { name: '三'.repeat(25), recipeIds: [dishA.id] },
})
check('组名超 24 字 → 400', longName.status === 400, `${longName.status} ${longName.body?.message ?? ''}`)

const fakeId = await callWithRetry('POST', '/combos', {
  token: mama.token, body: { name: '编造的组', recipeIds: ['no-such-recipe'] },
})
check('编造的菜 id → 404（组里的菜必须真实存在，否则一键加入永远失败在某一道上）', fakeId.status === 404, `${fakeId.status} ${fakeId.body?.message ?? ''}`)

const dupInside = await callWithRetry('POST', '/combos', {
  token: mama.token, body: { name: '去重的组', recipeIds: [dishD.id, dishD.id, dishA.id] },
})
const deduped = dupInside.body?.combos?.find((row) => row.name === '去重的组')
check('同一道菜重复发 → 自动去重（不是报错）', dupInside.status === 201 && deduped?.dishCount === 2, `${dupInside.status} ${deduped?.dishCount} 道`)

const emptyItems = await callWithRetry('POST', '/combos', { token: mama.token, body: { name: '空的组', recipeIds: [] } })
check('一道菜都没有 → 400', emptyItems.status === 400 && /至少要有 1 道菜/.test(emptyItems.body?.message ?? ''), `${emptyItems.status} ${emptyItems.body?.message ?? ''}`)

// ---------- 列表与权限 ----------
const listForKid = await callWithRetry('GET', '/combos', { token: kid.token })
const kidView = listForKid.body?.combos?.find((row) => row.name === '快手三菜一汤')
check('组合是家庭共用的：吃货也能看到妈妈组的', listForKid.status === 200 && Boolean(kidView), `${listForKid.status} ${(listForKid.body?.combos ?? []).map((c) => c.name).join('、')}`)
check('不是自己组的、又没有管理权 → canEdit=false（前端据此不显示删除）', kidView?.canEdit === false, `canEdit=${kidView?.canEdit}`)
const listForMama = await callWithRetry('GET', '/combos', { token: mama.token })
check('自己组的 → canEdit=true', listForMama.body?.combos?.find((row) => row.id === combo.id)?.canEdit === true, '')

const kidDelete = await callWithRetry('DELETE', `/combos/${combo.id}`, { token: kid.token })
check('吃货删别人的组合 → 403', kidDelete.status === 403, `${kidDelete.status} ${kidDelete.body?.message ?? ''}`)

// ---------- 一键加入 ----------
const beforeAdd = await callWithRetry('POST', '/orders/items', {
  token: mama.token, body: { recipeId: dishA.id, mealDate: TOMORROW, meal: 'DINNER' },
})
if (![200, 201].includes(beforeAdd.status)) throw new Error(`前置点菜失败：${beforeAdd.status}`)

const added = await callWithRetry('POST', `/combos/${combo.id}/add`, {
  token: mama.token, body: { mealDate: TOMORROW, meal: 'DINNER' },
})
check('一键加入 → 200，加入的是"还没有的"那几道', added.status === 200 && added.body?.added?.length === 2,
  `${added.status} added=${JSON.stringify(added.body?.added)} skipped=${JSON.stringify(added.body?.skipped)}`)
check('这一餐里本来就有的菜**跳过**（不叠加份数）', (added.body?.skipped ?? []).length === 1 && added.body.skipped[0] === dishA.name,
  JSON.stringify(added.body?.skipped))
check('返回里带受影响的整张卡（前端不用再请求一次）', Boolean(added.body?.card?.mealKey) && added.body.card.dishes.length === 3,
  `${added.body?.card?.mealKey} ${added.body?.card?.dishes?.length} 行`)

const again = await callWithRetry('POST', `/combos/${combo.id}/add`, { token: mama.token, body: { mealDate: TOMORROW, meal: 'DINNER' } })
check('再点一次是**幂等**的：added 为空、全在 skipped 里（同一组菜不会变两份）',
  again.status === 200 && (again.body?.added ?? []).length === 0 && (again.body?.skipped ?? []).length === 3,
  `added=${JSON.stringify(again.body?.added)} skipped=${(again.body?.skipped ?? []).length}`)

const cardAfter = await callWithRetry('GET', `/orders/plan?days=2`, { token: mama.token })
const tomorrowDinner = (cardAfter.body?.days ?? []).find((day) => day.date === TOMORROW)?.meals?.find((meal) => meal.meal === 'DINNER')
check('整组确实进了那一餐（3 道，不是 1 道、不是 6 道）', tomorrowDinner?.dishCount === 3, `dishCount=${tomorrowDinner?.dishCount} ${JSON.stringify(tomorrowDinner?.dishes)}`)

const badDate = await callWithRetry('POST', `/combos/${combo.id}/add`, {
  token: mama.token, body: { mealDate: '2027-01-01', meal: 'DINNER' },
})
check('加到窗口外的日期 → 400（与手点同一套日期口径）', badDate.status === 400, `${badDate.status} ${badDate.body?.message ?? ''}`)

const missingBody = await callWithRetry('POST', `/combos/${combo.id}/add`, { token: mama.token, body: {} })
check('没给日期餐次 → 400 + 人话', missingBody.status === 400 && /哪一天哪一餐/.test(missingBody.body?.message ?? ''), `${missingBody.status} ${missingBody.body?.message ?? ''}`)

const noSuchCombo = await callWithRetry('POST', '/combos/no-such-combo/add', {
  token: mama.token, body: { mealDate: TODAY, meal: 'LUNCH' },
})
check('不存在的组合 → 404', noSuchCombo.status === 404, `${noSuchCombo.status}`)

// 终态的那一餐：已做好之后不能再加
const doneSeed = await callWithRetry('POST', '/orders/items', { token: mama.token, body: { recipeId: dishB.id, mealDate: TODAY, meal: 'LUNCH' } })
if (![200, 201].includes(doneSeed.status)) throw new Error(`前置点菜失败：${doneSeed.status}`)
await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/status`, { token: mama.token, body: { status: 'PLANNED' } })
await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/status`, { token: mama.token, body: { status: 'COOKING' } })
await callWithRetry('POST', `/orders/meals/${TODAY}-LUNCH/status`, { token: mama.token, body: { status: 'DONE' } })

const intoDone = await callWithRetry('POST', `/combos/${combo.id}/add`, { token: mama.token, body: { mealDate: TODAY, meal: 'LUNCH' } })
check('整组加到「已做好」的那一餐 → 409（一次判定，不会加到一半才发现）',
  intoDone.status === 409 && /已经做好了/.test(intoDone.body?.message ?? ''), `${intoDone.status} ${intoDone.body?.message ?? ''}`)
const doneStill = await callWithRetry('GET', '/orders/plan?days=1', { token: mama.token })
const doneRow = (doneStill.body?.days ?? [])[0]?.meals?.find((meal) => meal.meal === 'LUNCH')
check('拒掉之后那一餐**一道菜都没多**（整组要么都进、要么都不进）', doneRow?.dishCount === 1, `dishCount=${doneRow?.dishCount}`)

// ---------- 改与删 ----------
const renamed = await callWithRetry('PATCH', `/combos/${combo.id}`, {
  token: mama.token, body: { name: '工作日三菜一汤', note: '改过的说明', recipeIds: [dishA.id, dishD.id] },
})
const renamedCombo = renamed.body?.combos?.find((row) => row.id === combo.id)
check('改组合：名字/说明/整组替换菜都在一个事务里落地',
  renamed.status === 200 && renamedCombo?.name === '工作日三菜一汤' && renamedCombo?.dishCount === 2,
  `${renamed.status} ${renamedCombo?.name} ${renamedCombo?.dishCount} 道`)

const kidRename = await callWithRetry('PATCH', `/combos/${combo.id}`, { token: kid.token, body: { name: '我改的' } })
check('吃货改别人的组合 → 403', kidRename.status === 403, `${kidRename.status}`)

const removed = await callWithRetry('DELETE', `/combos/${combo.id}`, { token: mama.token })
check('删组合 → 200，列表里没有了', removed.status === 200 && !(removed.body?.combos ?? []).some((row) => row.id === combo.id), `${removed.status} 剩 ${(removed.body?.combos ?? []).length} 个`)

const afterDelete = await callWithRetry('POST', `/combos/${combo.id}/add`, { token: mama.token, body: { mealDate: TODAY, meal: 'DINNER' } })
check('删掉之后再一键加入 → 404（不是静默成功）', afterDelete.status === 404, `${afterDelete.status}`)


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
