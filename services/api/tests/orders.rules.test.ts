import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
  ACTION_LABEL,
  todayKey,
  ALLOWED_TRANSITIONS,
  MEAL_SLOTS,
  NOTE_MAX_LENGTH,
  ORDER_STATUSES,
  STATUS_LABEL,
  aggregateItems,
  canAddItem,
  dayOptions,
  dateKey,
  dateOnly,
  isAllowedTransition,
  mealKeyOf,
  nextActionsFor,
  parseMealDate,
  parseMealKey,
  parseNote,
  parseSlot,
  parseStatus,
  photoVisibleTo,
  revivedStatus,
  visibleToMember,
} from '../src/modules/orders/orders.rules'
import { CAPABILITIES } from '../src/modules/family/family.roles'

// 点单的纯规则（M3 / F3-01~F3-05，见 DECISIONS D-022）。
// 这些用例不碰数据库——需要 MySQL 的部分由 scripts/verify-orders-http.cjs 用真实请求验。

// ---------- 状态机（F3-02） ----------

test('状态机只放行图示的那几步，不跳级不回退', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.PENDING, ['PLANNED', 'CANCELED'])
  assert.deepEqual(ALLOWED_TRANSITIONS.PLANNED, ['COOKING', 'CANCELED'])
  assert.deepEqual(ALLOWED_TRANSITIONS.COOKING, ['DONE'])
  // 终态：已做好 / 已取消都不能再动（要重做就"再点一次"新建一餐）
  assert.deepEqual(ALLOWED_TRANSITIONS.DONE, [])
  assert.deepEqual(ALLOWED_TRANSITIONS.CANCELED, [])

  assert.ok(isAllowedTransition('PENDING', 'PLANNED'))
  assert.ok(isAllowedTransition('COOKING', 'DONE'))
  // 跳级与回退都要被挡住
  assert.ok(!isAllowedTransition('PENDING', 'COOKING'), '待确认不能直接跳到准备中')
  assert.ok(!isAllowedTransition('PENDING', 'DONE'), '待确认不能直接标成已做好')
  assert.ok(!isAllowedTransition('DONE', 'COOKING'), '已做好不能回退')
  assert.ok(!isAllowedTransition('CANCELED', 'PENDING'), '已取消不能复活')
})

test('每个状态都有中文标签与动作文案（界面直接用，不再自己拼）', () => {
  for (const status of ORDER_STATUSES) {
    assert.ok(STATUS_LABEL[status], `${status} 缺状态标签`)
    assert.ok(ACTION_LABEL[status], `${status} 缺动作文案`)
  }
  assert.equal(STATUS_LABEL.PENDING, '待确认')
  assert.equal(STATUS_LABEL.PLANNED, '已安排')
  assert.equal(STATUS_LABEL.CANCELED, '已取消')
})

test('流转权限按目标状态算，且复用 M2 的能力键（不新增）', () => {
  // 掌勺人/帮厨：能推 待确认→已安排→准备中，能确认做好，能取消
  for (const role of ['OWNER', 'COOK'] as const) {
    const pending = nextActionsFor(role, 'PENDING').map(action => action.status)
    assert.deepEqual(pending, ['PLANNED', 'CANCELED'], `${role} 在待确认阶段应能安排或取消`)
    assert.deepEqual(nextActionsFor(role, 'COOKING').map(a => a.status), ['DONE'], `${role} 应能确认做好`)
  }
  // 吃货：什么状态都推不动（点菜可以，改状态不行）
  for (const status of ORDER_STATUSES) {
    assert.deepEqual(nextActionsFor('EATER', status), [], `吃货不该能推动 ${status}`)
  }
  // 能力点确实来自 M2 那张表
  assert.equal(CAPABILITIES.MENU_MANAGE, 'menu.manage')
  assert.equal(CAPABILITIES.MENU_CONFIRM, 'menu.confirm')
})

test('会影响别人的动作标了 needsConfirm（前端据此弹二次确认）', () => {
  const cancel = nextActionsFor('OWNER', 'PENDING').find(action => action.status === 'CANCELED')
  assert.equal(cancel?.needsConfirm, true, '取消整餐要二次确认')
  const plan = nextActionsFor('OWNER', 'PENDING').find(action => action.status === 'PLANNED')
  assert.equal(plan?.needsConfirm, false, '「选好了」是正常推进，不该打扰用户')
})

test('共享开关关闭时，只有吃货被收窄到"只看我的"', () => {
  assert.equal(visibleToMember(true, 'EATER'), 'family')
  assert.equal(visibleToMember(true, 'OWNER'), 'family')
  // 关掉共享：吃货看不到别人点的；掌勺人/帮厨要负责做饭，仍看全量
  assert.equal(visibleToMember(false, 'EATER'), 'mine')
  assert.equal(visibleToMember(false, 'COOK'), 'family')
  assert.equal(visibleToMember(false, 'OWNER'), 'family')
})

