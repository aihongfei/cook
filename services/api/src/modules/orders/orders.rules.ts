import { BadRequestException } from '@nestjs/common'
import { MealSlot, OrderStatus } from '@prisma/client'
import { CAPABILITIES, FamilyRole, can } from '../family/family.roles'

/**
 * 点单的纯规则（M3 / F3-01~F3-05，口径见 D-022）。
 *
 * 与 `family.roles.ts` 同一套路：**不碰数据库的判定都放这里**，
 * 单元测试直接验规则（状态机、合并、日期范围），不用起 MySQL。
 */

export const MEAL_LABEL: Record<MealSlot, string> = { LUNCH: '午餐', DINNER: '晚餐' }

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: '待确认',
  PLANNED: '已安排',
  COOKING: '准备中',
  DONE: '已做好',
  CANCELED: '已取消',
}

/** 界面按钮文案：目标状态 → 动作名 */
export const ACTION_LABEL: Record<OrderStatus, string> = {
  PENDING: '回到待确认',
  PLANNED: '选好了',
  COOKING: '开始做',
  DONE: '做好了',
  CANCELED: '取消这餐',
}

/**
 * 状态机：只允许这些迁移，**不跳级、不回退**（D-022）。
 * DONE / CANCELED 是终态——要重做就「再点一次」新建一餐。
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PLANNED', 'CANCELED'],
  PLANNED: ['COOKING', 'CANCELED'],
  COOKING: ['DONE'],
  DONE: [],
  CANCELED: [],
}

/** 迁到某个目标状态需要哪个能力（复用 M2 的 6 个 key，不新增） */
export const TRANSITION_CAPABILITY: Record<OrderStatus, string> = {
  PENDING: CAPABILITIES.MENU_MANAGE,
  PLANNED: CAPABILITIES.MENU_MANAGE,
  COOKING: CAPABILITIES.MENU_MANAGE,
  DONE: CAPABILITIES.MENU_CONFIRM,
  CANCELED: CAPABILITIES.MENU_MANAGE,
}

/**
 * 影响别人/不可逆的动作，前端要二次确认（走 ConfirmDialog）。
 *
 * `DONE` 是 2026-10-15 加进来的（D-075）：全家任何成员都能点「做好了」之后
 * （用户要求「家庭任何人都可以点击做好」），误触的代价随之变高——
 * 而它是**终态**：标好之后这一餐再也不能加菜、不能取消，没有撤销。
 * 「开始做」（COOKING）仍然点一下生效：它随时能退回去，不值得多问一句。
 */
const NEEDS_CONFIRM: OrderStatus[] = ['CANCELED', 'DONE']

/**
 * 点菜可选范围：今天起 7 天（D-022 的 2 天 → D-025 的 3 天 → F4-03 的 7 天）。
 *
 * 一路扩下来的原因都是同一类：**界面能看到的日子，必须能直接点进去安排**。
 * F4-02 本周菜单要看后天，就从 2 天扩到 3 天；F4-03 备菜计划要看满一周并"每日加菜"，
 * 于是扩到 7 天——不然备菜页第 4～7 天那几行的「加菜」是条死路（点进去只能选最近三天）。
 *
 * 窗口上限刻意与 PLAN_DAYS_MAX 对齐：能看的范围和能安排的范围**必须一致**，
 * 否则又会出现"看得见、安排不了"的行。
 */
export const ORDER_DAY_SPAN = 7

export const ORDER_STATUSES: OrderStatus[] = ['PENDING', 'PLANNED', 'COOKING', 'DONE', 'CANCELED']
export const MEAL_SLOTS: MealSlot[] = ['LUNCH', 'DINNER']
export const NOTE_MAX_LENGTH = 120

