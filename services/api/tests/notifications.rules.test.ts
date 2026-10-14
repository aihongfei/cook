import assert from 'node:assert/strict'
import test from 'node:test'
import {
  areaOfKind, buildNotifications, dateKey, dayAnchor, dedupeKeyOf, dueFridge, fridgeBody, mergeStored,
  PREP_WINDOW_DAYS, unreadByArea, unreadCount,
  type DoneFact, type FridgeFact, type NotificationInput, type PlanFact, type PrepFact,
} from '../src/modules/notifications/notifications.rules'
// 「谁做好的」留痕与「谁定的菜单」并排放在 orders.rules 里（同一时刻的两件事）
import { doneStampFor } from '../src/modules/orders/orders.rules'

/**
 * 消息提醒（M10 / D-078）的纯规则。
 *
 * 这里要钉住的是**四类提醒怎么算、未读怎么判**——它是这一块唯一有判断的地方，
 * 界面与路由都是它的投影。三条最要紧的：
 *
 * 1. **不提醒自己干的事**（自己定的菜单、自己标的做好了）；
 * 2. **「未读」的唯一判据是 `seenAt`**，而状态派生的那两类（快过期/该备菜）要靠
 *    `dayAnchor` 既有"跨天会重新提醒"又能"标记完就别再亮"；
 * 3. **开关在这里再过一遍**（服务层也按开关决定查不查），漏了就会出现
 *    "关掉备菜之后通知中心里还有备菜"。
 */

const P = { mealPlan: true, mealDone: true, expiry: true, prep: true }
/** 用哪个账号读（日志的键带上它；这里固定一个，省得每个用例都写） */
const USER = 'u1'
const TODAY = '2026-10-15'

function input(patch: Partial<NotificationInput> = {}): NotificationInput {
  return { today: TODAY, prefs: P, plan: [], done: [], fridge: [], prep: [], ...patch }
}

function planFact(patch: Partial<PlanFact> = {}): PlanFact {
  return {
    mealKey: '2026-10-15-DINNER',
    byName: '妈妈',
    byMe: false,
    at: new Date('2026-10-15T10:00:00'),
    whenLabel: '今天晚餐',
    dishCount: 3,
    ...patch,
  }
}

function doneFact(patch: Partial<DoneFact> = {}): DoneFact {
  return {
    mealKey: '2026-10-15-DINNER',
    byName: '妈妈',
    byMe: false,
    at: new Date('2026-10-15T18:30:00'),
    whenLabel: '今天晚餐',
    myDishes: ['红烧排骨'],
    ...patch,
  }
}

function fridgeFact(patch: Partial<FridgeFact> = {}): FridgeFact {
  return {
    id: 'f1',
    name: '牛奶',
    expiresOn: new Date('2026-10-16T00:00:00Z'),
    createdAt: new Date('2026-10-10T09:00:00'),
    ...patch,
  }
}

function prepFact(patch: Partial<PrepFact> = {}): PrepFact {
  return { dateLabel: '明天', mealLabel: '午餐', mealKey: '2026-10-16-LUNCH', ...patch }
}

/** 固定"现在"：这些断言全都依赖"今天是几号"，不钉死的话跨天会红 */
const NOW = new Date('2026-10-15T20:00:00')

test('菜单安排：别人定的才提醒，自己定的不提醒自己', () => {
  const rows = buildNotifications(input({ plan: [planFact(), planFact({ mealKey: '2026-10-16-LUNCH', byMe: true })] }), NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'plan')
  assert.equal(rows[0].id, 'plan:2026-10-15-DINNER')
  assert.match(rows[0].title, /今天晚餐的菜单定下来了/)
  assert.match(rows[0].body ?? '', /妈妈定了 3 道菜/)
  // 去处直接是**那一餐的详情**（不是列表页）——通知点进去要能落到对的地方
  assert.equal(rows[0].to, '/order/2026-10-15-DINNER')
})

test('饭已做好：只提醒**我点过菜**的那些餐，且不是我自己标的', () => {
  const rows = buildNotifications(
    input({
      done: [
        doneFact(),
        doneFact({ mealKey: '2026-10-15-LUNCH', byMe: true }),
        doneFact({ mealKey: '2026-10-14-DINNER', myDishes: [] }),
      ],
    }),
    NOW,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'done:2026-10-15-DINNER')
  assert.match(rows[0].body ?? '', /你点的 红烧排骨 可以吃了/)
})