test('取消过的餐还能重新点菜，并复活成待确认', () => {
  // 一餐的「日期+餐次」在库里唯一：取消后若永久不能点，一家人取消晚餐就再也点不了这一餐了
  assert.ok(canAddItem('PENDING'))
  assert.ok(canAddItem('CANCELED'), '被取消的餐必须能重新点菜')
  assert.ok(!canAddItem('PLANNED'), '已安排的餐不能再加点（先取消）')
  assert.ok(!canAddItem('COOKING'), '正在做的餐不能再加点')
  assert.ok(!canAddItem('DONE'), '已做好是终态（连取消都不行）')

  assert.equal(revivedStatus('CANCELED'), 'PENDING', '加菜要把整餐拉回待确认')
  assert.equal(revivedStatus('PENDING'), 'PENDING', '正常状态不动')
})

// ---------- 日期与餐次（F3-01） ----------

const now = new Date('2026-10-12T09:30:00.000Z')

test('可点日期是今天与明天，后天的菜点不了', () => {
  assert.deepEqual(dayOptions(now), [
    { value: '2026-10-12', label: '今天' },
    { value: '2026-10-13', label: '明天' },
  ])
  assert.equal(dateKey(parseMealDate('2026-10-12', now)), '2026-10-12')
  assert.equal(dateKey(parseMealDate('2026-10-13', now)), '2026-10-13')
  // 昨天/后天都不行（更远的安排归 M4 菜单）
  assert.throws(() => parseMealDate('2026-10-14', now), BadRequestException)
  assert.throws(() => parseMealDate('2026-10-11', now), BadRequestException)
  assert.throws(() => parseMealDate('10/12', now), BadRequestException)
  assert.throws(() => parseMealDate(undefined, now), BadRequestException)
})

test('餐次只认午餐与晚餐', () => {
  assert.deepEqual(MEAL_SLOTS, ['LUNCH', 'DINNER'])
  assert.equal(parseSlot('LUNCH'), 'LUNCH')
  assert.equal(parseSlot('DINNER'), 'DINNER')
  assert.throws(() => parseSlot('BREAKFAST'), BadRequestException)
  assert.throws(() => parseSlot('lunch'), BadRequestException, '大小写不宽容：前端只用接口给的枚举值')
})

test('状态解析拒绝未知值（不能从外部塞进非法状态）', () => {
  assert.equal(parseStatus('DONE'), 'DONE')
  for (const bad of ['done', 'FINISHED', '', undefined, null, 123]) {
    assert.throws(() => parseStatus(bad), BadRequestException, `${String(bad)} 应被拒`)
  }
})

test('餐次标识可解析且拒绝畸形输入', () => {
  const { mealDate, meal } = parseMealKey('2026-10-13-DINNER')
  assert.equal(dateKey(mealDate), '2026-10-13')
  assert.equal(meal, 'DINNER')
  assert.equal(mealKeyOf(dateOnly('2026-10-13'), 'DINNER'), '2026-10-13-DINNER')
  for (const bad of ['2026-10-13', '2026-10-13-BREAKFAST', '2026/10/13-DINNER', '']) {
    assert.throws(() => parseMealKey(bad), BadRequestException, `${bad} 应被拒`)
  }
})