export function isAllowedTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * 这一餐还能不能加菜。
 *
 * - PENDING：正常点菜；
 * - CANCELED：**可以**，并把整餐拉回 PENDING（见 revivedStatus）。
 *   一餐的「日期 + 餐次」在库里是唯一的，如果取消之后就永久不能点，那么一家人下午取消了
 *   晚餐、晚上反悔时这一餐就再也点不了了（F3-06「再点一次」还没做）。取消的语义是
 *   "这餐不做了"，不是"这一天作废"。注意这是**点菜动作顺带复活**，
 *   不是从状态接口回退——状态接口仍然禁止 CANCELED 回退（见 ALLOWED_TRANSITIONS）；
 * - PLANNED / COOKING：不能加（要加先取消这餐）；
 * - DONE：终态，连取消都不行，要重做就等 F3-06「再点一次」。
 */
export function canAddItem(status: OrderStatus): boolean {
  return status === 'PENDING' || status === 'CANCELED'
}

/** 加菜时若这一餐是被取消的，整餐要拉回哪个状态 */
export function revivedStatus(status: OrderStatus): OrderStatus {
  return status === 'CANCELED' ? 'PENDING' : status
}

/**
 * 迁到 `target` 时，上一版的**确认留痕**（谁把菜单定下来的）该怎么处理（M4 / F4-05）。
 *
 * 三种情况，判据只有一条：**这一版菜单还算不算数**。
 * - `keep`   开始做/做好了：做的还是那一版菜单，留痕不动；
 * - `stamp`  定菜单（PLANNED）：记上"我、现在"；
 * - `clear`  取消：这一版作废了，"谁定过"不再成立——留着会让人以为现在还是他定的那一版。
 *
 * 抽成纯规则是为了能在单测里钉住这条判据（不用起 MySQL），也免得服务层写成
 * `target === 'PLANNED' ? ... : target === 'CANCELED' ? ... : {}` 那种一行三岔的嵌套。
 */
export function confirmStampFor(target: OrderStatus): 'keep' | 'stamp' | 'clear' {
  if (target === 'PLANNED') return 'stamp'
  if (target === 'CANCELED') return 'clear'
  return 'keep'
}

/**
 * 迁到 `target` 时，**「谁做好的」留痕**该怎么处理（M10 / F10-02，2026-10-15）。
 *
 * 与上面那条 `confirmStampFor` 是**同一时刻的第二件事**，所以也放在这里、同一个形状：
 * 状态一改，两个留痕要一起写。分成两处各写一遍的话，迟早出现"状态是 DONE、
 * 但没人认领"或者"已经取消了、还留着谁做好的"这种自相矛盾的行。
 *
 * 判据同样只有一条：**这一步是不是"做好了"**。
 * - `stamp`  DONE：记上"谁、什么时候做好"——通知（F10-02）就是靠它才知道
 *            "这一餐**刚**做好"（`updatedAt` 不行：它任何字段一改就动，见 schema 里的说明）；
 * - `clear`  取消：这一餐作废了，"谁做的"不再成立；
 * - `keep`   其余（选好了 / 开始做）：还没做好，也没作废，留痕不动。
 *
 * **不做成 `target === 'DONE' ? ...` 一行三元**：三岔的判据要能在单测里钉住
 * （与 `confirmStampFor` 完全同一条理由）。
 */
export function doneStampFor(target: OrderStatus): 'keep' | 'stamp' | 'clear' {
  if (target === 'DONE') return 'stamp'
  if (target === 'CANCELED') return 'clear'
  return 'keep'
}

/** 我在这个状态下能做哪几步（后端算好给前端，前端不硬编码状态机） */
export function nextActionsFor(
  role: FamilyRole,
  status: OrderStatus,
): { status: OrderStatus; label: string; needsConfirm: boolean }[] {
  return ALLOWED_TRANSITIONS[status]
    .filter(next => can(role, TRANSITION_CAPABILITY[next] as never))
    .map(next => ({ status: next, label: ACTION_LABEL[next], needsConfirm: NEEDS_CONFIRM.includes(next) }))
}

/**
 * 共享开关（F2-07）的可见范围：
 * - 开启（或掌勺人/帮厨）→ 看全家；
 * - 关闭 + 吃货 → 只看自己参与的餐次。
 * 掌勺人/帮厨要负责做饭，关掉共享也仍需要看全量，否则没法接单。
 */