test('饭已做好：点得多时只列两道 + 「等 N 道」（不把一长串塞进一句话）', () => {
  const rows = buildNotifications(input({ done: [doneFact({ myDishes: ['红烧排骨', '拌黄瓜', '米饭'] })] }), NOW)
  assert.match(rows[0].body ?? '', /你点的 红烧排骨、拌黄瓜 等 3 道 可以吃了/)
})

test('快过期：只挑进窗口的那些，按最紧急排前面', () => {
  const soon = [
    fridgeFact({ id: 'a', name: '菠菜', expiresOn: new Date('2026-10-18T00:00:00Z') }),
    fridgeFact({ id: 'b', name: '牛奶', expiresOn: new Date('2026-10-16T00:00:00Z') }),
    fridgeFact({ id: 'c', name: '酸奶', expiresOn: new Date('2026-10-14T00:00:00Z') }),
  ]
  const due = dueFridge(soon, NOW)
  // 已过期的最前，然后按到期日
  assert.deepEqual(due.map((item: FridgeFact) => item.name), ['酸奶', '牛奶', '菠菜'])
})

test('快过期：没写保质期的不算（"不知道"不是"快坏了"）', () => {
  const rows = buildNotifications(input({ fridge: [fridgeFact({ expiresOn: new Date('2027-01-01T00:00:00Z') })] }), NOW)
  assert.equal(rows.length, 0, '还早的不算；而不写保质期的在服务层就被滤掉了')
})

test('快过期：那一句先把名字列出来，过期与将要过期分开说', () => {
  const allExpired = fridgeBody([fridgeFact({ name: '酸奶', expiresOn: new Date('2026-10-14T00:00:00Z') })], NOW)
  assert.match(allExpired, /已经过期了/)

  const mixed = fridgeBody(
    [
      fridgeFact({ name: '酸奶', expiresOn: new Date('2026-10-14T00:00:00Z') }),
      fridgeFact({ name: '牛奶', expiresOn: new Date('2026-10-16T00:00:00Z') }),
    ],
    NOW,
  )
  // 混在一起时把两类各说一遍：已过期的点名，另外那些说清"快到期"
  // （第一版写成"酸奶、牛奶 · 最早 过期 1 天"，读起来像绕口令——测试当场抓出来的）
  assert.match(mixed, /酸奶 已经过期了/)
  assert.match(mixed, /另外 1 样快到期/)
})

test('快过期：超过三样时说「等 N 样」，不把名字全倒出来', () => {
  const body = fridgeBody(
    ['a', 'b', 'c', 'd'].map((id, index) =>
      fridgeFact({ id, name: `食材${index + 1}`, expiresOn: new Date('2026-10-16T00:00:00Z') }),
    ),
    NOW,
  )
  assert.match(body, /食材1、食材2、食材3 等 4 样/)
})

test('该备菜：空着的餐次合成一条，标题说清最近的是哪一餐', () => {
  const rows = buildNotifications(input({ prep: [prepFact(), prepFact({ dateLabel: '明天', mealLabel: '晚餐' })] }), NOW)
  assert.equal(rows.length, 1)
  assert.match(rows[0].title, /接下来 2 餐还没安排/)
  assert.match(rows[0].body ?? '', /最近的是明天午餐/)
  assert.equal(rows[0].to, '/prep')
})

test('该备菜：只有一餐空着时直接写那一餐', () => {
  const rows = buildNotifications(input({ prep: [prepFact()] }), NOW)
  assert.match(rows[0].title, /明天午餐还没安排/)
})

test('开关在纯规则里再过一遍：关掉的那一类一条都不出现', () => {
  const off = { mealPlan: false, mealDone: false, expiry: false, prep: false }
  const rows = buildNotifications(
    input({
      prefs: off,
      plan: [planFact()],
      done: [doneFact()],
      fridge: [fridgeFact({ expiresOn: new Date('2026-10-16T00:00:00Z') })],
      prep: [prepFact()],
    }),
    NOW,
  )
  assert.equal(rows.length, 0)
})

