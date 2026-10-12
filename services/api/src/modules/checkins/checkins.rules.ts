import { BadRequestException } from '@nestjs/common'

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
 * 按**文件头**判断真实图片类型（不认识就返回 null）。
 *
 * 为什么不能只信调用方声明的 content-type：那样把任意字节声明成 image/jpeg 就能存进去，
 * 全家人的墙上就会出现一张永远打不开的图。宁可拒绝，也不存"看着像图片"的东西。
 */
export function sniffImageType(bytes: Buffer): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // WebP: "RIFF" … "WEBP"
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/** 扩展名（私有桶的 key 用它，让存储里的对象可被人眼辨认） */
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