export function visibleToMember(shared: boolean, role: FamilyRole): 'family' | 'mine' {
  return shared || role !== 'EATER' ? 'family' : 'mine'
}

/** 就餐人数上限：一顿饭 50 个人已经远超"家庭"的语义，再大多半是填错了 */
export const DINER_COUNT_MAX = 50

/**
 * 就餐人数（M4 / F4-05）：正整数，或显式传 null/空表示**清除设定**（库里该列可空）。
 * 不把"清除"编码成 0：0 个人吃饭没有意义，用它当哨兵以后一定会有人误当成真值。
 */
export function parseDinerCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value)) throw new BadRequestException('就餐人数要填整数')
  if (value < 1 || value > DINER_COUNT_MAX) {
    throw new BadRequestException(`就餐人数要在 1～${DINER_COUNT_MAX} 之间`)
  }
  return value
}

/**
 * 一餐的进度（**今日安排 F4-01 与本周菜单 F4-02 共用同一个形状**）。
 *
 * 首页要"今天两餐现在到哪一步"，本周菜单要"今天/明天/后天各自到哪一步"——
 * 是同一件事的不同视角，所以是同一份数据：一张卡一行，没成卡的那一餐也给一行。
 *
 * 三种行状态：
 * - `none`    还没人点（或共享关闭时对吃货不可见）→ 引导去安排；
 * - `open`    收集中 / 已安排 / 准备中 → 点进点菜单（`statusLabel` 说明具体在哪一步）；
 * - `settled` 已做好 / 已取消 → 只回看，不再引导（取消了不催人重做，那是用户自己的决定）。
 */
export type TodayMealState = 'none' | 'open' | 'settled'

export interface MealProgressRow {
  meal: MealSlot
  label: string
  state: TodayMealState
  status: OrderStatus | null
  statusLabel: string
  dishes: string[]
  dishCount: number
  /** 有几个人点了菜（去重）。注意这不是"就餐人数"，见下面 dinerCount 的说明 */
  ordererCount: number
  /** 掌勺人设定的就餐人数；null = 还没定（前端据此提示"定一下人数"） */
  dinerCount: number | null
  mealKey: string
  /** 该餐的成品照张数（M9 / F9-08） */
  photoCount: number
  /**
   * 这一餐现在还收不收新菜（备菜计划的「加菜」按它决定按钮出不出现）。
   *
   * 由后端算好而不是让前端看着 `status` 自己判断：**状态机只有一份**（见 canAddItem），
   * 前端复刻一遍迟早会与后端分叉——分叉的表现是"加菜按钮点下去拿到 400"，用户只会觉得坏了。
   */
  canAdd: boolean
}

/** 菜单安排视图里的一天（M4 / F4-02）：午晚两餐固定两行，没安排的也占位 */
export interface PlanDayRow {
  date: string
  /** 今天/明天/后天，再往后是星期 */
  label: string
  weekday: string
  meals: MealProgressRow[]
}

export function todayMealState(status: OrderStatus | null): TodayMealState {
  if (!status) return 'none'
  if (status === 'DONE' || status === 'CANCELED') return 'settled'
  return 'open'
}

/**
 * 打卡照片对这个人可见吗（F9-08 的成品照张数用它计数，口径与 checkins 模块一致，见 D-023）。
 *
 * 与 `visibleToMember` 同一条线：共享开着就全家互相可见；关了则**吃货只看自己传的**
 * （掌勺人/帮厨仍看全量）。**张数也要按这个算**，否则共享关掉后吃货能从"这餐有 3 张成品照"
 * 这种数字上看出别人传了几张——照片藏了、数字却漏了。
 */
export function photoVisibleTo(shared: boolean, role: FamilyRole, viewerId: string, ownerId: string): boolean {
  return visibleToMember(shared, role) === 'family' || viewerId === ownerId
}

