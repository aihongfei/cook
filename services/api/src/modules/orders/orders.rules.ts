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

/** 影响别人/不可逆的动作，前端要二次确认（走 ConfirmDialog） */
const NEEDS_CONFIRM: OrderStatus[] = ['CANCELED']

/**
 * 点菜可选范围：今天、明天、后天（M4 / F4-02 把 D-022 的 2 天扩到 3 天）。
 *
 * 扩这一格是因为「本周菜单」要能安排后天——不然那一行的「去安排」是条死路
 * （点不进后天，只能看着它空着）。再往后的日子归 F4-03 备菜计划（未来 7 天）。
 */
export const ORDER_DAY_SPAN = 3

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

/** 点菜允许的日期：今天/明天/后天，其它一律拒（本周菜单按 3 天安排，见 D-025） */
export function parseMealDate(raw: unknown, now: Date = new Date()): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException('日期格式不对（应为 YYYY-MM-DD）')
  }
  const options = dayOptions(now)
  const allowed = new Set(options.map(option => option.value))
  if (!allowed.has(raw)) {
    // 文案跟着窗口走：改了 ORDER_DAY_SPAN，提示语不用改也不会说错
    throw new BadRequestException(`只能点${options.map(option => option.label).join('/')}的菜`)
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
    const key = item.recipeId ?? `name:${item.recipeName}`
    let line = dishes.find(dish => (dish.recipeId ?? `name:${dish.name}`) === key)
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
