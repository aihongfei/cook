import { BadRequestException } from '@nestjs/common'
import type { FamilyRole } from '@prisma/client'

/**
 * 打卡的纯规则（M9 / F9-03、F9-07、F9-08；口径见 D-023）。
 *
 * 与 `orders.rules.ts` / `family.roles.ts` 同一套路：**不碰数据库的判定都放这里**，
 * 单元测试直接验规则（日历日、热力图网格、连续天数、备注与图片校验），不用起 MySQL。
 */

/** 单张照片上限 8MB：前端已预缩到 1600px（通常 < 500KB），这里只兜住越过前端的调用方 */
export const CHECKIN_MAX_BYTES = 8 * 1024 * 1024
export const CHECKIN_NOTE_MAX = 60

/** 只收这三种：手机相册与相机出的格式，且都能被所有浏览器显示 */
export const CHECKIN_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** 热力图展示的周数（约 4 个月，与"我的"页一屏能放下的量匹配） */
export const HEATMAP_WEEKS = 18

/**
 * **"此刻是哪个打卡日"** → `YYYY-MM-DD`，用**服务器本地日历**（容器 TZ=Asia/Shanghai）。
 * 打卡是"人今天做了饭"，按所在地的一天划分；用 UTC 会让北京时间凌晨 0–8 点算成前一天。
 */
export function dayKey(value: Date = new Date()): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * **已存进库的打卡日**（`checkDate`，UTC 零点）→ `YYYY-MM-DD`。
 * 与 `dayKey` 分开的理由同 orders.rules：入库值是"日子"标量（UTC 零点），
 * 读回必须也用 UTC，否则部署在负时区时会整体差一天。
 */
export function storedDayKey(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

/** `YYYY-MM-DD` → 当天零点的 Date（本地时区） */
export function dayStart(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function parseDayKey(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException('日期格式不对（应为 YYYY-MM-DD）')
  }
  const parsed = dayStart(raw)
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('日期不存在')
  return raw
}

export function parseNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new BadRequestException('这句交代只能是一段文字')
  const note = raw.trim()
  if (!note) return null
  if (note.length > CHECKIN_NOTE_MAX) throw new BadRequestException(`这句交代最多 ${CHECKIN_NOTE_MAX} 个字`)
  return note
}

export function parseContentType(raw: unknown): string {
  const type = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
  if (!(CHECKIN_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw new BadRequestException('只支持 JPEG / PNG / WebP 图片')
  }
  return type
}

export function assertSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new BadRequestException('图片内容为空')
  if (bytes > CHECKIN_MAX_BYTES) {
    throw new BadRequestException(`单张照片不能超过 ${Math.floor(CHECKIN_MAX_BYTES / 1024 / 1024)}MB`)
  }
}

/**
 * 扩展名（私有桶的 key 用它，让存储里的对象可被人眼辨认）
 *
 * `sniffImageType` 已搬到 `media/media.storage`（自建菜谱上传也要判同一件事），
 * 这里重新导出，免得 checkins 里每一处调用点都改一次 import。
 */
export { sniffImageType } from '../media/media.storage'

export function extensionFor(contentType: string): string {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[contentType] ?? 'jpg'
}

export interface HeatCell {
  /** 打卡日 `YYYY-MM-DD` */
  date: string
  count: number
  /** 0–4：热力等级（0 = 没打卡），前端只按等级上色，不自己算阈值 */
  level: number
}

export interface HeatmapGrid {
  /** 按周分组，每组 7 天（周一到周日）；最后一周可能不满 */
  weeks: HeatCell[][]
  /** 起止日期（含），用于前端显示「最近 N 周」 */
  from: string
  to: string
  totalDays: number
  totalCount: number
  /** 连续打卡天数（到今天为止；今天没打就数到昨天） */
  streak: number
}

/** 打卡次数 → 热力等级：1 次算有打卡，之后按量递增（4 次及以上为最深） */
export function heatLevel(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count === 2) return 2
  if (count === 3) return 3
  return 4
}

/**
 * 从「本周一」往前数 `weeks` 周，得到网格的第一天。
 * 以周一为一周之首（中国习惯），与 GitHub 贡献图的周日开头不同——这里按国内日历显示。
 */