/**
 * **已被存进库的日期**（`mealDate`，UTC 零点）→ `YYYY-MM-DD`。
 * 这类值一律用 UTC 读回：写进去时就是按 UTC 零点存的（见 `dateOnly`），用 UTC 读才能原样还原，
 * 与部署在哪个时区无关。
 */
export function dateKey(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

/**
 * **"现在"是哪一天** → `YYYY-MM-DD`。用**服务器本地日历**（容器 TZ=Asia/Shanghai）。
 *
 * 这里要是用 UTC，北京时间 0:00–8:00 之间会算成前一天——用户凌晨点菜，"今天"会显示昨天，
 * 记录也落到昨天那一餐。区分的理由：`mealDate` 是"日子"这个标量（存 UTC 零点），
 * 而"今天"是"此刻所在地的日历日"，两者不是一回事。
 */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 只取日期部分：DATE 列在 MySQL 里不带时间，但传 Date 时驱动会带上 00:00:00 */
export function dateOnly(raw: string): Date {
  const [year, month, day] = raw.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

export function mealKeyOf(mealDate: Date, meal: MealSlot): string {
  return `${dateKey(mealDate)}-${meal}`
}

export function parseMealKey(raw: string): { mealDate: Date; meal: MealSlot } {
  const matched = /^(\d{4}-\d{2}-\d{2})-(LUNCH|DINNER)$/.exec(raw ?? '')
  if (!matched) throw new BadRequestException('这一餐的标识不对')
  return { mealDate: dateOnly(matched[1]), meal: matched[2] as MealSlot }
}

/** 点菜允许的日期：今天起 7 天（备菜计划按一周安排，见 ORDER_DAY_SPAN） */
export function parseMealDate(raw: unknown, now: Date = new Date()): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException('日期格式不对（应为 YYYY-MM-DD）')
  }
  const options = dayOptions(now)
  const allowed = new Set(options.map(option => option.value))
  if (!allowed.has(raw)) {
    // 文案跟着窗口走：改了 ORDER_DAY_SPAN，提示语不用改也不会说错。
    // 第一段（今天/明天/后天）说清楚，后面 4 天只报范围——7 个标签全列出来是行废话
    throw new BadRequestException(`只能点从今天到${options[options.length - 1].label}这 ${options.length} 天内的菜`)
  }
  return dateOnly(raw)
}

/**
 * 可选日期（今天/明天/后天）：接口把它下发给前端，前端不硬编码。
 * 按**本地日历**递进（用 setDate 而不是加固定毫秒数）：跨夏令时的那一天加 24 小时会跑偏。
 */
export function dayOptions(now: Date = new Date()): { value: string; label: string }[] {
  return dayWindow(ORDER_DAY_SPAN, now).map(({ value, label }) => ({ value, label }))
}

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 某一天怎么称呼：近三天用相对说法（今天/明天/后天，比"周三"更不容易看错），
 * 再往后用星期（备菜计划会用到 7 天的窗口）。
 */
export function dayLabel(index: number, date: Date): string {
  if (index === 0) return '今天'
  if (index === 1) return '明天'
  if (index === 2) return '后天'
  return WEEKDAY_LABEL[date.getDay()]
}

export interface DayWindowItem {
  /** `YYYY-MM-DD`（本地日历日） */
  value: string
  label: string
  /** 星期几：让"后天"落到具体的日子上 */
  weekday: string
}

/**
 * 从今天起 `span` 天的日历。日期一律按**本地日历**递进（今天/明天/后天……），
 * 是 `dayOptions` 与菜单安排视图共用的那一份口径——两处各算一遍迟早会分叉。
 *
 * 刻意**不返回 Date 对象**：这里的日子是"哪一天"这个标量，查库要用 `dateOnly(value)`
 * （存的是 UTC 零点）。把本地午夜的 Date 直接拿去查会差一天（见 dateOnly 的说明）。
 */
