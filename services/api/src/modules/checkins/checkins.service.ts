import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { FamilyRole } from '@prisma/client'
import { can, CAPABILITIES } from '../family/family.roles'
import {
  ensurePrivateBucket, getPrivateImage, mediaS3Config, privateBucketName, privateMediaKey,
  putPrivateImage, s3Client,
} from '../media/media.storage'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../recipes/prisma.service'
import {
  assertSize, buildHeatmap, canDeleteCheckIn, canDeleteComment, canEditCheckIn, canEditComment,
  dayKey, extensionFor, parseComment, parseContentType, parseDayKey, parseNote, sniffImageType, storedDayKey,
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

export interface CheckInCommentView {
  id: string
  body: string
  createdAt: string
  /** 改过之后会晚于 createdAt（"这句是后来改的"要看得出来） */
  updatedAt: string
  userId: string
  nickname: string
  avatar: string
  isMe: boolean
  /** 我能不能改/删这一条（后端算好，前端只负责显示按钮——判定不许抄两遍） */
  canEdit: boolean
  canDelete: boolean
}

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
  /** 我能不能改/删这一张（只归上传者本人，见 rules 里的说明） */
  canEdit: boolean
  canDelete: boolean
  /** 照片底下家里人说的话（时间正序：先说的在上面） */
  comments: CheckInCommentView[]
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

/**
 * 读一张打卡时要一起取回来的东西。
 *
 * 提出来是因为**四个地方都要用同一份**（上传回传、墙、单张、改完回传）：
 * 少写一个 `comments` 就会出现"墙上有评论、改一次备注回传之后评论没了"这种只在某条路径上
 * 复现的 bug。`comments` 按**时间正序**（先说的话在上面，看对话的习惯）。
 */
const CHECKIN_INCLUDE = {
  user: true,
  mealOrder: true,
  comments: { include: { user: true }, orderBy: { createdAt: 'asc' } },
} as const

@Injectable()
export class CheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    /** 「打卡墙有上传、评论」要告诉家里人（用户 2026-10-16） */
    private readonly notifications: NotificationsService,
  ) {}

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
      include: CHECKIN_INCLUDE,
    })

    /*
     * 「打卡墙有上传」告诉家里人（用户 2026-10-16）。
     *
     * 去处是**打卡墙本身**（不是那一张的详情）：墙是"最新在前"，新传的那张就在最前面，
     * 点进去一眼就看到——而详情抽屉需要 id、也得前端再拼一次路径。
     * 键用这张打卡的 id：同一个人同一天传两张是两件事，各提醒一次。
     *
     * ⚠️ **不报"挂了哪一餐"**：`mealKey` 给 null。这一条说的是"有人传了照片"，
     * 而它的去处是打卡墙；挂到点单卡上的话，会在订单页也标出一个"有新照片"的角标，
     * 而用户从那儿点进去看到的还是打卡墙——两处标记指向同一件事，多一处就是噪音。
     */
    await this.notifications.recordChange(familyId, {
      kind: 'checkin',
      action: note ? `打卡了：${note}` : '往打卡墙传了一张照片',
      body: note ? null : '去看看做得怎么样',
      to: '/checkins',
      mealKey: null,
      tag: '打卡',
      scope: `photo:${row.id}`,
    }, userId)

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
      include: CHECKIN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
    })

    const items = rows.slice(0, take).map(row => this.view(row, userId))
    return { items, total: items.length, hasMore: rows.length > take, scope: mineOnly ? 'mine' : 'family' }
  }

  /**
   * 单张打卡（详情抽屉、以及改/删/评论之后的回传）。
   *
   * **可见性与墙一字不差**：共享关闭时吃货看不到别人上传的那张——
   * 否则"墙上没有、直接输 id 却看得到"就是一个洞（与点单详情同一条规矩）。
   */
  async one(userId: string, checkInId: string): Promise<CheckInView> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.prisma.family.findUnique({ where: { id: familyId } })
    if (!family) throw new NotFoundException('家庭不存在')

    const row = await this.prisma.checkIn.findUnique({ where: { id: checkInId }, include: CHECKIN_INCLUDE })
    if (!row || row.familyId !== familyId) throw new NotFoundException('这张照片不存在')
    if (!family.shared && role === 'EATER' && row.userId !== userId) {
      throw new NotFoundException('这张照片不存在')
    }
    return this.view(row, userId)
  }

  /**
   * 改打卡（用户 2026-10-15：「还要添加打开编辑和删除功能」）。
   *
   * 只能改**一句交代**（`note`）——照片本身不给换：换图等于换了一条记录，
   * 而旧照片已经在对象存储里按内容哈希存着、热力图也按它记过一天。
   * 要"换一张"的正路是删掉重传（两步都可见、都有回执）。
   *
   * 谁能改：只有上传者本人（`canEditCheckIn`）。别人替他说"我今天做了什么"是不对的。
   */
  async updateNote(userId: string, checkInId: string, input: { note?: unknown }): Promise<CheckInView> {
    const { familyId, role } = await this.requireMember(userId)
    const row = await this.prisma.checkIn.findUnique({ where: { id: checkInId }, include: CHECKIN_INCLUDE })
    if (!row || row.familyId !== familyId) throw new NotFoundException('这张照片不存在')
    if (!canEditCheckIn(role, row.userId === userId)) throw new ForbiddenException('只能改自己上传的那一张')

    const note = parseNote(input?.note)
    const updated = await this.prisma.checkIn.update({
      where: { id: checkInId },
      data: { note },
      include: CHECKIN_INCLUDE,
    })
    return this.view(updated, userId)
  }

  /**
   * 删打卡（含它底下的评论——外键 Cascade，见 schema）。
   *
   * 只删**数据库里的记录**，**不删对象存储里的照片**：同一张图按内容哈希只存一份，
   * 别人可能也传过同一张（幂等命名）；而"删掉这个 key"会把他们的照片一起弄坏。
   * 存储里留着的那份是**只读、要签名+家庭成员双重校验**才取得到的（见 controller），
   * 不会因为这条记录没了而泄漏。这是刻意的取舍，不是漏了。
   */
  async remove(userId: string, checkInId: string): Promise<{ id: string; removedComments: number }> {
    const { familyId, role } = await this.requireMember(userId)
    const row = await this.prisma.checkIn.findUnique({
      where: { id: checkInId },
      include: { _count: { select: { comments: true } } },
    })
    if (!row || row.familyId !== familyId) throw new NotFoundException('这张照片不存在')
    if (!canDeleteCheckIn(role, row.userId === userId)) throw new ForbiddenException('只能删自己上传的那一张')

    await this.prisma.checkIn.delete({ where: { id: checkInId } })
    return { id: checkInId, removedComments: row._count.comments }
  }

  /** 在某张打卡底下说一句（家里人谁都可以——评论是"对着照片回应"，不是"改这张照片"） */
  async addComment(userId: string, checkInId: string, input: { body?: unknown }): Promise<CheckInCommentView> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.prisma.family.findUnique({ where: { id: familyId } })
    if (!family) throw new NotFoundException('家庭不存在')

    const row = await this.prisma.checkIn.findUnique({ where: { id: checkInId } })
    if (!row || row.familyId !== familyId) throw new NotFoundException('这张照片不存在')
    // 看都看不到的那张（共享关闭 + 别人的）也不该能评论
    if (!family.shared && role === 'EATER' && row.userId !== userId) {
      throw new NotFoundException('这张照片不存在')
    }

    const body = parseComment(input?.body)
    const created = await this.prisma.checkInComment.create({
      data: { checkInId, userId, body },
      include: { user: true },
    })

    /*
     * 「打卡墙有评论」告诉家里人（用户 2026-10-16）。
     *
     * 去处是**打卡墙**而不是那一张的详情：评论要连着照片看才有意义，而详情抽屉是
     * 前端按 id 打开的——`/checkins` 是那一页的路由，用户在墙上找到那张就能看到这句。
     * 键用这条评论的 id：改一次评论不会重发（改是 `updateComment`，它不写提醒——
     * "我把话说得更清楚了"不值得打扰家里人一次）。
     *
     * ⚠️ 评论**不区分是谁的照片**：给别人的照片评论是常态，给自己的照片评论也可能发生
     * （补一句"这个火候刚好"）。后者没必要通知家里人吗？——**要**：那句话是说给家人看的，
     * 而通知的收件人恰好就是除我之外的人，所以不做额外判断。
     */
    await this.notifications.recordChange(familyId, {
      kind: 'comment',
      action: `在打卡墙说了一句`,
      body: body.length > 24 ? `${body.slice(0, 24)}…` : body,
      to: '/checkins',
      mealKey: null,
      tag: '评论',
      scope: `comment:${created.id}`,
    }, userId)

    return this.commentView(created, userId)
  }

  /** 改一条评论（只有写它的人，见 `canEditComment` 的说明） */
  async updateComment(userId: string, commentId: string, input: { body?: unknown }): Promise<CheckInCommentView> {
    const { familyId, role } = await this.requireMember(userId)
    const row = await this.prisma.checkInComment.findUnique({
      where: { id: commentId },
      include: { user: true, checkIn: true },
    })
    if (!row || row.checkIn.familyId !== familyId) throw new NotFoundException('这条评论不存在')
    if (!canEditComment(role, row.userId === userId)) throw new ForbiddenException('只能改自己写的那句')

    const body = parseComment(input?.body)
    const updated = await this.prisma.checkInComment.update({
      where: { id: commentId },
      data: { body },
      include: { user: true },
    })
    return this.commentView(updated, userId)
  }

  /** 删一条评论（只有写它的人） */
  async removeComment(userId: string, commentId: string): Promise<{ id: string; checkInId: string }> {
    const { familyId, role } = await this.requireMember(userId)
    const row = await this.prisma.checkInComment.findUnique({
      where: { id: commentId },
      include: { checkIn: true },
    })
    if (!row || row.checkIn.familyId !== familyId) throw new NotFoundException('这条评论不存在')
    if (!canDeleteComment(role, row.userId === userId)) throw new ForbiddenException('只能删自己写的那句')

    await this.prisma.checkInComment.delete({ where: { id: commentId } })
    return { id: commentId, checkInId: row.checkInId }
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
      comments?: {
        id: string; body: string; createdAt: Date; updatedAt: Date; userId: string
        user: { nickname: string; avatar: string }
      }[]
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
      // 判定按**本人**算，不看角色（rules 里写了为什么只归上传者）
      canEdit: row.userId === viewerId,
      canDelete: row.userId === viewerId,
      comments: (row.comments ?? []).map(comment => this.commentView(comment, viewerId)),
    }
  }

  /** 一条评论的对外形状（`isMe`/`canEdit`/`canDelete` 都按**看的人**算） */
  private commentView(
    row: {
      id: string; body: string; createdAt: Date; updatedAt: Date; userId: string
      user: { nickname: string; avatar: string }
    },
    viewerId: string,
  ): CheckInCommentView {
    return {
      id: row.id,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      userId: row.userId,
      nickname: row.user.nickname,
      avatar: row.user.avatar,
      isMe: row.userId === viewerId,
      canEdit: row.userId === viewerId,
      canDelete: row.userId === viewerId,
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
