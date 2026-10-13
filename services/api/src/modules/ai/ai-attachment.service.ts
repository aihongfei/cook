import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { ensurePrivateBucket, getPrivateImage, mediaS3Config, privateBucketName, putPrivateImage, s3Client } from '../media/media.storage'
import { decodeImage } from '../media/image.rules'
import { PrismaService } from '../recipes/prisma.service'
import { ATTACH_KEEP_PER_FAMILY } from './ai-attachment.rules'

/**
 * AI 对话里的图片附件（F16-05 的一次落地）。
 *
 * 三个刻意的决定：
 *
 * - **存私有桶**（`ai/` 前缀）：这些是家里的冰箱/厨房照片，与打卡照片同一级别的私人内容。
 *   菜谱图能公开读是因为它本来就给所有人看，这里不行。
 * - **按内容哈希命名**：同一张图重复上传（用户点两次"发送"、或从同一张照片再问一次）
 *   只占一份空间，写入天然幂等。
 * - **读出时按家庭校验**：id 是随机的 cuid，但 id 泄漏过一次就等于永久可读——
 *   所以取字节之前先查这张图属于哪个家，与"取图的人是不是那一家的"比对。
 */
@Injectable()
export class AiAttachmentService {
  constructor(private readonly prisma: PrismaService) {}

  /** 当前用户的家庭归属（没有家庭就传不了图：附件按家庭隔离，没有家就没有归属） */
  private async familyOf(userId: string): Promise<string> {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      select: { familyId: true },
    })
    if (!membership) throw new ForbiddenException('先加入家庭，才能给 AI 发图片')
    return membership.familyId
  }

  /**
   * 收一张图（dataURL / 纯 base64），返回它的 id。
   *
   * 类型判定走 `decodeImage`（**按文件头**，与菜谱配图、打卡照片共用一处）：
   * 只信调用方声明的类型，就等于任何字节都能被声明成图片存进来。
   */
  async create(userId: string, raw: unknown): Promise<{ id: string; mimeType: string }> {
    const familyId = await this.familyOf(userId)
    const body = (raw ?? {}) as { image?: unknown; contentType?: unknown }
    const { bytes, contentType } = decodeImage(body.image, body.contentType)

    const hash = createHash('sha256').update(bytes).digest('hex')
    const key = `ai/${hash}.${contentType.split('/')[1]}`

    const config = mediaS3Config()
    const bucket = privateBucketName()
    const client = s3Client(config)
    // 请求路自己把桶建出来：不能假设打卡那边先跑过一次
    await ensurePrivateBucket(client, bucket)
    await putPrivateImage(client, bucket, key, bytes, contentType)

    /*
     * 同一张图**复用已有那条记录**（按家庭 + 哈希找）：用户重复发同一张照片时
     * 不该在库里堆出一串同内容的行（每行都占额度、也都出现在清理范围内）。
     */
    const existing = await this.prisma.aiAttachment.findFirst({
      where: { familyId, imageHash: hash },
      select: { id: true, mimeType: true },
    })
    if (existing) return existing

    const row = await this.prisma.aiAttachment.create({
      data: { familyId, userId, imageKey: key, imageHash: hash, mimeType: contentType, bytes: bytes.byteLength },
      select: { id: true, mimeType: true },
    })
    // 顺手压一下留存（一个家最多留 ATTACH_KEEP_PER_FAMILY 张，最老的先走）
    await this.prune(familyId)
    return row
  }

  /** 读一张图的字节（先校验"它属于这个人的家庭"，再动对象存储） */
  async read(userId: string, id: string): Promise<{ body: Buffer; contentType: string }> {
    const familyId = await this.familyOf(userId)
    const row = await this.prisma.aiAttachment.findUnique({
      where: { id },
      select: { familyId: true, imageKey: true, mimeType: true },
    })
    // 不存在与"不是你们家的"回同一个 404：区分开会变成一个探测"这个 id 存在吗"的工具
    if (!row || row.familyId !== familyId) throw new NotFoundException('这张图片不在了')

    const photo = await getPrivateImage(s3Client(mediaS3Config()), privateBucketName(), row.imageKey)
    if (!photo) throw new NotFoundException('这张图片不在了')
    return { body: photo.body, contentType: photo.contentType || row.mimeType }
  }

  /**
   * 把一串 id 读成"能发给模型的图"（base64 + 类型），**只认这个家庭的**。
   *
   * 校验在这里做而不是在 rules 里：rules 是纯函数、不碰数据库，而"这个 id 能不能用"
   * 必须查库。**拿不到的一律抛错而不是静默跳过**——用户发了三张图、只给模型看两张，
   * 它会拿着两张回答一个需要三张的问题，而用户完全不知道少了哪张。
   */
  async loadForModel(familyId: string, ids: string[]): Promise<{ data: string; mimeType: string }[]> {
    if (ids.length === 0) return []
    const rows = await this.prisma.aiAttachment.findMany({
      where: { id: { in: ids }, familyId },
      select: { id: true, imageKey: true, mimeType: true },
    })
    const found = new Map(rows.map((row) => [row.id, row]))
    const missing = ids.filter((id) => !found.has(id))
    if (missing.length > 0) throw new ForbiddenException('有一张图片不在了，重新发一次吧')

    const client = s3Client(mediaS3Config())
    const bucket = privateBucketName()
    const out: { data: string; mimeType: string }[] = []
    for (const id of ids) {
      const row = found.get(id)!
      const image = await getPrivateImage(client, bucket, row.imageKey)
      if (!image) throw new ForbiddenException('有一张图片不在了，重新发一次吧')
      out.push({ data: image.body.toString('base64'), mimeType: image.contentType || row.mimeType })
    }
    return out
  }

  /**
   * 把**一张**图读成能发给模型的形状，供"照片识别"那条路用（F16-04）。
   *
   * 与 `loadForModel` 分开是因为它的调用方不一样：识别接口收的是**一张刚传上来的图**
   * （id 来自同一次请求），而对话那条收的是历史里的一串 id。共用会让"一张"这个约束
   * 变成调用方自己要去保证的事。
   */
  async loadOne(userId: string, id: string): Promise<{ data: string; mimeType: string }> {
    const familyId = await this.familyOf(userId)
    const [image] = await this.loadForModel(familyId, [id])
    if (!image) throw new NotFoundException('这张图片不在了')
    return image
  }

  /**
   * 超出留存上限时删最老的几条（连同对象存储里的字节）。
   *
   * **只删库里的行与对象，不动对话**：前端那份 localStorage 里还留着一个 id，
   * 点开时取不到图——所以取图接口对"已经清掉的"回 404 而不是 500，
   * 前端据此画一句"这张图已清理"，而不是一个破图图标。
   */
  private async prune(familyId: string): Promise<void> {
    const rows = await this.prisma.aiAttachment.findMany({
      where: { familyId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      skip: ATTACH_KEEP_PER_FAMILY,
    })
    if (rows.length === 0) return
    await this.prisma.aiAttachment.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
  }
}
