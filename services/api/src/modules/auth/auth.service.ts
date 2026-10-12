import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { createHash, randomBytes } from 'node:crypto'
import { PrismaService } from '../recipes/prisma.service'
import { MailService } from '../mail/mail.service'
import {
  normalizeAccount, normalizeEmail, validateAccount, validateAvatar, validateEmail, validateNickname, validatePassword,
} from './account.rules'
import { hashPassword, verifyPassword } from './password.service'

export interface PublicUser {
  id: string
  account: string
  nickname: string
  avatar: string
  email: string | null
  createdAt: string
}

export interface AuthTokens {
  token: string
  refreshToken: string
  expiresIn: number
}

export interface AuthResult extends AuthTokens {
  user: PublicUser
}

/** 刷新令牌有效期（30 天）：家里人平时不用反复登录，但长期不用的会话会自然过期 */
const REFRESH_TTL_DAYS = 30

/** 重置令牌有效期：够点开链接、又不给爆破留时间窗 */
const RESET_TTL_MINUTES = 60

function toPublicUser(user: { id: string; account: string; nickname: string; avatar: string; email: string | null; createdAt: Date }): PublicUser {
  return {
    id: user.id,
    account: user.account,
    nickname: user.nickname,
    avatar: user.avatar,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  }
}

