import { describe, expect, it } from 'vitest'
import type { FridgeItem } from '@/api/fridge'
import type { MealProgressRow } from '@/api/orders'
import {
  COOK_HOUR, EXPIRY_HOUR, SCHEDULE_WINDOW_DAYS, cookReminders, expiryReminders, planLocalReminders,
  reminderIdOf, type LocalReminder,
} from './local-notify.rules'

/*
 * 本机通知的排程规则（M10 交付二）。
 *
 * 这一组测试盯的是**"什么时候会响、响的是什么、点了去哪儿"**——
 * 这几件事错了用户是感受得到的（该响没响、响了但内容不对、点了跳错页），
 * 而它们全都是纯函数能算清的，所以不放到真机上才发现。
 */

/** 固定"现在"：这些断言全都依赖"今天几号、几点"，不钉死会随运行时间飘 */
const NOW = new Date(2026, 9, 14, 8, 0, 0) // 2026-10-14 08:00 本地时间

function mealRow(overrides: Partial<MealProgressRow> = {}): MealProgressRow {
  return {
    meal: 'DINNER',
    label: '晚餐',
    state: 'open',
    status: 'PLANNED',
    statusLabel: '已安排',
    dishes: ['番茄炒蛋'],
    dishCount: 1,
    ordererCount: 1,
    dinerCount: null,
    mealKey: '2026-10-14-DINNER',
    photoCount: 0,
    canAdd: false,
    ...overrides,
  }
}

function fridgeItem(overrides: Partial<FridgeItem> = {}): FridgeItem {
  return {
    id: 'f1',
    name: '牛奶',
    amount: '半盒',
    zone: '冷藏',
    expiresOn: '2026-10-14',
    expiryLabel: '今天到期',
    attention: true,
    note: null,
    addedBy: '妈妈',
    addedAt: NOW.toISOString(),
    addedLabel: '今天',
    ...overrides,
  }
}

const planOf = (meals: MealProgressRow[], day = '2026-10-14') => [{ day, meals }]

