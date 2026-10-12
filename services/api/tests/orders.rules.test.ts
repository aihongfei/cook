import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
  ACTION_LABEL,
  canRepeatFrom,
  dishKey,
  planRepeat,
  parseHistoryQuery,
  historyRange,
  hasEarlier,
  weekdayOf,
  HISTORY_PAGE_SIZE_DEFAULT,
  HISTORY_PAGE_SIZE_MAX,
  todayKey,
  ALLOWED_TRANSITIONS,
  MEAL_SLOTS,
  NOTE_MAX_LENGTH,
  ORDER_STATUSES,
  PLAN_DAYS_DEFAULT,
  PLAN_DAYS_MAX,
  STATUS_LABEL,
  aggregateItems,
  canAddItem,
  confirmStampFor,
  dayOptions,
  dayWindow,
  dateKey,
  dateOnly,
  isAllowedTransition,
  mealKeyOf,
  nextActionsFor,
  parseMealDate,
  parseMealKey,
  parseNote,
  parseDishName,
  parseItemTarget,
  parsePlanDays,
  parseSlot,
  parseStatus,
  parseDinerCount,
  photoVisibleTo,
  todayMealState,
  DINER_COUNT_MAX,
  FREE_DISH_NAME_MAX,
  ORDER_DAY_SPAN,
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

test('可点日期是今天起 7 天（本周菜单要安排后天、备菜计划要看满一周）', () => {
  assert.deepEqual(dayOptions(now), [
    { value: '2026-10-12', label: '今天' },
    { value: '2026-10-13', label: '明天' },
    { value: '2026-10-14', label: '后天' },
    { value: '2026-10-15', label: '周四' },
    { value: '2026-10-16', label: '周五' },
    { value: '2026-10-17', label: '周六' },
    { value: '2026-10-18', label: '周日' },
  ])
  assert.equal(dateKey(parseMealDate('2026-10-12', now)), '2026-10-12')
  assert.equal(dateKey(parseMealDate('2026-10-14', now)), '2026-10-14', '后天要能点——不然本周菜单那行的「去安排」是死路')
  assert.equal(dateKey(parseMealDate('2026-10-18', now)), '2026-10-18', '第 7 天也要能点——备菜计划每一行都要能安排')
  // 昨天与第 8 天不行：**能看的范围与能安排的范围一致**（备菜页看几天就必须能安排几天）
  assert.throws(() => parseMealDate('2026-10-19', now), BadRequestException)
  assert.throws(() => parseMealDate('2026-10-11', now), BadRequestException)
  assert.throws(() => parseMealDate('10/12', now), BadRequestException)
  assert.throws(() => parseMealDate(undefined, now), BadRequestException)
})

test('可选日期窗口跟着 ORDER_DAY_SPAN 走，提示语不会说错', () => {
  assert.equal(ORDER_DAY_SPAN, 7)
  assert.equal(ORDER_DAY_SPAN, PLAN_DAYS_MAX, '能安排的窗口与能看的窗口是同一个数，否则又会出现"看得见安排不了"的行')
  // 越界时的文案由窗口自己生成：写成常量字符串的话，改了窗口就会和实际范围对不上
  assert.throws(() => parseMealDate('2026-11-01', now), /只能点从今天到周日这 7 天内的菜/)
})