export function dayWindow(span: number, now: Date = new Date()): DayWindowItem[] {
  return Array.from({ length: span }, (_, index) => {
    // 用「年/月/日 + n」构造而不是加毫秒：跨夏令时的那一天加 24 小时会跑偏
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index)
    return { value: todayKey(date), label: dayLabel(index, date), weekday: WEEKDAY_LABEL[date.getDay()] }
  })
}

/** 菜单安排视图默认看几天（今天/明天/后天）；上限 7 天是给 F4-03 备菜计划留的窗口 */
export const PLAN_DAYS_DEFAULT = 3
export const PLAN_DAYS_MAX = 7

export function parsePlanDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return PLAN_DAYS_DEFAULT
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > PLAN_DAYS_MAX) {
    throw new BadRequestException(`天数要在 1～${PLAN_DAYS_MAX} 之间`)
  }
  return value
}

/*
 * ---------- 点单历史与美食日记（F3-09） ----------
 *
 * 它要解决的是 `RISKS.md` R-19 记下的那件事：`GET /orders` 一次最多 60 张卡（约一个月），
 * 更早的点单**数据还在库里、界面上看不到**。所以这一块的第一件事是**按日期范围翻页**，
 * 而不是再加一个"历史"视图把同样的 60 张换个样子显示。
 */

/** 历史一页多少天：一个月的日历视图，正好铺满 6 行（最多 42 格） */
export const HISTORY_PAGE_SIZE_DEFAULT = 31
export const HISTORY_PAGE_SIZE_MAX = 62

export interface HistoryQuery {
  /** 结束日（含），默认"今天"；往前数 pageSize 天 */
  to: string
  pageSize: number
}

/**
 * 历史的日期范围：以 `to`（默认今天）为终点往前数 `pageSize` 天。
 *
 * 口径是**按天给窗口**而不是"按条数翻页"：日历视图天然按天铺，
 * 用 `page/pageSize`（条数）会出现"这一页某天只有半天的记录"这种对不上的情况。
 * 一页 = 连续的 N 天，翻页 = 往前挪 N 天，两边都好讲。
 */
export function parseHistoryQuery(query: { to?: unknown; pageSize?: unknown } = {}, now: Date = new Date()): HistoryQuery {
  const rawTo = query.to
  let to: string
  if (rawTo === undefined || rawTo === null || rawTo === '') {
    to = todayKey(now)
  } else {
    if (typeof rawTo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
      throw new BadRequestException('日期格式不对（应为 YYYY-MM-DD）')
    }
    to = rawTo
  }

  const rawSize = query.pageSize
  let pageSize = HISTORY_PAGE_SIZE_DEFAULT
  if (rawSize !== undefined && rawSize !== null && rawSize !== '') {
    const value = typeof rawSize === 'number' ? rawSize : Number(rawSize)
    if (!Number.isInteger(value) || value < 1 || value > HISTORY_PAGE_SIZE_MAX) {
      throw new BadRequestException(`一页天数要在 1～${HISTORY_PAGE_SIZE_MAX} 之间`)
    }
    pageSize = value
  }

  return { to, pageSize }
}

/**
 * 一页历史覆盖的日期区间（含两端）：`[from, to]`，按**本地日历**往前数。
 *
 * 返回 `YYYY-MM-DD` 字符串而不是 Date：查库要用 `dateOnly()`（存的是 UTC 零点），
 * 把本地午夜的 Date 直接拿去查会差一天（见 `dateOnly` 的说明）。
 */
export function historyRange(query: HistoryQuery, now: Date = new Date()): { from: string; to: string; days: string[] } {
  const [year, month, day] = query.to.split('-').map(Number)
  const days: string[] = []
  for (let offset = query.pageSize - 1; offset >= 0; offset -= 1) {
    // 用「年/月/日 - n」构造而不是减毫秒：跨夏令时的那一天减 24 小时会跑偏
    days.push(todayKey(new Date(year, month - 1, day - offset)))
  }
  return { from: days[0], to: days[days.length - 1], days }
}