export function heatmapStart(today: Date, weeks: number = HEATMAP_WEEKS): Date {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // getDay(): 0=周日 … 6=周六 → 换算成"距离本周一几天"
  const offsetFromMonday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - offsetFromMonday - (weeks - 1) * 7)
  return start
}

/**
 * 组装热力图（M9 / F9-03）。
 * `counts` 是 `YYYY-MM-DD → 打卡张数`；网格覆盖"最近 weeks 周（周一起）到今天"。
 */
export function buildHeatmap(counts: Map<string, number>, today: Date = new Date(), weeks: number = HEATMAP_WEEKS): HeatmapGrid {
  const start = heatmapStart(today, weeks)
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const grid: HeatCell[][] = []
  let week: HeatCell[] = []
  let totalCount = 0

  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = dayKey(cursor)
    const count = counts.get(date) ?? 0
    totalCount += count
    week.push({ date, count, level: heatLevel(count) })
    if (week.length === 7) {
      grid.push(week)
      week = []
    }
  }
  if (week.length > 0) grid.push(week)

  return {
    weeks: grid,
    from: dayKey(start),
    to: dayKey(end),
    totalDays: counts.size,
    totalCount,
    streak: streakOf(counts, today),
  }
}

/**
 * 连续打卡天数：从今天往回数（今天还没打就从昨天起算——下午三点看到"连续 5 天"不该因为
 * 今天还没拍照就掉成 0）。断一天即止。
 */
export function streakOf(counts: Map<string, number>, today: Date = new Date()): number {
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if ((counts.get(dayKey(cursor)) ?? 0) === 0) cursor.setDate(cursor.getDate() - 1)

  let streak = 0
  while ((counts.get(dayKey(cursor)) ?? 0) > 0) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

// ---------------------------------------------------------------------------
// 编辑、删除与评论（用户 2026-10-15：「我的打卡墙要添加评论功能，还要添加打开编辑和删除功能，
// 评论也要」）。判定放这里，服务层只取事实（与 orders.rules 同一套路）。
// ---------------------------------------------------------------------------

/** 一句评论的上限。比打卡备注（60）宽：备注是"给照片起个名"，评论是"对着照片说说感想" */
export const COMMENT_MAX = 200

/**
 * **谁能改这张打卡**：只有上传者本人。
 *
 * 为什么不是"全家都能改"：打卡是"**我**今天做了这道菜"的个人记录，别人改了它，
 * 照片底下署的还是原作者的名字——那是在替他说话。退菜/改菜单那几处放开，
 * 是因为那些是**共同事务**（一桌菜是大家的事）；打卡不是。
 * 家里其他人想看、想评论都能，改与删只归本人。
 */
export function canEditCheckIn(role: FamilyRole, isOwner: boolean): boolean {
  void role
  return isOwner
}

/** 同上：删也归本人（照片是"我的作品"，只有我能把它从墙上摘下来） */
export function canDeleteCheckIn(role: FamilyRole, isOwner: boolean): boolean {
  void role
  return isOwner
}

/**
 * **谁能改/删一条评论**：写它的人。
 *
 * 与打卡本身同一条口径（各自的东西各自管），**不额外给掌勺人/家长特权**：
 * 一条评论被"家长"改掉之后，下面还署着原来那个人的名字，读起来就是"他说了这句他没说过的话"。
 * 照片的作者想清掉别人在自己照片底下的胡话？——这一版不给这个能力；
 * 要清就删整张打卡（评论跟着一起没，见 D-089）。这是刻意的小口径，不装作有。
 */
export function canEditComment(role: FamilyRole, isAuthor: boolean): boolean {
  void role
  return isAuthor
}

export function canDeleteComment(role: FamilyRole, isAuthor: boolean): boolean {
  return canEditComment(role, isAuthor)
}

/**
 * 评论内容：去掉首尾空白；空的不收（"发一条空的"没有任何意思，多半是误触发送）；
 * 超长直接拒并告诉上限（截断更糟——用户以为发出去了，其实后半句没了）。
 */
export function parseComment(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('评论只能是一段文字')
  const body = raw.trim()
  if (!body) throw new BadRequestException('评论不能是空的')
  if (body.length > COMMENT_MAX) throw new BadRequestException(`评论最多 ${COMMENT_MAX} 个字`)
  return body
}