test('dayWindow 给的是「哪一天」标量 + 星期，且不返回 Date（避免拿本地午夜去查库）', () => {
  const window = dayWindow(7, now)
  assert.deepEqual(window.map(day => day.value), [
    '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
  ])
  assert.deepEqual(window.slice(0, 3).map(day => day.label), ['今天', '明天', '后天'])
  // 第 4 天起改用星期：7 天窗口里再写"大后天""大大后天"就没法看了
  assert.deepEqual(window.slice(3).map(day => day.label), ['周四', '周五', '周六', '周日'])
  assert.deepEqual(window.map(day => day.weekday), ['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
  assert.equal('date' in window[0], false, '窗口里不该带 Date 对象：存库的日子要用 dateOnly(value) 换算')
})

test('dayWindow 跨月按日历递进（不是加毫秒）', () => {
  const endOfMonth = new Date('2026-10-30T09:30:00.000Z')
  assert.deepEqual(dayWindow(3, endOfMonth).map(day => day.value), ['2026-10-30', '2026-10-31', '2026-11-01'])
})

test('看几天：默认 3 天、上限 7 天，非法值直接拒', () => {
  assert.equal(parsePlanDays(undefined), PLAN_DAYS_DEFAULT)
  assert.equal(parsePlanDays(null), PLAN_DAYS_DEFAULT)
  assert.equal(parsePlanDays(''), PLAN_DAYS_DEFAULT)
  assert.equal(PLAN_DAYS_DEFAULT, 3)
  assert.equal(PLAN_DAYS_MAX, 7)
  assert.equal(parsePlanDays('5'), 5)
  assert.equal(parsePlanDays(7), 7)
  for (const bad of ['0', '-1', '8', '2.5', 'abc']) {
    assert.throws(() => parsePlanDays(bad), BadRequestException, `${bad} 应被拒`)
  }
})

// ---------- 自由菜品（F3-10） ----------

test('加菜目标二选一：菜谱 id 或自写菜名，两个都给要拒', () => {
  assert.deepEqual(parseItemTarget({ recipeId: 'r1' }), { kind: 'recipe', recipeId: 'r1' })
  assert.deepEqual(parseItemTarget({ recipeId: '  r1  ' }), { kind: 'recipe', recipeId: 'r1' }, 'id 去首尾空格')
  assert.deepEqual(parseItemTarget({ dishName: '外婆的红烧肉' }), { kind: 'dish', dishName: '外婆的红烧肉' })
  assert.deepEqual(parseItemTarget({ dishName: '  外婆的红烧肉  ' }), { kind: 'dish', dishName: '外婆的红烧肉' }, '菜名去首尾空格')
  // 两个都给：静默挑一个会把用户的意图藏起来
  assert.throws(() => parseItemTarget({ recipeId: 'r1', dishName: '红烧肉' }), BadRequestException)
  // 都不给
  assert.throws(() => parseItemTarget({}), BadRequestException)
  assert.throws(() => parseItemTarget({ recipeId: '', dishName: null }), BadRequestException)
})

test('自写菜名：必须是文字、不能空、上限 30 字', () => {
  assert.equal(parseDishName('蛋炒饭'), '蛋炒饭')
  assert.equal(FREE_DISH_NAME_MAX, 30)
  assert.equal(parseDishName('好'.repeat(30)).length, 30, '刚好 30 字要放行')
  for (const bad of ['', '   ', '好'.repeat(31)]) {
    assert.throws(() => parseDishName(bad), BadRequestException, `${JSON.stringify(bad)} 应被拒`)
  }
  for (const bad of [undefined, null, 123, {}]) {
    assert.throws(() => parseDishName(bad), BadRequestException, `${String(bad)} 应被拒`)
  }
  // 只有空白字符串时走 dish 分支报"菜名不能为空"，而不是报"两个都没给"——文案要贴用户实际做的事
  assert.throws(() => parseItemTarget({ recipeId: '', dishName: '  ' }), /菜名不能为空/)
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
    assert.deepEqual(options.map(o => o.value), [
      '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19',
    ])
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

// ---------- 就餐人数与今日安排（M4 / F4-01、F4-05） ----------

test('就餐人数收正整数，空值表示清除设定（不是 0）', () => {
  assert.equal(parseDinerCount(3), 3)
  assert.equal(parseDinerCount('4'), 4, '表单传字符串也要收')
  assert.equal(parseDinerCount(null), null)
  assert.equal(parseDinerCount(undefined), null)
  assert.equal(parseDinerCount(''), null, '空字符串同样是清除')
})

test('就餐人数拒绝 0、负数、小数与超上限（0 个人吃饭没有意义，不能当哨兵）', () => {
  assert.throws(() => parseDinerCount(0), BadRequestException)
  assert.throws(() => parseDinerCount(-1), BadRequestException)
  assert.throws(() => parseDinerCount(2.5), BadRequestException)
  assert.throws(() => parseDinerCount('三个'), BadRequestException)
  assert.throws(() => parseDinerCount(DINER_COUNT_MAX + 1), BadRequestException)
  assert.equal(parseDinerCount(DINER_COUNT_MAX), DINER_COUNT_MAX, '上限本身要收')
})

test('今日安排的行状态：没点菜单独一类，已做好/已取消归为"settled"', () => {
  assert.equal(todayMealState(null), 'none', '还没人点')
  assert.equal(todayMealState('PENDING'), 'open')
  assert.equal(todayMealState('PLANNED'), 'open')
  assert.equal(todayMealState('COOKING'), 'open')
  assert.equal(todayMealState('DONE'), 'settled')
  assert.equal(todayMealState('CANCELED'), 'settled', '取消了就不再引导（那是用户自己的决定）')
})

// ---------- 确认菜单的留痕（M4 / F4-05，口径见 D-030） ----------

/*
 * 判据只有一条：**这一版菜单还算不算数**。
 * 抽成纯规则是为了在这里钉住它——服务层那三岔写在 MySQL 里，改错了要跑接口才看得出来。
 */
test('定菜单才记留痕：开始做/做好了都不动它（做的还是那一版菜单）', () => {
  assert.equal(confirmStampFor('PLANNED'), 'stamp', '定下这一版 → 记"谁、何时"')
  assert.equal(confirmStampFor('COOKING'), 'keep', '开始做：菜单没变，留痕还得在')
  assert.equal(confirmStampFor('DONE'), 'keep', '做好了：还是那一版菜单')
  assert.equal(confirmStampFor('CANCELED'), 'clear', '取消了：这一版作废，"谁定的"不再成立')
})

test('回到待确认（取消后重新加菜）也要清留痕——菜单重开，上一版就翻篇了', () => {
  // 复活路径在 addItem 里（`revivedStatus(status) !== status` 时清 confirmedById/At），
  // 这里钉住"它确实会走到 PENDING"这一半；写库那一半由接口验收覆盖（R-024）。
  assert.equal(revivedStatus('CANCELED'), 'PENDING')
  assert.equal(confirmStampFor('PENDING'), 'keep', 'PENDING 不经过状态接口（状态机没有回退），清留痕由 addItem 负责')
})

// ---------- 再点一次（F3-06 / D-034） ----------

test('能照哪一餐再点一次：定局的那一餐（做好了 / 已取消 / 日子过去了）', () => {
  const today = '2026-10-13'
  // 终态：做好了、已取消（D-022 里"要重做就再点一次"说的就是这一步）
  assert.equal(canRepeatFrom('DONE', today, today), true)
  assert.equal(canRepeatFrom('CANCELED', today, today), true)
  // 忘了点"做好了"，可日子已经过去了——那也是过去的饭，认它
  assert.equal(canRepeatFrom('PENDING', '2026-10-12', today), true, '昨天还挂在待确认的，照样能照它点')
  assert.equal(canRepeatFrom('PLANNED', '2026-10-10', today), true)
  assert.equal(canRepeatFrom('COOKING', '2026-10-01', today), true)
})

test('还在收集中的这一餐不给这个入口（要加菜直接点那道菜）', () => {
  const today = '2026-10-13'
  // 今天/明天还没定局的，不给：它正在收集中，"复制它"没有意义（组合 F4-04 另有入口）
  assert.equal(canRepeatFrom('PENDING', today, today), false)
  assert.equal(canRepeatFrom('PLANNED', today, today), false)
  assert.equal(canRepeatFrom('COOKING', today, today), false)
  assert.equal(canRepeatFrom('PENDING', '2026-10-14', today), false, '明天那一餐也一样：还没到点')
})

test('照抄时已有的菜跳过、每种只收一份（不叠加份数）', () => {
  const source = [
    { recipeId: 'r1', name: '番茄炒蛋' },
    { recipeId: 'r2', name: '红烧排骨' },
    { recipeId: 'r2', name: '红烧排骨' }, // 两个人各点了一份，来源里是两条记录
    { recipeId: 'r3', name: '凉拌黄瓜' },
  ]
  const plan = planRepeat([{ recipeId: 'r1', name: '番茄炒蛋' }], source)

  assert.deepEqual(plan.toAdd.map(d => d.name), ['红烧排骨', '凉拌黄瓜'], '已有的跳过；重复的两条只收一份')
  assert.deepEqual(plan.skipped.map(d => d.name), ['番茄炒蛋'])
})

test('跳过判定按"菜的同一性"：有 recipeId 认 id，没有的认菜名', () => {
  const existing = [
    { recipeId: 'r1', name: '番茄炒蛋' },
    { recipeId: null, name: '外婆的腌笃鲜' },
  ]
  const plan = planRepeat(existing, [
    { recipeId: 'r1', name: '番茄炒蛋（改过名）' }, // 同一道菜：改名了也认得出（认 id）
    { recipeId: 'r9', name: '外婆的腌笃鲜' }, // 不同一道：有 id 就认 id，不能因为同名就跳过
    { recipeId: null, name: '外婆的腌笃鲜' }, // 自由菜品：认菜名，跳过
  ])

  assert.deepEqual(plan.toAdd.map(d => d.name), ['外婆的腌笃鲜'], '同名但来自菜谱的算新菜')
  assert.deepEqual(plan.skipped.map(d => d.name), ['番茄炒蛋（改过名）', '外婆的腌笃鲜'])
})

test('dishKey：有 id 认 id、没有的认菜名（卡片合并与照抄判定必须用同一个键）', () => {
  assert.equal(dishKey({ recipeId: 'r1', name: '番茄炒蛋' }), 'r1')
  assert.equal(dishKey({ recipeId: null, name: '外婆的腌笃鲜' }), 'name:外婆的腌笃鲜')
  // 关键：有 id 时菜名不参与判定——改过名的同一道菜不该被当成两道
  assert.equal(
    dishKey({ recipeId: 'r1', name: '番茄炒蛋' }),
    dishKey({ recipeId: 'r1', name: '番茄炒蛋（家常版）' }),
  )
})

test('目标那一餐是空的：整桌照抄，一个都不跳过', () => {
  const plan = planRepeat([], [
    { recipeId: 'r1', name: '番茄炒蛋' },
    { recipeId: null, name: '外婆的腌笃鲜' },
  ])
  assert.equal(plan.toAdd.length, 2)
  assert.equal(plan.skipped.length, 0)
})

// ---------- 点单历史与美食日记（F3-09 / D-035） ----------

test('历史一页的日期区间：以 to 为终点往前数 pageSize 天（含两端）', () => {
  const range = historyRange({ to: '2026-10-13', pageSize: 3 })
  assert.deepEqual(range.days, ['2026-10-11', '2026-10-12', '2026-10-13'], '升序铺开，含两端')
  assert.equal(range.from, '2026-10-11')
  assert.equal(range.to, '2026-10-13')
})

test('历史翻页跨月/跨年也对（不是简单减天数）', () => {
  const month = historyRange({ to: '2026-11-02', pageSize: 5 })
  assert.deepEqual(month.days, ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  const year = historyRange({ to: '2027-01-02', pageSize: 4 })
  assert.deepEqual(year.days, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
})

test('历史查询：to 默认今天、pageSize 默认 31', () => {
  const query = parseHistoryQuery({}, new Date(2026, 9, 13, 9, 0, 0))
  assert.equal(query.to, '2026-10-13')
  assert.equal(query.pageSize, HISTORY_PAGE_SIZE_DEFAULT)
})

test('历史查询：非法日期与越界的 pageSize 都要报 400', () => {
  assert.throws(() => parseHistoryQuery({ to: '2026/10/13' }), BadRequestException)
  assert.throws(() => parseHistoryQuery({ to: '20261013' }), BadRequestException)
  assert.throws(() => parseHistoryQuery({ pageSize: '0' }), BadRequestException)
  assert.throws(() => parseHistoryQuery({ pageSize: String(HISTORY_PAGE_SIZE_MAX + 1) }), BadRequestException)
  assert.throws(() => parseHistoryQuery({ pageSize: '3.5' }), BadRequestException)
  // 边界要放行
  assert.equal(parseHistoryQuery({ pageSize: String(HISTORY_PAGE_SIZE_MAX) }).pageSize, HISTORY_PAGE_SIZE_MAX)
  assert.equal(parseHistoryQuery({ pageSize: '1' }).pageSize, 1)
})

test('还能不能往前翻：只有库里确实还有更早的餐次才算有', () => {
  // 库里最早是 8/01，这一页从 9/01 起 → 还有更早的
  assert.equal(hasEarlier('2026-08-01', '2026-09-01'), true)
  // 库里最早就是这一页的第一天 → 到头了
  assert.equal(hasEarlier('2026-09-01', '2026-09-01'), false, '不早于这一页开头就是到头')
  // 库里最早比这一页还晚（今天才开始用）→ 也是到头
  assert.equal(hasEarlier('2026-09-20', '2026-09-01'), false)
  // 一张卡都没有 → 到头（不是"永远还能翻"）
  assert.equal(hasEarlier(null, '2026-09-01'), false, '空库不该让用户一直往前翻空白页')
})

test('星期标按本地日历算（不是 UTC）：东八区的周一不该显示成周日', () => {
  // 2026-10-13 是周二
  assert.equal(weekdayOf('2026-10-13'), '周二')
  assert.equal(weekdayOf('2026-10-12'), '周一')
  assert.equal(weekdayOf('2026-10-18'), '周日')
})