test('开关逐个生效：关掉「备菜」只影响备菜那一条', () => {
  const rows = buildNotifications(
    input({
      prefs: { ...P, prep: false },
      plan: [planFact()],
      prep: [prepFact()],
    }),
    NOW,
  )
  assert.deepEqual(rows.map((row) => row.kind), ['plan'])
})

/*
 * 已读是**逐条**的（用户 2026-10-15：「需要**真的已读**时才清」「通知那边点进去才清除通知」）。
 *
 * 判据在 `mergeStored` 里：**只认库里那条事件自己的 `readAt`**，不看时间戳比较——
 * 这样"读过了就不会再变回未读"是结构性成立的（时间戳会因状态型提醒的锚点变化而重新变新，
 * 那正是这一版改动的起因：刚标记完已读、刷新一下又亮了）。
 */
function storedFor(items: ReturnType<typeof buildNotifications>, readKeys: string[] = []) {
  return new Map(
    items.map((item) => [
      // 键必须与写入侧同源（`dedupeKeyOf`）——第一版两边各拼一遍，列表因此永远是空的
      dedupeKeyOf(item.id, USER),
      {
        dedupeKey: item.id,
        title: item.title,
        body: item.body,
        toPath: item.to,
        at: new Date(item.at),
        readAt: readKeys.includes(item.id) ? new Date('2026-10-15T20:00:00') : null,
      },
    ]),
  )
}

test('未读：库里 readAt 为空就是未读，标过就是已读（逐条）', () => {
  const items = buildNotifications(input({ plan: [planFact()], done: [doneFact()] }), NOW)
  const rows = mergeStored(items, storedFor(items, ['done:2026-10-15-DINNER']), USER)
  assert.equal(unreadCount(rows), 1)
  assert.equal(rows.find((row) => row.unread)?.kind, 'plan')
})

test('已读是持久的：标过的那条**不会再变回未读**（哪怕它的时间戳重新变新）', () => {
  /*
   * 这一幕就是这次改动的起因：状态型提醒（快过期/该备菜）的 `at` 是会变的锚点
   * （明天零点跳一次）。若按"时间戳比上次看得晚"判未读，用户今天标过了，
   * 明天这条又亮——而它其实是同一件事。
   */
  const items = buildNotifications(input({ prep: [prepFact()] }), NOW)
  const rows = mergeStored(items, storedFor(items, ['prep:2026-10-15']), USER)
  assert.equal(unreadCount(rows), 0)
})

test('文案与去处取**库里那句**（历史要如实回放当时那句话，不跟着事实改）', () => {
  const items = buildNotifications(input({ done: [doneFact()] }), NOW)
  const stored = storedFor(items)
  // 模拟"库里那句"与重算的不同（比如那道菜后来改了名）
  // 键要用 `dedupeKeyOf` 拼——顺手钉住这条：写与读两侧必须同源（第一版各拼一遍，列表永远是空的）
  const key = dedupeKeyOf('done:2026-10-15-DINNER', USER)
  stored.set(key, {
    ...stored.get(key)!,
    title: '当时那句话',
    body: '当时的副标题',
    toPath: '/order?from=history',
  })
  const rows = mergeStored(items, stored, USER)
  assert.equal(rows[0].title, '当时那句话')
  assert.equal(rows[0].body, '当时的副标题')
  assert.equal(rows[0].to, '/order?from=history')
})

test('库里没有的那条不进列表（先入库再读，见 service）', () => {
  const items = buildNotifications(input({ plan: [planFact()] }), NOW)
  assert.equal(mergeStored(items, new Map(), USER).length, 0)
})

test('标记已读**不改排序**（刚看的那条还在原地，不会跳走）', () => {
  const items = buildNotifications(
    input({ plan: [planFact({ at: new Date('2026-10-15T09:00:00') })], done: [doneFact({ at: new Date('2026-10-15T18:30:00') })] }),
    NOW,
  )
  const before = mergeStored(items, storedFor(items), 'u1').map((row) => row.id)
  const after = mergeStored(items, storedFor(items, ['done:2026-10-15-DINNER']), USER).map((row) => row.id)
  assert.deepEqual(after, before)
})

