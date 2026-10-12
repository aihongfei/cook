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

/** 点菜可选范围：今天、明天（D-022） */
export const ORDER_DAY_SPAN = 2

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

/** 点菜允许的日期：今天或明天，其它一律拒（更远的安排归 M4） */
export function parseMealDate(raw: unknown, now: Date = new Date()): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException('日期格式不对（应为 YYYY-MM-DD）')
  }
  const allowed = new Set(dayOptions(now).map(option => option.value))
  if (!allowed.has(raw)) throw new BadRequestException('只能点今天或明天的菜')
  return dateOnly(raw)
}

/**
 * 可选日期（今天/明天）：接口把它下发给前端，前端不硬编码。
 * 按**本地日历**递进（用 setDate 而不是加固定毫秒数）：跨夏令时的那一天加 24 小时会跑偏。
 */
export function dayOptions(now: Date = new Date()): { value: string; label: string }[] {
  return Array.from({ length: ORDER_DAY_SPAN }, (_, index) => {
    const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index)
    return { value: todayKey(value), label: index === 0 ? '今天' : '明天' }
  })
}

export function parseSlot(raw: unknown): MealSlot {
  if (raw !== 'LUNCH' && raw !== 'DINNER') throw new BadRequestException('餐次只能是午餐或晚餐')
  return raw
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