test('「今天」按服务器本地日历算，不用 UTC（北京时间凌晨不会算成昨天）', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    // 北京时间 2026-10-13 01:00 = UTC 2026-10-12 17:00
    const earlyMorning = new Date('2026-10-12T17:00:00Z')
    assert.equal(todayKey(earlyMorning), '2026-10-13', '凌晨 1 点必须算今天，而不是 UTC 的昨天')
    assert.equal(dateKey(earlyMorning), '2026-10-12', '已入库的日期仍按 UTC 读回（两者口径不同是刻意的）')

    // 可选日期也要跟着本地日历走
    const options = dayOptions(earlyMorning)
    assert.deepEqual(options.map(o => o.value), ['2026-10-13', '2026-10-14'])
    assert.equal(parseMealDate('2026-10-13', earlyMorning) instanceof Date, true, '凌晨仍能点"今天"')
    assert.throws(() => parseMealDate('2026-10-12', earlyMorning), BadRequestException, '不能再点"昨天"')

    // 北京时间同一天的晚上，仍应是同一天（两边一致）
    const lateEvening = new Date('2026-10-13T15:30:00Z') // 北京 23:30
    assert.equal(todayKey(lateEvening), '2026-10-13')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('日期只取日期部分（不带时区漂移）', () => {
  // 传 UTC 零点，避免"当天变成前一天/后一天"
  const parsed = dateOnly('2026-10-13')
  assert.equal(parsed.getUTCFullYear(), 2026)
  assert.equal(parsed.getUTCMonth(), 9, '10 月对应索引 9')
  assert.equal(parsed.getUTCDate(), 13)
  assert.equal(parsed.getUTCHours(), 0)
})

// ---------- 备注（F3-05） ----------

test('备注：空白视为没写，超长被拒', () => {
  assert.equal(parseNote('  小满那份不要辣  '), '小满那份不要辣')
  assert.equal(parseNote('   '), null, '只有空格等于没填')
  assert.equal(parseNote(undefined), null)
  assert.equal(parseNote(null), null)
  assert.equal(parseNote('辣'.repeat(NOTE_MAX_LENGTH)), '辣'.repeat(NOTE_MAX_LENGTH))
  assert.throws(() => parseNote('辣'.repeat(NOTE_MAX_LENGTH + 1)), BadRequestException)
  assert.throws(() => parseNote(123), BadRequestException)
})

// ---------- 卡片合并（F3-04） ----------

function item(overrides: Partial<Parameters<typeof aggregateItems>[0][number]> = {}) {
  return {
    id: 'i1',
    userId: 'u1',
    recipeId: 'r1',
    recipeName: '番茄炒蛋',
    recipeImage: 'https://img/1.jpg',
    note: null as string | null,
    user: { nickname: '妈妈', avatar: '🍳' },
    ...overrides,
  }
}

test('同一道菜多人点会合并成一行，份数相加、备注按人分列', () => {
  const card = aggregateItems(
    [
      item({ id: 'i1', userId: 'u1', user: { nickname: '妈妈', avatar: '🍳' }, note: null }),
      item({ id: 'i2', userId: 'u2', user: { nickname: '小满', avatar: '🐰' }, note: '不要辣' }),
      item({ id: 'i3', userId: 'u2', user: { nickname: '小满', avatar: '🐰' }, recipeId: 'r2', recipeName: '红烧排骨' }),
    ],
    'u1',
  )

  assert.equal(card.dishCount, 3, 'dishCount 是份数（条目数），不是菜名数')
  assert.equal(card.dishes.length, 2, '两道不同的菜')
  const tomato = card.dishes.find(dish => dish.name === '番茄炒蛋')
  assert.equal(tomato?.count, 2)
  assert.deepEqual(tomato?.notes, [{ nickname: '小满', text: '不要辣' }], '没填备注的那份不产生备注行')
  // 点菜人去重，按首次出现顺序
  assert.deepEqual(card.orderers, ['妈妈', '小满'])
  assert.equal(card.ordererCount, 2)
  // mineCount 与 mineItemIds 是"我"的份数（前端给「撤回我这份」）
  assert.equal(card.mineCount, 1)
  assert.deepEqual(tomato?.mineItemIds, ['i1'])
})

test('同一个人把同一道菜点两次 = 两份（合并成一行）', () => {
  const card = aggregateItems([item({ id: 'i1' }), item({ id: 'i2' })], 'u1')
  assert.equal(card.dishes.length, 1)
  assert.equal(card.dishes[0].count, 2)
  assert.deepEqual(card.dishes[0].mineItemIds, ['i1', 'i2'], '两份都能撤回')
  assert.equal(card.orderers.length, 1, '点菜人只算一个')
})

test('菜谱被删（没 recipeId）时按菜名合并，历史点单仍显示得出来', () => {
  const card = aggregateItems(
    [
      item({ id: 'i1', recipeId: null, recipeName: '外婆的腌笃鲜' }),
      item({ id: 'i2', recipeId: null, recipeName: '外婆的腌笃鲜' }),
      item({ id: 'i3', recipeId: null, recipeName: '别的菜' }),
    ],
    'u1',
  )
  assert.equal(card.dishes.length, 2)
  assert.equal(card.dishes[0].count, 2)
})

test('没人点菜时卡片是空的（而不是报错）', () => {
  const card = aggregateItems([], 'u1')
  assert.deepEqual(card.dishes, [])
  assert.deepEqual(card.orderers, [])
  assert.equal(card.dishCount, 0)
  assert.equal(card.mineCount, 0)
})

// ---------- 成品照张数的可见范围（F9-08 与 D-023 对齐） ----------

test('共享开着：同一家的照片互相可见（掌勺人与吃货都是）', () => {
  assert.equal(photoVisibleTo(true, 'EATER', 'u1', 'u2'), true)
  assert.equal(photoVisibleTo(true, 'OWNER', 'u1', 'u2'), true)
})

test('共享关闭：吃货只看得到自己传的照片（张数也不能漏出别人的）', () => {
  assert.equal(photoVisibleTo(false, 'EATER', 'u1', 'u1'), true, '自己传的还看得见')
  assert.equal(photoVisibleTo(false, 'EATER', 'u1', 'u2'), false, '别人传的不计数')
})

test('共享关闭不影响掌勺人/帮厨（他们要做饭，得看得见成品照）', () => {
  assert.equal(photoVisibleTo(false, 'OWNER', 'u1', 'u2'), true)
  assert.equal(photoVisibleTo(false, 'COOK', 'u1', 'u2'), true)
})
