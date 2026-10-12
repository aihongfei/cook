import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { FamilyRole } from '@prisma/client'
import { can, CAPABILITIES } from '../family/family.roles'
import {
  ensurePrivateBucket, getPrivateImage, mediaS3Config, privateBucketName, privateMediaKey,
  putPrivateImage, s3Client,
} from '../media/media.storage'
import { PrismaService } from '../recipes/prisma.service'
import {
  assertSize, buildHeatmap, dayKey, extensionFor, parseContentType, parseDayKey, parseNote, sniffImageType, storedDayKey,
  type HeatmapGrid,
} from './checkins.rules'
import { signedPhotoPath } from './checkins.signature'

/**
 * 打卡照片（M9 / F9-03、F9-07、F9-08；口径见 D-023）。
 *
 * - 家庭成员都能上传，**同家庭一起看**；共享开关关闭时吃货只看到自己上传的；
 * - 照片存**私有桶**并只给**签名短链**（见 checkins.signature.ts）；
 * - 可挂在「已做好」的一餐上（F9-08），其它状态不给挂（后端强制校验）。
 */

export interface CheckInView {
  id: string
  /** 签名短链（前端直接放进 <img src>）；数据库里不存这个地址 */
  photoUrl: string
  photoExpiresAt: number
  note: string | null
  checkDate: string
  createdAt: string
  userId: string
  nickname: string
  avatar: string
  isMe: boolean
  /** 挂在哪一餐上（成品照）；独立打卡为 null */
  mealKey: string | null
  mealLabel: string | null
}

export interface CheckInWall {
  items: CheckInView[]
  total: number
  /** 这一页之后还有没有更多（首页只取最近 30 张） */
  hasMore: boolean
  scope: 'family' | 'mine'
}

export interface CheckInStats {
  /** 我的打卡热力图（"我的"页展示） */
  mine: HeatmapGrid
  /** 全家累计（副文本一行） */
  family: HeatmapGrid
  /** 我的照片总数 / 全家总数 */
  mineTotal: number
  familyTotal: number
  /** 有没有可挂的餐（前端据此决定要不要显示"挂到某一餐"） */
  attachableMeals: { mealKey: string; label: string }[]
}

const DAY_MS = 86_400_000

