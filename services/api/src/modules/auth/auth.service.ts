import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { createHash, randomBytes } from 'node:crypto'
import { PrismaService } from '../recipes/prisma.service'
import {
  normalizeAccount, validateAccount, validateAvatar, validateNickname, validatePassword,
} from './account.rules'
import { hashPassword, verifyPassword } from './password.service'

export interface PublicUser {
  id: string
  account: string
  nickname: string
  avatar: string
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

function toPublicUser(user: { id: string; account: string; nickname: string; avatar: string; createdAt: Date }): PublicUser {
  return { id: user.id, account: user.account, nickname: user.nickname, avatar: user.avatar, createdAt: user.createdAt.toISOString() }
}

/** 刷新令牌只存摘要：即使数据库泄漏，也没法拿去换 access token */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async register(input: { account: string; password: string; nickname?: string; avatar?: string }): Promise<AuthResult> {
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

    const user = await this.prisma.user.create({
      data: {
        account, nickname, passwordHash: await hashPassword(input.password),
        ...(input.avatar ? { avatar: input.avatar } : {}),
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

  async updateProfile(userId: string, input: { nickname?: string; avatar?: string }): Promise<PublicUser> {
    const data: { nickname?: string; avatar?: string } = {}
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
    const user = await this.prisma.user.update({ where: { id: userId }, data })
    return toPublicUser(user)
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