test('列表按时间倒序（最新的在最上面）', () => {
  const items = buildNotifications(
    input({ plan: [planFact({ at: new Date('2026-10-15T09:00:00') })], done: [doneFact({ at: new Date('2026-10-15T18:30:00') })] }),
    NOW,
  )
  assert.deepEqual(items.map((item) => item.kind), ['done', 'plan'])
})

/*
 * 底栏红点按**区域**数：订单收「吃」那三件，冰箱只收「快过期」。
 * 用户 2026-10-15：「底部菜单，订单之类的也需要小红点」。
 */
test('红点归属：订单收菜单/饭好了/备菜，冰箱只收快过期', () => {
  assert.equal(areaOfKind('plan'), 'order')
  assert.equal(areaOfKind('done'), 'order')
  assert.equal(areaOfKind('prep'), 'order')
  assert.equal(areaOfKind('expiry'), 'fridge')
})

test('按区域数未读：只数未读的，且各归各的区', () => {
  const items = buildNotifications(
    input({
      plan: [planFact()],
      done: [doneFact()],
      fridge: [fridgeFact({ expiresOn: new Date('2026-10-16T00:00:00Z') })],
      prep: [prepFact()],
    }),
    NOW,
  )
  // 只把「饭已做好」标掉
  const rows = mergeStored(items, storedFor(items, ['done:2026-10-15-DINNER']), USER)
  const byArea = unreadByArea(rows)
  assert.equal(byArea.order, 2) // plan + prep
  assert.equal(byArea.fridge, 1)
})

/*
 * `dayAnchor` 是这一块唯一"想不通就会做错"的地方，所以三种情形各钉一条：
 * 状态派生的提醒没有事件时间，锚点选错的两个方向都会坏（红点永远亮 / 永远不亮）。
 */

test('锚点：时间自己走到这一步的（几天前记的、今天进入窗口）→ 取今天零点', () => {
  const created = new Date('2026-10-10T09:00:00')
  const anchor = dayAnchor(TODAY, created)
  assert.equal(dateKey(anchor), TODAY)
  assert.equal(anchor.getHours(), 0)
})

test('锚点：今天刚记、今天就到期 → 取**记录时刻**（这条提醒确实是新的）', () => {
  const created = new Date('2026-10-15T19:30:00')
  const anchor = dayAnchor(TODAY, created)
  assert.equal(anchor.getTime(), created.getTime())
})

test('锚点：状态型提醒的锚点跨天会变（明天零点），但**已读不受它影响**', () => {
  const created = new Date('2026-10-10T09:00:00')
  const fridge = [fridgeFact({ createdAt: created, expiresOn: new Date('2026-10-16T00:00:00Z') })]

  const today = buildNotifications(input({ fridge }), NOW)
  const tomorrow = buildNotifications({ ...input({ fridge }), today: '2026-10-16' }, new Date('2026-10-16T09:00:00'))

  assert.notEqual(today[0].at, tomorrow[0].at, '锚点跨天确实变了（这是它该有的行为）')

  /*
   * 但**已读不按锚点判**：`mergeStored` 只认库里那一条自己的 `readAt`。
   * 所以"今天标过已读、明天又亮"这件事在结构上不会发生——
   * 这正是这次把已读从"时间戳比较"改成"逐条记录"的原因
   * （用户 2026-10-15：「需要**真的已读**时才清」）。
   */
  assert.equal(unreadCount(mergeStored(today, storedFor(today, [today[0].id]), USER)), 0)
  const laterRows = mergeStored(tomorrow, storedFor(today, [today[0].id]), USER)
  assert.equal(unreadCount(laterRows), 0, '同一条读过之后，锚点变了也不该重新变未读')
})

test('锚点：同一批里最新的那条决定这条提醒的时刻（不能取最早的）', () => {
  const fridge = [
    fridgeFact({ id: 'old', name: '旧食材', createdAt: new Date('2026-10-01T09:00:00'), expiresOn: new Date('2026-10-16T00:00:00Z') }),
    fridgeFact({ id: 'new', name: '刚记的', createdAt: new Date('2026-10-15T19:00:00'), expiresOn: new Date('2026-10-16T00:00:00Z') }),
  ]
  const items = buildNotifications(input({ fridge }), NOW)
  // 取"最晚"那个锚点：晚上刚记的那一样让它带上今晚的时刻（而不是 10-01 或今天零点）
  assert.equal(new Date(items[0].at).getTime(), new Date('2026-10-15T19:00:00').getTime())
})

