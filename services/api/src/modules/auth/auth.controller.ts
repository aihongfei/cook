import { BadRequestException, Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { AuthResult, AuthService, PublicUser } from './auth.service'
import { ALLOWED_AVATARS, ACCOUNT_MAX, PASSWORD_MAX, PASSWORD_MIN } from './account.rules'
import { CurrentUserId, JwtAuthGuard } from './jwt-auth.guard'

interface RegisterBody { account?: string; password?: string; nickname?: string; avatar?: string }
interface LoginBody { account?: string; password?: string }
interface RefreshBody { refreshToken?: string }
interface ProfileBody { nickname?: string; avatar?: string }

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new BadRequestException(`${field}不能为空`)
  return value
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: '注册（账号 + 密码，F2-01）' })
  async register(@Body() body: RegisterBody): Promise<AuthResult> {
    return this.auth.register({
      account: requireString(body?.account, '账号'),
      password: requireString(body?.password, '密码'),
      nickname: typeof body?.nickname === 'string' ? body.nickname : undefined,
      avatar: typeof body?.avatar === 'string' ? body.avatar : undefined,
    })
  }

  @Post('login')
  @HttpCode(200)
  // 限流（R-07 防爆破）：同一来源每分钟最多 8 次登录尝试，超了返回 429
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @ApiOperation({ summary: '登录（账号 + 密码，发 access/refresh 令牌）' })
  async login(@Body() body: LoginBody): Promise<AuthResult> {
    return this.auth.login({
      account: requireString(body?.account, '账号'),
      password: requireString(body?.password, '密码'),
    })
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: '用刷新令牌换新令牌（旧令牌当场吊销）' })
  async refresh(@Body() body: RefreshBody): Promise<AuthResult> {
    return this.auth.refresh(requireString(body?.refreshToken, '刷新令牌'))
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '退出登录（带 refreshToken 只退当前会话，不带则退全部）' })
  async logout(@CurrentUserId() userId: string, @Body() body: RefreshBody): Promise<{ revoked: number }> {
    return this.auth.logout(typeof body?.refreshToken === 'string' ? body.refreshToken : null, userId)
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '当前登录账号（自动登录用，F2-02）' })
  async me(@CurrentUserId() userId: string): Promise<PublicUser> {
    return this.auth.me(userId)
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改昵称与头像（F2-03）' })
  async updateProfile(@CurrentUserId() userId: string, @Body() body: ProfileBody): Promise<PublicUser> {
    return this.auth.updateProfile(userId, {
      nickname: typeof body?.nickname === 'string' ? body.nickname : undefined,
      avatar: typeof body?.avatar === 'string' ? body.avatar : undefined,
    })
  }

  @Get('options')
  @ApiOperation({ summary: '注册页需要的口径（账号/密码规则、可选头像），前端提示与后端共用一套' })
  options() {
    return {
      accountMaxLength: ACCOUNT_MAX,
      passwordMinLength: PASSWORD_MIN,
      passwordMaxLength: PASSWORD_MAX,
      avatars: ALLOWED_AVATARS,
    }
  }
}
