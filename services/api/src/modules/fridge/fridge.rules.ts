/**
 * 冰箱的纯规则（M6 / F6-01/03/04/05）。形态见 D-049。
 *
 * 这块的难度在两件事上，都不在代码本身：
 *
 * ① **"快过期"必须说清是哪种**（F6-05）。冰箱里最没用的提醒是"有东西要过期了"——
 *    用户得自己一条条翻。所以这里分三档（已过期 / 今天到期 / 三天内），
 *    而且**按天算不按小时算**：食材的保质期是人按日历日写的（"10 月 15 号到期"），
 *    用 24 小时制算会让"明天到期"在今晚 8 点变成"不到一天了"，那是吓人不是提醒。
 *
 * ② **四区（F6-04）是固定值**（常温/保鲜/冷藏/冷冻）。不建表、不允许自定义：
 *    3D 预览要按它摆位（F17-02），人的直觉也只有这四档。允许自定义会让
 *    "这盒牛奶在哪儿"变成一道需要回忆的选择题。
 */

import { BadRequestException } from '@nestjs/common'
/*
 * 日期口径**复用点单那一套**（`dateOnly` 用 `Date.UTC` 构造、`dateKey` 用 `getUTC*` 读）。
 * 不自己再写一份：那两个函数是"DATE 列怎么存怎么读"的唯一定义，各写各的必然分叉——
 * 本轮就是活证据（第一版用本地时区构造，存进 MySQL 的 DATE 列后**整天差一天**：
 * 填了 10-15、界面显示"明天到期"，其实今天已是 10-13）。
 */
import { dateKey, dateOnly } from '../orders/orders.rules'

/** 存放区（F6-04）。顺序就是界面上从左到右的四格 */
export const FRIDGE_ZONES = ['常温', '保鲜', '冷藏', '冷冻'] as const
export type FridgeZone = (typeof FRIDGE_ZONES)[number]

export const FRIDGE_NAME_MAX = 40
export const FRIDGE_AMOUNT_MAX = 24
export const FRIDGE_NOTE_MAX = 60

/** 「今日先吃」提前几天提醒 */
export const SOON_DAYS = 3

export interface FridgeItemRow {
  id: string
  name: string
  amount: string | null
  zone: string
  expiresOn: Date | null
  note: string | null
  /** 放进去的人的**昵称**（不是 id：界面要显示"谁放的"，见 service 的 include） */
  addedByName: string
  createdAt: Date
}

/** 一行的保质期状况。`null` = 没写保质期（不是"不会坏"） */
export type ExpiryState = 'expired' | 'today' | 'soon' | null

/**
 * 两个日期相差几天（**按日历日**，不是按 24 小时）。
 *
 * `expiresOn` 是 DATE 列（MySQL 里不带时间，Prisma 读回来是 **UTC 零点**），
 * 而"今天是几号"要按**服务器本地日历**算（容器 TZ=Asia/Shanghai，见 R-18）。
 * 所以把"今天"也换算成同一个表示（本地日历日 → UTC 零点）再相减：
 * 直接拿 `now.getTime()` 去减会带上时分秒，晚上看"明天到期"就成了不到一天。
 */
export function daysUntil(expiresOn: Date, now: Date = new Date()): number {
  const todayAsDate = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((expiresOn.getTime() - todayAsDate) / 86_400_000)
}

/** 保质期状况：已过期 / 今天到期 / 三天内 / 不提醒（没写或还早） */
export function expiryState(expiresOn: Date | null, now: Date = new Date()): ExpiryState {
  if (!expiresOn) return null
  const days = daysUntil(expiresOn, now)
  if (days < 0) return 'expired'
  if (days === 0) return 'today'
  if (days <= SOON_DAYS) return 'soon'
  return null
}

/** 界面上那句话（后端算好，前端不重算——两边各算一遍必然有一边先改） */
export function expiryLabel(expiresOn: Date | null, now: Date = new Date()): string | null {
  if (!expiresOn) return null
  const days = daysUntil(expiresOn, now)
  if (days < 0) return `过期 ${-days} 天`
  if (days === 0) return '今天到期'
  if (days === 1) return '明天到期'
  return `还有 ${days} 天`
}