test('每一条都带稳定 id 与去处：前端不按 kind 硬编码跳转表', () => {
  const rows = buildNotifications(
    input({
      plan: [planFact()],
      done: [doneFact()],
      fridge: [fridgeFact({ expiresOn: new Date('2026-10-16T00:00:00Z') })],
      prep: [prepFact()],
    }),
    NOW,
  )
  assert.deepEqual(
    rows.map((row) => [row.kind, row.to]).sort(),
    [
      ['done', '/order/2026-10-15-DINNER'],
      ['expiry', '/fridge'],
      ['plan', '/order/2026-10-15-DINNER'],
      ['prep', '/prep'],
    ].sort(),
  )
  // id 唯一（列表 key 直接用它）
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)
})

test('备菜窗口是 3 天（与冰箱那个阈值同数、理由不同，所以各自留一个常量）', () => {
  assert.equal(PREP_WINDOW_DAYS, 3)
})

/*
 * `mealKey`：这条提醒**属于哪一餐**。
 *
 * 它存在的唯一理由是让点单列表能把"这张卡有事没看过"标出来（用户 2026-10-14：
 * 「订单有红点，但是里面的卡片看不出来哪个是提醒的」）。所以判据只有一条：
 * **能在列表上找到那张卡的两类（菜单、做好了）必须给 mealKey，其余一律 null**——
 * 给不出 mealKey 的那些不是"漏了"，是**本来就没有那张卡**（快过期指向冰箱；
 * 备菜说的是"这一餐还空着"，空着才没有卡）。前端据此排除，不必自己猜。
 */
test('mealKey：菜单/做好了给出是哪一餐；快过期与该备菜是 null（它们没有对应的卡）', () => {
  const rows = buildNotifications(
    input({
      plan: [planFact()],
      done: [doneFact()],
      fridge: [fridgeFact({ expiresOn: new Date('2026-10-16T00:00:00Z') })],
      prep: [prepFact()],
    }),
    NOW,
  )
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row.mealKey]))
  assert.deepEqual(byKind, {
    plan: '2026-10-15-DINNER',
    done: '2026-10-15-DINNER',
    expiry: null,
    prep: null,
  })
  // 与去处同源：进了那一餐详情的，`mealKey` 就必须是同一个（两处各拼一遍迟早分叉）
  for (const row of rows.filter((item) => item.to.startsWith('/order/'))) {
    assert.equal(row.to, `/order/${row.mealKey}`)
  }
})

/*
 * 四类的小标（`tag`）钉在这里，因为它们**直接显示在点单卡的角标上**，
 * 而角标紧挨着状态戳——用名词（"菜单"）会读成"这里有一份菜单"，像状态而不像"有事没看"。
 * 用户 2026-10-14 就是看着那颗角标说的「菜单那条改为选好了」。
 */
test('小标写的是动作而不是名词：菜单那条叫「选好了」（与按钮上的原话同一个词）', () => {
  const rows = buildNotifications(
    input({
      plan: [planFact()],
      done: [doneFact()],
      fridge: [fridgeFact({ expiresOn: new Date('2026-10-16T00:00:00Z') })],
      prep: [prepFact()],
    }),
    NOW,
  )
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row.tag]))
  assert.deepEqual(byKind, {
    plan: '选好了',
    done: '做好了',
    expiry: '快过期',
    prep: '备菜',
  })
})

/*
 * 「谁做好的」留痕与「谁定的菜单」是同一时刻的第二件事，判据并排放在 orders.rules 里。
 * 三条钉住：DONE 记、CANCELED 清、其余不动。
 */
test('做好了要留痕（通知靠它才知道"这一餐刚做好"）；取消要清；其余不动', () => {
  assert.equal(doneStampFor('DONE'), 'stamp')
  assert.equal(doneStampFor('CANCELED'), 'clear')
  for (const status of ['PLANNED', 'COOKING', 'PENDING'] as const) {
    assert.equal(doneStampFor(status), 'keep', `${status} 不该动这条留痕`)
  }
})