@Injectable()
export class CheckInsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 上传一张打卡照片（F9-07）。
   * `bytes` 已经过调用方的大小与类型校验（见 controller），这里再做一次纯规则校验，
   * 保证服务层单独被调用时也不会把非法内容写进存储。
   */
  async create(
    userId: string,
    input: { bytes: Buffer; contentType: string; note?: unknown; mealKey?: string },
  ): Promise<CheckInView> {
    const { familyId } = await this.requireMember(userId)

    const declared = parseContentType(input.contentType)
    assertSize(input.bytes.byteLength)
    const note = parseNote(input.note)

    // 以文件头判断真实类型，而不是信调用方声明的那个：否则任何字节都能伪装成图片存进来
    const sniffed = sniffImageType(input.bytes)
    if (!sniffed) throw new BadRequestException('这个文件不是图片（只支持 JPEG / PNG / WebP）')
    if (sniffed !== declared) {
      throw new BadRequestException(`图片实际是 ${sniffed}，与声明的 ${declared} 不一致`)
    }
    const contentType = sniffed

    // 挂了餐就必须是"已做好"的那一餐，且属于我的家庭（F9-08）
    let mealOrderId: string | null = null
    if (input.mealKey) {
      const meal = await this.requireMealByKey(familyId, input.mealKey)
      if (meal.status !== 'DONE') {
        throw new BadRequestException('只有「已做好」的那一餐能传成品照')
      }
      mealOrderId = meal.id
    }

    // 内容哈希命名：同一张图重复上传只占一份空间，也让写入天然幂等
    const hash = createHash('sha256').update(input.bytes).digest('hex')
    const key = privateMediaKey(hash, extensionFor(contentType))

    const config = mediaS3Config()
    const bucket = privateBucketName()
    const client = s3Client(config)
    await ensurePrivateBucket(client, bucket)
    await putPrivateImage(client, bucket, key, input.bytes, contentType)

    const row = await this.prisma.checkIn.create({
      data: {
        familyId,
        userId,
        mealOrderId,
        imageKey: key,
        imageHash: hash,
        // 打卡日取**服务器本地时区**的日历日（容器 TZ=Asia/Shanghai），
        // 再按 UTC 零点存进 DATE 列（与 mealDate 同一口径）
        checkDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
        note,
      },
      // mealOrder 也要 include：否则成品照虽然挂上了餐，返回的卡片里 mealKey 却是 null
      include: { user: true, mealOrder: true },
    })

    return this.view(row, userId)
  }

  /**
   * 家庭打卡墙（F9-03）：最新在前。
   * 共享开关关闭时吃货只看到自己上传的（与点单同一套可见性口径）。
   */
  async wall(userId: string, options: { family?: boolean; limit?: number } = {}): Promise<CheckInWall> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.prisma.family.findUnique({ where: { id: familyId } })
    if (!family) throw new NotFoundException('家庭不存在')

    const mineOnly = options.family === false || (!family.shared && role === 'EATER')
    const take = Math.min(Math.max(options.limit ?? 30, 1), 90)

    const rows = await this.prisma.checkIn.findMany({
      where: { familyId, ...(mineOnly ? { userId } : {}) },
      include: { user: true, mealOrder: true },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
    })

    const items = rows.slice(0, take).map(row => this.view(row, userId))
    return { items, total: items.length, hasMore: rows.length > take, scope: mineOnly ? 'mine' : 'family' }
  }

  /**
   * 我的页统计（F9-03）：我的热力图 + 全家累计。
   * 统计的是**打卡张数**（不是点单状态）——热力图要反映"这个人有没有进厨房"。
   */
  async stats(userId: string): Promise<CheckInStats> {
    const { familyId } = await this.requireMember(userId)
    const from = new Date(Date.now() - 200 * DAY_MS)

    const [mineRows, familyRows, meals] = await Promise.all([
      this.prisma.checkIn.findMany({ where: { familyId, userId, checkDate: { gte: from } }, select: { checkDate: true } }),
      this.prisma.checkIn.findMany({ where: { familyId, checkDate: { gte: from } }, select: { checkDate: true } }),
      this.prisma.mealOrder.findMany({
        where: { familyId, status: 'DONE' },
        orderBy: [{ mealDate: 'desc' }, { meal: 'desc' }],
        take: 10,
        select: { mealDate: true, meal: true },
      }),
    ])

    const mineCounts = countByDay(mineRows.map(row => storedDayKey(row.checkDate)))
    const familyCounts = countByDay(familyRows.map(row => storedDayKey(row.checkDate)))

    return {
      mine: buildHeatmap(mineCounts),
      family: buildHeatmap(familyCounts),
      mineTotal: mineRows.length,
      familyTotal: familyRows.length,
      attachableMeals: meals.map(row => ({
        mealKey: `${storedDayKey(row.mealDate)}-${row.meal}`,
        label: `${storedDayKey(row.mealDate).slice(5).replace('-', ' / ')} · ${row.meal === 'LUNCH' ? '午餐' : '晚餐'}`,
      })),
    }
  }

  /**
   * 取照片字节（签名链接的目标）。**先验签名（controller）→ 再验家庭成员身份 → 才读私有桶。**
   */
  async readPhoto(userId: string, checkinId: string): Promise<{ body: Buffer; contentType: string }> {
    const { familyId } = await this.requireMember(userId)
    const row = await this.prisma.checkIn.findUnique({ where: { id: checkinId } })
    if (!row || row.familyId !== familyId) throw new NotFoundException('这张照片不存在')

    const photo = await getPrivateImage(s3Client(mediaS3Config()), privateBucketName(), row.imageKey)
    if (!photo) throw new NotFoundException('照片读不出来了')

    // 兜底：万一存储里的类型丢了，按扩展名给一个正确的 content-type（浏览器要靠它显示）
    return { body: photo.body, contentType: photo.contentType || `image/${row.imageKey.split('.').pop()}` }
  }

  // ---------- 内部 ----------

  private view(
    row: {
      id: string; userId: string; note: string | null; checkDate: Date; createdAt: Date
      user: { nickname: string; avatar: string }
      mealOrder?: { mealDate: Date; meal: string } | null
    },
    viewerId: string,
  ): CheckInView {
    const { path, expiresAt } = signedPhotoPath(row.id)
    return {
      id: row.id,
      photoUrl: path,
      photoExpiresAt: expiresAt,
      note: row.note,
      checkDate: storedDayKey(row.checkDate),
      createdAt: row.createdAt.toISOString(),
      userId: row.userId,
      nickname: row.user.nickname,
      avatar: row.user.avatar,
      isMe: row.userId === viewerId,
      mealKey: row.mealOrder ? `${storedDayKey(row.mealOrder.mealDate)}-${row.mealOrder.meal}` : null,
      mealLabel: row.mealOrder ? (row.mealOrder.meal === 'LUNCH' ? '午餐' : '晚餐') : null,
    }
  }

  private async requireMember(userId: string): Promise<{ familyId: string; role: FamilyRole }> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) throw new NotFoundException('先加入家庭，才能和家人一起打卡')
    return { familyId: membership.familyId, role: membership.role as FamilyRole }
  }

  private async requireMealByKey(familyId: string, mealKey: string) {
    const matched = /^(\d{4}-\d{2}-\d{2})-(LUNCH|DINNER)$/.exec(mealKey ?? '')
    if (!matched) throw new BadRequestException('这一餐的标识不对')
    // 按 UTC 零点构造：与写入时 dateOnly() 的口径一致（DATE 列不带时间）
    const mealDate = new Date(`${parseDayKey(matched[1])}T00:00:00.000Z`)
    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal: matched[2] as 'LUNCH' | 'DINNER' } },
    })
    if (!row) throw new NotFoundException('这一餐还没有人点菜')
    return row
  }
}

/** 打卡人必须能点菜（吃货就行）——打卡是"我今天做了饭"，不该比点菜更严 */
export function mayCheckIn(role: FamilyRole): boolean {
  return can(role, CAPABILITIES.ORDER_CREATE)
}

function countByDay(days: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1)
  return counts
}