describe('reminderIdOf：同一个键永远同一个数字', () => {
  it('稳定（同一键两次一致）——整批替换靠它，否则重复排会留下两条', () => {
    expect(reminderIdOf('cook:2026-10-14-DINNER')).toBe(reminderIdOf('cook:2026-10-14-DINNER'))
  })

  it('不同的键给不同的数字（撞了的表现是"少一条提醒"）', () => {
    const keys = [
      'cook:2026-10-14-LUNCH',
      'cook:2026-10-14-DINNER',
      'cook:2026-10-15-LUNCH',
      'expiry:2026-10-14',
    ]
    expect(new Set(keys.map(reminderIdOf)).size).toBe(keys.length)
  })

  it('是正整数：插件把它当 Int，负号在某些机型上会被当成另一个 id', () => {
    for (const key of ['cook:2026-10-14-DINNER', 'expiry:2026-10-14', '', 'a']) {
      const id = reminderIdOf(key)
      expect(Number.isInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThanOrEqual(2 ** 31 - 1)
    }
  })
})

describe('到点该做饭', () => {
  it('定了菜单、还没做好的那一餐，排在饭点前一小时', () => {
    const [reminder] = cookReminders(planOf([mealRow()]), NOW)
    expect(reminder.at.getHours()).toBe(COOK_HOUR.DINNER)
    expect(reminder.at.getDate()).toBe(14)
    expect(reminder.title).toBe('晚餐该做饭了')
    expect(reminder.to).toBe('/order/2026-10-14-DINNER')
    expect(reminder.kind).toBe('cook')
  })

  it('午餐与晚餐用各自的时刻（11:00 / 17:00）', () => {
    const rows = planOf([
      mealRow({ meal: 'LUNCH', label: '午餐', mealKey: '2026-10-14-LUNCH' }),
      mealRow({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-14-DINNER' }),
    ])
    const out = cookReminders(rows, NOW)
    expect(out.map((item) => [item.title, item.at.getHours()])).toEqual([
      ['午餐该做饭了', COOK_HOUR.LUNCH],
      ['晚餐该做饭了', COOK_HOUR.DINNER],
    ])
  })

  it('**没定人数**就不假装知道人数，但也不漏掉这件事', () => {
    const [reminder] = cookReminders(planOf([mealRow({ dinerCount: null })]), NOW)
    expect(reminder.body).toBe('1 道菜 · 还没定几个人吃')
  })

  it('定了人数就报人数', () => {
    const [reminder] = cookReminders(planOf([mealRow({ dinerCount: 4, dishCount: 3 })]), NOW)
    expect(reminder.body).toBe('3 道菜 · 4 个人吃')
  })

  it.each([
    ['还是待确认（可能还会改）', { status: 'PENDING' as const }],
    ['已经做好了（过去的事）', { status: 'DONE' as const }],
    ['已取消', { status: 'CANCELED' as const }],
  ])('%s → 不排提醒', (_label, override) => {
    expect(cookReminders(planOf([mealRow(override)]), NOW)).toEqual([])
  })

  it('开始做（COOKING）仍然提醒：那一餐还没上桌', () => {
    expect(cookReminders(planOf([mealRow({ status: 'COOKING' })]), NOW).length).toBe(1)
  })

  it('空餐次不排（没有菜就没有"要做饭"这回事）', () => {
    expect(cookReminders(planOf([mealRow({ dishCount: 0, dishes: [] })]), NOW)).toEqual([])
  })

  it('**已经过去的时刻不排**（今天下午才装上，不该补一条上午的"该做饭"）', () => {
    const evening = new Date(2026, 9, 14, 20, 0, 0)
    expect(cookReminders(planOf([mealRow()]), evening)).toEqual([])
  })

  it('窗口外的日子不排（与点菜窗口同数 7 天）', () => {
    const far = [{ day: '2026-10-21', meals: [mealRow({ mealKey: '2026-10-21-DINNER' })] }]
    // 第 7 天（10-21）在窗口内：0..6 天是 10-14…10-20
    expect(cookReminders(far, NOW, SCHEDULE_WINDOW_DAYS)).toEqual([])
    const last = [{ day: '2026-10-20', meals: [mealRow({ mealKey: '2026-10-20-DINNER' })] }]
    expect(cookReminders(last, NOW, SCHEDULE_WINDOW_DAYS).length).toBe(1)
  })

  it('窗口是参数：传 1 就只看今天', () => {
    const rows = [
      { day: '2026-10-14', meals: [mealRow({ mealKey: '2026-10-14-DINNER' })] },
      { day: '2026-10-15', meals: [mealRow({ mealKey: '2026-10-15-DINNER' })] },
    ]
    expect(cookReminders(rows, NOW, 1).map((item) => item.to)).toEqual(['/order/2026-10-14-DINNER'])
  })
})

describe('有东西到期', () => {
  it('当天到期的，早上排一条', () => {
    const [reminder] = expiryReminders([fridgeItem()], NOW)
    expect(reminder.at.getHours()).toBe(EXPIRY_HOUR)
    expect(reminder.title).toBe('冰箱里有 1 样今天到期')
    expect(reminder.body).toBe('牛奶')
    expect(reminder.to).toBe('/fridge')
  })

  it('多件合成**一条**（不按件刷屏）', () => {
    const items = [
      fridgeItem({ name: '牛奶' }),
      fridgeItem({ id: 'f2', name: '酸奶' }),
      fridgeItem({ id: 'f3', name: '豆腐' }),
      fridgeItem({ id: 'f4', name: '青菜' }),
    ]
    const [reminder] = expiryReminders(items, NOW)
    expect(reminder.title).toBe('冰箱里有 4 样今天到期')
    // 超过三样就报数，不把名字全铺开（通知栏一行放不下）
    expect(reminder.body).toBe('牛奶、酸奶、豆腐 等 4 样')
  })

  it('**没写保质期的不排**（那是"不知道什么时候坏"）', () => {
    expect(expiryReminders([fridgeItem({ expiresOn: null, expiryLabel: null })], NOW)).toEqual([])
  })

  it('**还有几天的提前排**：排在那天的早上，不是今天——"关闭也会响"就靠这一条', () => {
    // 关键：只在今天早上排一次的话，哪天早上 9 点前没打开过 App，那天就不会响。
    // 所以窗口内每一批东西都各自提前排给系统闹钟。
    const [reminder] = expiryReminders([fridgeItem({ expiresOn: '2026-10-17', expiryLabel: '还有 3 天' })], NOW)
    expect(reminder.at.getDate()).toBe(17)
    expect(reminder.at.getHours()).toBe(EXPIRY_HOUR)
    expect(reminder.title).toBe('冰箱里有 1 样今天到期')
  })

  it('不同天到期的分成多条，各排各天（同一天的才合成一条）', () => {
    const items = [
      fridgeItem({ name: '牛奶', expiresOn: '2026-10-15', expiryLabel: '明天到期' }),
      fridgeItem({ id: 'f2', name: '酸奶', expiresOn: '2026-10-15', expiryLabel: '明天到期' }),
      fridgeItem({ id: 'f3', name: '豆腐', expiresOn: '2026-10-16', expiryLabel: '还有 2 天' }),
    ]
    const out = expiryReminders(items, NOW)
    expect(out.map((item) => [item.at.getDate(), item.title])).toEqual([
      [15, '冰箱里有 2 样今天到期'],
      [16, '冰箱里有 1 样今天到期'],
    ])
    expect(out[0].body).toBe('牛奶、酸奶')
  })

  it('窗口外的不排（一周都没打开过，手上的数据早就不作数了）', () => {
    // 第 7 天（10-21）在窗口外：0..6 天是 10-14…10-20
    expect(expiryReminders([fridgeItem({ expiresOn: '2026-10-21', expiryLabel: '还有 7 天' })], NOW)).toEqual([])
    const last = expiryReminders([fridgeItem({ expiresOn: '2026-10-20', expiryLabel: '还有 6 天' })], NOW)
    expect(last.length).toBe(1)
  })

  it('已经过期但还没处理掉的，当天早上说最后一次（如实说"已经过期"）', () => {
    const items = [
      fridgeItem({ name: '牛奶', expiresOn: '2026-10-14', expiryLabel: '今天到期' }),
      fridgeItem({ id: 'f2', name: '酸奶', expiresOn: '2026-10-13', expiryLabel: '过期 1 天' }),
    ]
    const [reminder] = expiryReminders(items, NOW)
    expect(reminder.title).toBe('冰箱里有 2 样该处理了')
    expect(reminder.body).toBe('牛奶、酸奶（1 样已经过期）')
  })

  it('**过期之后不再往后排**（那条只说在今天早上，不是每天都催）', () => {
    const items = [fridgeItem({ expiresOn: '2026-10-13', expiryLabel: '过期 1 天' })]
    expect(expiryReminders(items, NOW).length).toBe(1) // 今天早上补最后一次
    // 今天早上也过了 → 一条都不排（不再天天催）
    expect(expiryReminders(items, new Date(2026, 9, 14, 12, 0, 0))).toEqual([])
  })

  it('过期的时刻已过就不补（早上 9 点过了就等明天）', () => {
    const noon = new Date(2026, 9, 14, 12, 0, 0)
    expect(expiryReminders([fridgeItem()], noon)).toEqual([])
  })
})

describe('整批：排序与形状', () => {
  it('按时刻排好（早的在前），同一时刻按 id 稳定', () => {
    const items = [fridgeItem()]
    const rows = planOf([
      mealRow({ meal: 'LUNCH', label: '午餐', mealKey: '2026-10-14-LUNCH' }),
      mealRow({ mealKey: '2026-10-14-DINNER' }),
      mealRow({ mealKey: '2026-10-15-LUNCH', meal: 'LUNCH', label: '午餐' }),
    ])
    const out = planLocalReminders({ plan: rows, fridge: items }, NOW)
    const times = out.map((item) => item.at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    // 早上 9 点的到期提醒排在最前（今天 11 点的午饭之前）
    expect(out[0].kind).toBe('expiry')
  })

  it('**提前排满一个窗口**：做饭与到期都排上（关闭 App 也能响的前提）', () => {
    // 这是 M10 交付二最关键的一条性质：一次性把窗口内所有该响的都交给系统闹钟，
    // 而不是"每天现算"——现算的话 App 不打开就不会响。
    const rows = [
      { day: '2026-10-15', meals: [mealRow({ mealKey: '2026-10-15-DINNER' })] },
      { day: '2026-10-16', meals: [mealRow({ mealKey: '2026-10-16-LUNCH', meal: 'LUNCH', label: '午餐' })] },
    ]
    const items = [
      fridgeItem({ name: '牛奶', expiresOn: '2026-10-15', expiryLabel: '明天到期' }),
      fridgeItem({ id: 'f2', name: '酸奶', expiresOn: '2026-10-18', expiryLabel: '还有 4 天' }),
    ]
    const out = planLocalReminders({ plan: rows, fridge: items }, NOW)
    expect(out.map((item) => [item.kind, item.at.getMonth() + 1, item.at.getDate(), item.at.getHours()])).toEqual([
      ['expiry', 10, 15, EXPIRY_HOUR],
      ['cook', 10, 15, COOK_HOUR.DINNER],
      ['cook', 10, 16, COOK_HOUR.LUNCH],
      ['expiry', 10, 18, EXPIRY_HOUR],
    ])
  })

  it('每条都带能点开的去处（点进去要落到对的地方）', () => {
    const out = planLocalReminders(
      { plan: planOf([mealRow()]), fridge: [fridgeItem({ expiresOn: '2026-10-20' })] },
      NOW,
    )
    expect(out.every((item: LocalReminder) => item.to.startsWith('/'))).toBe(true)
  })

  it('什么都没有时不排（不是排一堆空提醒）', () => {
    expect(planLocalReminders({ plan: [], fridge: [] }, NOW)).toEqual([])
  })
})