/**
 * 这一页还能再往前翻吗：**库里还有比 `from` 更早的餐次**才算有。
 *
 * 判据用"还有没有更早的记录"，而不是"from 是不是早于某个下界"——
 * 后者会让用户在翻到第一张卡之前先撞上好几页空白（家庭才开始用 App，
 * 翻开一个月前当然什么都没有，那一页该直接说"到头了"）。
 */
export function hasEarlier(earliestKey: string | null, from: string): boolean {
  if (!earliestKey) return false
  return earliestKey < from
}

/**
 * `2026-10-13` → `周二`。历史的日历视图每天要一个星期标（用户回看时是按"那天周几"回忆的）。
 *
 * 用**本地日历**构造 Date 取 getDay()：这里的 key 是"哪一天"这个标量，
 * 若按 UTC 解析，东八区的周一 00:00 会显示成周日。
 */
export function weekdayOf(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return WEEKDAY_LABEL[new Date(year, month - 1, day).getDay()]
}

export function parseSlot(raw: unknown): MealSlot {
  if (raw !== 'LUNCH' && raw !== 'DINNER') throw new BadRequestException('餐次只能是午餐或晚餐')
  return raw
}

/**
 * 自由菜品（F3-10）：菜谱库里没有的菜，直接写个名字点进点单。
 *
 * 名字上限 30 字：够写「外婆的糖醋小排」这种家常叫法，又不至于把点单卡撑爆
 * （想多交代的走备注，那里有 120 字）。
 */
export const FREE_DISH_NAME_MAX = 30

export function parseDishName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('菜名要写成文字')
  const name = raw.trim()
  if (!name) throw new BadRequestException('菜名不能为空')
  if (name.length > FREE_DISH_NAME_MAX) throw new BadRequestException(`菜名最多 ${FREE_DISH_NAME_MAX} 个字`)
  return name
}

/**
 * 点单的目标：**要么**点菜谱库里的一道（`recipeId`），**要么**自己写一个（`dishName`）。
 * 两个都给会被拒：静默挑一个会把用户的意图藏起来，出错也查不出来。
 */
export type ItemTarget = { kind: 'recipe'; recipeId: string } | { kind: 'dish'; dishName: string }

export function parseItemTarget(input: { recipeId?: unknown; dishName?: unknown }): ItemTarget {
  const hasRecipe = typeof input.recipeId === 'string' && input.recipeId.trim() !== ''
  // 「给了值」= 非 null/undefined；空串与纯空白交给 parseDishName 报「菜名不能为空」，文案更贴切
  const providedDish = input.dishName !== undefined && input.dishName !== null
  if (hasRecipe && providedDish) throw new BadRequestException('一次加一道：要么点菜谱里的，要么自己写一个')
  if (hasRecipe) return { kind: 'recipe', recipeId: (input.recipeId as string).trim() }
  if (providedDish) return { kind: 'dish', dishName: parseDishName(input.dishName) }
  throw new BadRequestException('要么点菜谱里的菜，要么自己写一个菜名')
}

export function parseStatus(raw: unknown): OrderStatus {
  if (typeof raw !== 'string' || !(raw in STATUS_LABEL)) throw new BadRequestException('状态不对')
  return raw as OrderStatus
}

export function parseNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new BadRequestException('备注只能是一段文字')
  const note = raw.trim()
  if (!note) return null
  if (note.length > NOTE_MAX_LENGTH) throw new BadRequestException(`备注最多 ${NOTE_MAX_LENGTH} 个字`)
  return note
}

/**
 * 一次最多加几道（批量加菜，F5-01「摇一桌」的整组加入用它）。
 *
 * 12 与 `combos.rules.COMBO_ITEMS_MAX` 同值**是刻意的**：两个上限说的是同一件事
 * （"一顿饭一次要加的这一组"），写成两个数字迟早会有人问"为什么这边能加 12 那边只能 5"。
 */
export const BULK_ITEMS_MAX = 12

