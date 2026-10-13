import { BadRequestException } from '@nestjs/common'
import { extensionForContentType, sniffImageType } from '../media/media.storage'

/**
 * 图片上传的**共同规则**（打卡照片与自建菜谱配图都用它）。
 *
 * 为什么抽出来：这三件事（大小上限、真实类型判定、声明与内容是否一致）是**安全判断**，
 * 每个上传口各写一遍的话，只要有一处漏了 SVG/HTML，那个口子就能把任意字节存成图片。
 * 打卡那一套原来写在 `checkins.rules` 里，自建菜谱要加同款能力时不再复制一遍。
 */

/**
 * 单张图上限 8MB。
 *
 * 前端已经缩过图（最长边 1600px、JPEG 0.85，通常 < 500KB），这个上限是**兜底**：
 * 缩图失败的浏览器（极端情况下 canvas 拿不到）会把原图发上来，8MB 免得手机原图被误拒。
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** 只认这三种：与 `sniffImageType`、`extensionForContentType` 一一对应 */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export interface DecodedImage {
  bytes: Buffer
  contentType: string
}

export function assertImageSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new BadRequestException('图片内容为空')
  if (bytes > IMAGE_MAX_BYTES) {
    throw new BadRequestException(`单张图片不能超过 ${Math.floor(IMAGE_MAX_BYTES / 1024 / 1024)}MB`)
  }
}

/**
 * 解一份 dataURL / 纯 base64 图片，并**按文件头核对**真实类型。
 *
 * 两处刻意的：
 * - **base64 字符集先校验**：不合格的输入不该走到解码（`Buffer.from` 会静默丢弃非法字符，
 *   于是"这张图"会变成另一段字节，问题被推迟到显示时才暴露）；
 * - **声明与内容必须一致**：只信声明的话，把 HTML 声明成 image/jpeg 就能存进去；
 *   只信内容的话，扩展名会与浏览器收到的 Content-Type 对不上。
 */
export function decodeImage(raw: unknown, declared?: unknown): DecodedImage {
  const image = typeof raw === 'string' ? raw : ''
  const base64 = image.replace(/^data:[^;]+;base64,/, '')
  if (!base64) throw new BadRequestException('缺少图片内容')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new BadRequestException('图片内容不是合法的 base64')

  const bytes = Buffer.from(base64, 'base64')
  assertImageSize(bytes.byteLength)

  const sniffed = sniffImageType(bytes)
  if (!sniffed) throw new BadRequestException('这个文件不是图片（只支持 JPEG / PNG / WebP）')

  // 声明可以从前端给，也可以从 dataURL 前缀推；推不出来就按内容算
  const said = typeof declared === 'string' && declared.trim()
    ? declared.split(';')[0].trim().toLowerCase()
    : (/^data:([^;]+);base64,/.exec(image)?.[1] ?? sniffed)
  if (said !== sniffed) {
    throw new BadRequestException(`图片实际是 ${sniffed}，与声明的 ${said} 不一致`)
  }
  if (extensionForContentType(sniffed) === null) throw new BadRequestException('只支持 JPEG / PNG / WebP 图片')
  return { bytes, contentType: sniffed }
}