/** 刷新令牌只存摘要：即使数据库泄漏，也没法拿去换 access token */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  async register(input: { account: string; password: string; nickname?: string; avatar?: string; email?: string }): Promise<AuthResult> {
    const accountError = validateAccount(input.account)
    if (accountError) throw new ConflictException(accountError)
    const passwordError = validatePassword(input.password)
    if (passwordError) throw new ConflictException(passwordError)

    const account = normalizeAccount(input.account)
    const nickname = (input.nickname ?? '').trim() || account
    const nicknameError = validateNickname(nickname)
    if (nicknameError) throw new ConflictException(nicknameError)
    if (input.avatar !== undefined) {
      const avatarError = validateAvatar(input.avatar)
      if (avatarError) throw new ConflictException(avatarError)
    }

    const existing = await this.prisma.user.findUnique({ where: { account } })
    if (existing) throw new ConflictException('这个账号已经注册过了')

    // 邮箱选填（只用于找回密码）；填了就要校验并查重，否则重设密码时会指向错误的账号
    let email: string | undefined
    if (input.email !== undefined && input.email.trim() !== '') {
      const emailError = validateEmail(input.email)
      if (emailError) throw new ConflictException(emailError)
      email = normalizeEmail(input.email)
      const emailTaken = await this.prisma.user.findUnique({ where: { email } })
      if (emailTaken) throw new ConflictException('这个邮箱已经绑过别的账号了')
    }

    const user = await this.prisma.user.create({
      data: {
        account, nickname, passwordHash: await hashPassword(input.password),
        ...(input.avatar ? { avatar: input.avatar } : {}),
        ...(email ? { email } : {}),
      },
    })
    return { user: toPublicUser(user), ...(await this.issueTokens(user.id)) }
  }

  async login(input: { account: string; password: string }): Promise<AuthResult> {
    const account = normalizeAccount(input.account)
    const user = await this.prisma.user.findUnique({ where: { account } })
    // 账号不存在与密码错误返回同一句话：不给撞库的人"这个账号存在"的信息
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : false
    if (!user || !ok) throw new UnauthorizedException('账号或密码不对')
    return { user: toPublicUser(user), ...(await this.issueTokens(user.id)) }
  }

  /** 刷新即轮换：旧刷新令牌当场吊销，换一对新的（被盗用的旧令牌只能用一次） */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: digest(refreshToken) }, include: { user: true } })
    if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('登录已过期，请重新登录')
    }
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } })
    return { user: toPublicUser(record.user), ...(await this.issueTokens(record.userId)) }
  }

  /** 退出登录：吊销这个刷新令牌（access token 是短时 JWT，到期自然失效） */
  async logout(refreshToken: string | null, userId: string): Promise<{ revoked: number }> {
    if (refreshToken) {
      const result = await this.prisma.refreshToken.updateMany({
        where: { tokenHash: digest(refreshToken), userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      return { revoked: result.count }
    }
    // 没带刷新令牌就把该账号所有会话都吊销（"退出所有设备"语义）
    const result = await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
    return { revoked: result.count }
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new UnauthorizedException('账号不存在')
    return toPublicUser(user)
  }

  async updateProfile(userId: string, input: { nickname?: string; avatar?: string; email?: string | null }): Promise<PublicUser> {
    const data: { nickname?: string; avatar?: string; email?: string | null } = {}
    if (input.nickname !== undefined) {
      const error = validateNickname(input.nickname)
      if (error) throw new ConflictException(error)
      data.nickname = input.nickname.trim()
    }
    if (input.avatar !== undefined) {
      const error = validateAvatar(input.avatar)
      if (error) throw new ConflictException(error)
      data.avatar = input.avatar
    }
    if (input.email !== undefined) {
      // 传 null / 空串 = 解绑；否则校验格式后存小写（避免 A@x.com 与 a@x.com 算两个邮箱）
      if (input.email === null || input.email.trim() === '') {
        data.email = null
      } else {
        const error = validateEmail(input.email)
        if (error) throw new ConflictException(error)
        const email = normalizeEmail(input.email)
        const taken = await this.prisma.user.findUnique({ where: { email } })
        if (taken && taken.id !== userId) throw new ConflictException('这个邮箱已经绑过别的账号了')
        data.email = email
      }
    }
    const user = await this.prisma.user.update({ where: { id: userId }, data })
    return toPublicUser(user)
  }

  /**
   * 申请找回密码（F2-04）。
   *
   * **无论邮箱是否存在都返回同样的结果**，否则这个接口就成了"查这个邮箱注册过没有"的枚举工具。
   * 生成的是**一次性令牌**：只存摘要、1 小时有效、用掉即作废。
   */
  async requestPasswordReset(email: string): Promise<{ sent: boolean; devResetUrl?: string }> {
    const error = validateEmail(email)
    if (error) throw new BadRequestException(error)

    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } })
    if (!user) {
      // 故意不告诉调用方"邮箱没绑定过"
      return { sent: true }
    }

    const token = randomBytes(32).toString('base64url')
    await this.prisma.passwordReset.create({
      data: {
        tokenHash: digest(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
      },
    })

    const url = `${this.resetPageBase()}?token=${token}`
    await this.mail.send({
      to: user.email as string,
      subject: '御膳 · 重设你的密码',
      text: [
        `${user.nickname}，你好：`,
        '',
        `点开这个链接重设密码（${RESET_TTL_MINUTES} 分钟内有效，只能用一次）：`,
        url,
        '',
        '如果这不是你发的，忽略这条消息就行，密码不会变。',
      ].join('\n'),
    })

    // console 模式（开发期）把链接一并回给调用方，省得去翻日志；smtp 模式下绝不会带这个字段
    return this.mail.exposesDevLink ? { sent: true, devResetUrl: url } : { sent: true }
  }

  /** 用令牌重设密码（F2-04）：改密码 + 令牌作废 + **吊销所有会话**（密码变了，旧登录不该继续有效） */
  async resetPassword(token: string, password: string): Promise<{ ok: true }> {
    const error = validatePassword(password)
    if (error) throw new ConflictException(error)

    const record = await this.prisma.passwordReset.findUnique({ where: { tokenHash: digest(token) } })
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('这个重置链接无效或已经过期了，请重新申请')
    }

    const passwordHash = await hashPassword(password)
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      // 密码是被改过的（可能因为账号已被别人拿到），旧会话一律作废
      this.prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    return { ok: true }
  }

  private resetPageBase(): string {
    // 重置页在前端；开发期指向本机 Vite。部署时用 PUBLIC_APP_URL 覆盖成正式地址。
    return `${(process.env.PUBLIC_APP_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')}/reset-password`
  }

  private async issueTokens(userId: string): Promise<AuthTokens> {
    const expiresIn = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200)
    const token = await this.jwt.signAsync({ sub: userId }, { expiresIn })
    const refreshToken = randomBytes(32).toString('base64url')
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: digest(refreshToken),
        userId,
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    })
    return { token, refreshToken, expiresIn }
  }
}