/**
 * 批量加菜的 id 列表：去重（保序）、上限、非空。
 *
 * 与 `combos.rules.parseRecipeIds` 挡的是同一批东西（重复、超量、空列表）——
 * 那边是"存进一个组合"，这里是"直接加进某一餐"，校验标准不该有第二套。
 */
export function parseBulkRecipeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequestException('菜要写成一个列表')
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('菜 id 要写成文字')
    const id = item.trim()
    if (!id || ids.includes(id)) continue
    ids.push(id)
    if (ids.length > BULK_ITEMS_MAX) throw new BadRequestException(`一次最多加 ${BULK_ITEMS_MAX} 道菜`)
  }
  if (ids.length === 0) throw new BadRequestException('一次至少要加 1 道菜')
  return ids
}

/**
 * 挑出"这一餐里还没有的"（批量加菜用）。
 *
 * **已有的跳过、不叠加份数**：批量加菜的意图是"这一组菜出现在这一餐"，
 * 不是"再点一遍"——叠加的结果是同一道菜 ×2，用户点一次却得到双份（还可能被掌勺人
 * 当成两个人想吃）。跳过之后同一个动作重复点也不会变样（幂等）。
 *
 * 与 `combos.rules.planAdd` 同一段逻辑、**刻意各留一份**：那个是"组合"的规则
 * （`AddOutcome` 是它的返回类型），orders 依赖 combos 会绕出一个反向依赖
 * （combos 已经依赖 orders）。这段只有十来行，重复比耦合划算——与 `sample`
 * 在 recommend.rules 里同理。
 */
export function splitExisting(
  existing: readonly string[],
  wanted: readonly string[],
): { toAdd: string[]; skipped: string[] } {
  const has = new Set(existing)
  const toAdd: string[] = []
  const skipped: string[] = []
  for (const id of wanted) {
    if (has.has(id)) skipped.push(id)
    else toAdd.push(id)
  }
  return { toAdd, skipped }
}

/** 卡片里的一条菜：同一道菜多人点会合并成一条，份数 +1，备注按人分列 */
export interface DishLine {
  recipeId: string | null
  name: string
  image: string | null
  count: number
  notes: { nickname: string; text: string }[]
  /** 我点的那几份的 id（前端据此提供「撤回我这份」） */
  mineItemIds: string[]
}

export interface AggregateItem {
  id: string
  userId: string
  recipeId: string | null
  recipeName: string
  recipeImage: string | null
  note: string | null
  user: { nickname: string; avatar: string }
}

/** 一道菜在点单里的最小形状（合并键与「再点一次」的跳过判定都用它） */
export interface DishRef {
  recipeId: string | null
  name: string
}

/**
 * 一道菜的**身份**：有菜谱 id 就用 id，没有（自由菜品 F3-10，或菜谱被删）就退回菜名。
 *
 * 这个键只此一处定义。卡片的合并（`aggregateItems`）与「再点一次」的跳过判定
 * （`planRepeat`）必须用同一个键：两处各写一遍的话，同一道菜会在一边被认成"已经有了"、
 * 在另一边被认成"新菜"，结果是用户点一次"再点一次"却看到同一道菜多出一个 ×2 的行。
 */
export function dishKey(dish: DishRef): string {
  return dish.recipeId ?? `name:${dish.name}`
}

/**
 * 这一餐能不能作为「再点一次」的来源（F3-06）。
 *
 * 判据是**这一餐已经定局**，两种情况：
 * - 状态到了终态（做好了 / 已取消）——D-022 里"要重做就再点一次"说的就是这一步；
 * - 日子已经过去，但状态还停在待确认/已安排/准备中（一家人忘了点"做好了"）。
 *   这种卡在列表里跟新的一样，可它就是过去的饭，不认它反而奇怪。
 *
 * 反过来，**今天/明天那一餐不给出这个入口**：它还在收集中，要加菜直接点那道菜就是了，
 * "把这一桌复制到另一餐"另有常用组合（F4-04）负责。限定来源之后这个功能的意思才干净：
 * 把过去的一餐再来一遍。
 */