/** 该不该出现在「今日先吃」里（F6-05）：已过期与三天内都算 */
export function needsAttention(expiresOn: Date | null, now: Date = new Date()): boolean {
  return expiryState(expiresOn, now) !== null
}

/** 解析存放区。不认的值直接拒绝（不用 `?? 默认` 兜住——那会把打错的区悄悄记成冷藏） */
export function parseZone(raw: unknown): FridgeZone {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if ((FRIDGE_ZONES as readonly string[]).includes(text)) return text as FridgeZone
  throw new BadRequestException(`存放区只能是 ${FRIDGE_ZONES.join(' / ')}`)
}

/** 解析食材名：去首尾空白，不许空 */
export function parseName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new BadRequestException('要写个食材名')
  if (text.length > FRIDGE_NAME_MAX) throw new BadRequestException(`食材名最多 ${FRIDGE_NAME_MAX} 个字`)
  return text
}

/**
 * 解析数量：可空。
 *
 * **不强迫填数字**：很多食材就是"有一点"（半把葱、剩的米饭），
 * 逼人填会让用户干脆不录——而"录了但没写多少"比"没录"有用得多。
 * 所以数量是自由文本（"半盒"、"约 500g"都能写），只限长度。
 */
export function parseAmount(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (!text) return null
  if (text.length > FRIDGE_AMOUNT_MAX) throw new BadRequestException(`数量最多 ${FRIDGE_AMOUNT_MAX} 个字`)
  return text
}

/** 解析保质期：可空。只认 `YYYY-MM-DD`（人写的是哪天，不是哪一刻） */
export function parseExpiry(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BadRequestException('保质期要写成 2026-10-15 这样')
  /*
   * 用 `dateOnly` 构造（**UTC 零点**），不写 `new Date(y, m-1, d)`：
   * DATE 列在 MySQL 里不带时间，用本地时区构造的"2026-10-15 本地零点"存进去会变成
   * 前一天（本地零点 = 前一天的 UTC 16:00）。这条是实测踩出来的——见文件头的 ⚠️。
   */
  const date = dateOnly(text)
  // 反查一遍：2 月 31 号会被 Date 悄悄滚到 3 月，那种"填错了还存进去"最坑
  if (date.getUTCFullYear() !== Number(text.slice(0, 4))
    || date.getUTCMonth() + 1 !== Number(text.slice(5, 7))
    || date.getUTCDate() !== Number(text.slice(8, 10))) {
    throw new BadRequestException('这个日期不存在，检查一下月份和日子')
  }
  // 允许的范围：十年内。防的是把 20260-10-15 这类打错的年份存进来
  if (date.getUTCFullYear() > new Date().getFullYear() + 10) {
    throw new BadRequestException('保质期看着不像（年份太远了）')
  }
  return date
}

/** 解析备注：可空 */
export function parseNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (!text) return null
  if (text.length > FRIDGE_NOTE_MAX) throw new BadRequestException(`备注最多 ${FRIDGE_NOTE_MAX} 个字`)
  return text
}

/** 入库输出的一行（前端拿到就能直接画） */
export interface FridgeItemView {
  id: string
  name: string
  amount: string | null
  zone: FridgeZone
  expiresOn: string | null
  expiryLabel: string | null
  /** 要不要提醒（今日先吃那块据此筛） */
  attention: boolean
  note: string | null
  addedBy: string
  addedAt: string
}

/** 数据库行 → 界面行（保质期那句话在这里算好） */
export function toView(row: FridgeItemRow, now: Date = new Date()): FridgeItemView {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    zone: row.zone as FridgeZone,
    expiresOn: row.expiresOn ? dateKey(row.expiresOn) : null,
    expiryLabel: expiryLabel(row.expiresOn, now),
    attention: needsAttention(row.expiresOn, now),
    note: row.note,
    addedBy: row.addedByName,
    addedAt: row.createdAt.toISOString(),
  }
}
