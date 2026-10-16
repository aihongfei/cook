/**
 * 提醒相关的**测试夹具**（M10）。
 *
 * ## 为什么单独一个文件
 *
 * 2026-10-16 把开关从 4 个扩到 9 个、给 `AppNotification` 加了 `origin` 之后，
 * **五个测试文件同时编译不过**——因为它们各自手写了一份 `prefs: { mealPlan: true, ... }`
 * 与一条条手搭的提醒对象。那是同一个事实（"提醒的默认形态长什么样"）在五处各存了一遍，
 * 于是加一个字段就要改五处、还容易漏。
 *
 * 放在这里之后：**加字段只改这一个文件**。下一次扩类别时，测试会因为类型检查
 * 立刻发现"哪里还在手搓"（而不是等到运行时行为不对才查）。
 *
 * ## 为什么可以放在 `src/` 里
 *
 * 它只被 `*.test.tsx` 引用，而测试文件不在 `vite build` 的依赖图里——
 * 所以它**不会进包**（与"没有测试专用构建"这件事无关，纯粹是没被打包器看见）。
 */

import type { AppNotification, NotificationArea, NotificationBoard, NotificationKind, NotificationPrefs } from './notifications'

/** 九个开关**全开**（与后端"没有行就默认全开"同一个起点） */
export const ALL_PREFS_ON: NotificationPrefs = {
  mealPlan: true,
  mealDone: true,
  expiry: true,
  prep: true,
  orderChange: true,
  fridgeChange: true,
  checkin: true,
  family: true,
  recipe: true,
}

/**
 * 一条提醒，只给要断言的字段。
 *
 * `origin` **按 kind 推出默认值**而不是固定写 'derived'：状态型那四类会自己消失、
 * 事件型那六类不会——测试里若要验"事件型不随事实消失"，那就得先有条事件型的东西，
 * 而让它必须靠调用方记得传 `origin` 才能得到，正是最容易忘的那一步。
 */
export function notificationFixture(overrides: Partial<AppNotification> = {}): AppNotification {
  const kind: NotificationKind = overrides.kind ?? 'done'
  const derived: NotificationKind[] = ['plan', 'done', 'expiry', 'prep']
  return {
    id: `${kind}:2026-10-18-DINNER`,
    kind,
    title: '明天晚餐做好了',
    body: '你点的 红烧排骨 可以吃了',
    at: '2026-10-18T11:30:00.000Z',
    to: `/order/2026-10-18-DINNER`,
    mealKey: '2026-10-18-DINNER',
    tag: '做好了',
    unread: true,
    origin: derived.includes(kind) ? 'derived' : 'event',
    ...overrides,
  }
}

/**
 * 一份完整的提醒看板。
 *
 * **未读的那些数默认按 `items` 现算**（不是让每个用例自己写）：`unreadByArea` /
 * `unreadByKind` 与 `items` 不一致的夹具会造出"界面上不可能出现的那种数据"，
 * 而用它测出来的绿是没有意义的（真实数据里这几个数由后端从同一份 items 投影出来）。
 * 要测"数字与列表不一致时界面怎么办"，就显式传进来覆盖——
 * 那种用例是少数，而且它想验的恰恰就是这个不一致。
 *
 * **不写 `...overrides` 展开**：`Partial<NotificationBoard>` 每个键都带 `| undefined`，
 * 展开进一个"字段必填"的对象会让类型变成 `T | undefined`（`tsc` 会拦，
 * 而绕过它只能写 `as`——那正好把"少给了字段"这类错盖掉）。逐字段写清楚。
 */
export function boardFixture(overrides: Partial<NotificationBoard> & { items?: AppNotification[] } = {}): NotificationBoard {
  const items = overrides.items ?? []
  const unreadByKind: Partial<Record<NotificationKind, number>> = {}
  const unreadByArea: Partial<Record<NotificationArea, number>> = {}
  for (const item of items) {
    if (!item.unread) continue
    unreadByKind[item.kind] = (unreadByKind[item.kind] ?? 0) + 1
    const area = AREA_OF_KIND[item.kind]
    unreadByArea[area] = (unreadByArea[area] ?? 0) + 1
  }
  return {
    items,
    unread: overrides.unread ?? items.filter((item) => item.unread).length,
    unreadByArea: overrides.unreadByArea ?? unreadByArea,
    unreadByKind: overrides.unreadByKind ?? unreadByKind,
    prefs: overrides.prefs ?? ALL_PREFS_ON,
  }
}

/**
 * 每类提醒归哪个区域 —— **照抄后端 `areaOfKind`**。
 *
 * 夹具里必须有一份（`unreadByArea` 要算得出来），而它必须是**照抄**、
 * 不能按前端自己的理解另写一套：两边不一致的后果是"夹具造出的数据在真机上不可能出现"
 * （后端说打卡归 family、夹具说归 order），拿它测出来的绿是假的。
 * 所以这份表同时是一份**一致性清单**：后端改了 `areaOfKind` 而这里没跟上，
 * 底栏红点相关的用例就会红——那是想要的信号，不是噪音。
 */
const AREA_OF_KIND: Record<NotificationKind, NotificationArea> = {
  plan: 'order',
  done: 'order',
  prep: 'order',
  expiry: 'fridge',
  order: 'order',
  // 「冰箱有变化」与「快过期」同归冰箱 Tab（都点去 `/fridge`）——照抄后端 `areaOfKind`
  fridge: 'fridge',
  checkin: 'family',
  comment: 'family',
  family: 'family',
  recipe: 'family',
}