export function canRepeatFrom(status: OrderStatus, date: string, today: string): boolean {
  if (status === 'DONE' || status === 'CANCELED') return true
  // YYYY-MM-DD 是定长数字串，字典序即日期先后（不用再转 Date）
  return date < today
}

export interface RepeatPlan {
  /** 要照抄过去的菜（每种一份） */
  toAdd: DishRef[]
  /** 目标那一餐里本来就有的（跳过） */
  skipped: DishRef[]
}

/**
 * 「再点一次」要加哪些菜：把来源那一餐的菜整桌照抄到目标那一餐，**已有的跳过**。
 *
 * 两条口径（与 D-029 的"整组加入"同一套思路）：
 * - **已有的跳过、不叠加份数**：目标是"这一桌菜出现在这一餐"，不是"再点一遍"。
 *   跳过之后同一次复制点两次也不会变样（幂等），由服务层把 `skipped` 告诉用户。
 * - **每种菜一份**：来源里的 ×2 是"两个人各点了一份"这个**投票结果**，不是菜谱上的用量。
 *   复制的是菜谱（做法），份数要由这一餐的人重新表态——照抄 ×2 会把两个人的意愿
 *   记在复制者一个人名下（卡上会变成"1 人点了"却有两份）。想多要一份的人可以自己再点。
 */
export function planRepeat(existing: DishRef[], source: DishRef[]): RepeatPlan {
  /*
   * 两个集合分开：`inTarget` 只描述"目标那一餐本来就有"（这个要报给用户），
   * `taken` 是"这次已经算过的键"（含刚从来源收下的）。合成一个的话，
   * 来源自身的重复项会被当成"目标里本来就有"报出去——用户会以为那道菜本来就在这一餐。
   */
  const inTarget = new Set(existing.map(dishKey))
  const taken = new Set(inTarget)
  const reported = new Set<string>()
  const toAdd: DishRef[] = []
  const skipped: DishRef[] = []

  for (const dish of source) {
    const key = dishKey(dish)
    if (inTarget.has(key)) {
      if (!reported.has(key)) {
        reported.add(key)
        skipped.push(dish)
      }
      continue
    }
    if (taken.has(key)) continue // 来源里重复的一道：静默收一份
    taken.add(key)
    toAdd.push(dish)
  }
  return { toAdd, skipped }
}

export interface AggregatedCard {
  dishes: DishLine[]
  /** 点菜人去重，按首次点菜顺序 */
  orderers: string[]
  /** 该餐实际点菜的人数（去重）。D-022：真正的"就餐人数"归 M4 由掌勺人设定 */
  ordererCount: number
  dishCount: number
  mineCount: number
}

/**
 * 把一餐里的点单条目合并成卡片视图。
 * 合并键优先用菜谱 id；菜谱被删（recipeId 为空）时退回菜名，这样历史点单仍然显示得出来。
 */
export function aggregateItems(items: AggregateItem[], viewerId: string): AggregatedCard {
  const dishes: DishLine[] = []
  const ordererIds: string[] = []
  const orderers: string[] = []

  for (const item of items) {
    const key = dishKey({ recipeId: item.recipeId, name: item.recipeName })
    let line = dishes.find(dish => dishKey(dish) === key)
    if (!line) {
      line = { recipeId: item.recipeId, name: item.recipeName, image: item.recipeImage, count: 0, notes: [], mineItemIds: [] }
      dishes.push(line)
    }
    line.count += 1
    if (item.note) line.notes.push({ nickname: item.user.nickname, text: item.note })
    if (item.userId === viewerId) line.mineItemIds.push(item.id)

    if (!ordererIds.includes(item.userId)) {
      ordererIds.push(item.userId)
      orderers.push(item.user.nickname)
    }
  }

  return {
    dishes,
    orderers,
    ordererCount: orderers.length,
    dishCount: items.length,
    mineCount: items.filter(item => item.userId === viewerId).length,
  }
}
