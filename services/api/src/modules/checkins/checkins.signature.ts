import { createHmac, timingSafeEqual } from 'node:crypto'
import { UnauthorizedException } from '@nestjs/common'

/**
 * 打卡照片的**签名短链**（M9 / D-023）。
 *
 * 为什么不用现成的 S3 预签名 URL：① 那要求把对象存储的密钥交给前端或经过额外签名调用；
 * ② 我们要在**读出图片之前**校验"你是不是这个家的成员"，S3 预签名做不到这点。
 * 所以走自己的签名：链接里带 `checkinId + 过期时间 + 签名`，取图时先验签名与过期，
 * 再验家庭成员身份，最后才从私有桶读字节。
 *
 * 签名口径：HMAC-SHA256(`checkinId.expiresAt`) 的 base64url 前 32 字符。
 * 签名密钥复用 `JWT_SECRET`（同一个部署密钥体系，不新增配置项；它已经强制 ≥32 字符）。
 * **只暴露签名与过期时间，不泄漏任何用户/家庭信息。**
 */

/** 链接有效期：24 小时。够一次浏览会话与把页面放着看，又短到即使外传也很快失效 */
export const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60

export function signingSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET 缺失或过短，无法签发打卡照片链接')
  return secret
}

function digest(checkinId: string, expiresAt: number): string {
  return createHmac('sha256', signingSecret())
    .update(`${checkinId}.${expiresAt}`)
    .digest('base64url')
    .slice(0, 32)
}

/** 为一张打卡照片签发相对路径（前端直接用，不需要知道后端域名） */
export function signedPhotoPath(checkinId: string, now: Date = new Date()): { path: string; expiresAt: number } {
  const expiresAt = Math.floor(now.getTime() / 1000) + SIGNED_URL_TTL_SECONDS
  const signature = digest(checkinId, expiresAt)
  return { path: `/checkins/photos/${encodeURIComponent(checkinId)}?e=${expiresAt}&s=${signature}`, expiresAt }
}

/** 校验签名与有效期；任何一项不对都抛 401（不区分原因，避免成为探测工具） */
export function verifyPhotoSignature(checkinId: string, rawExpires: unknown, rawSignature: unknown, now: Date = new Date()): void {
  const expiresAt = Number(rawExpires)
  const signature = typeof rawSignature === 'string' ? rawSignature : ''
  if (!Number.isSafeInteger(expiresAt) || !signature) throw new UnauthorizedException('照片链接无效')

  const expected = digest(checkinId, expiresAt)
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  // 长度不同时 timingSafeEqual 会抛错，先比长度（长度本身不是秘密）
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new UnauthorizedException('照片链接无效')
  }
  if (expiresAt * 1000 < now.getTime()) throw new UnauthorizedException('照片链接已过期，刷新页面重新加载')
}
