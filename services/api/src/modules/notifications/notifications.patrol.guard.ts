import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { PrismaService } from '../recipes/prisma.service'
import { digest } from '../auth/token'

/** 巡查令牌放在这个头里（不是 `Authorization`：那条留给登录令牌，两者不能混） */
export const PATROL_HEADER = 'x-patrol-token'

/**
 * 巡查令牌的鉴权（M10 交付三）。
 *
 * ## 为什么不复用 `JwtAuthGuard`
 *
 * 后台那段代码跑在系统的调度器里（WorkManager），**没有 WebView、也没有登录会话**，
 * 手里只有一枚长期令牌。它**不能是** access token（2 小时就过期，后台拿不到续期时机），
 * 也**不能是** refresh token（一用就轮换，会把用户手里的会话换掉——见 schema 里那段说明）。
 * 所以是单独一枚、永不轮换的只读令牌。
 *
 * ## 身份挂到 `request.userId`（与 JWT 那条同一处）
 *
 * 这样控制器仍用 `@CurrentUserId()` 取人，两个守卫对业务的接口**完全一样**——
 * 差别只在"凭什么证明你是你"。若另起一个字段，所有下游都得判断
 * "这次是哪条路进来的"，那种分叉迟早有人只改一边。
 */
@Injectable()
export class PatrolAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { userId?: string }>()
    const raw = request.headers[PATROL_HEADER]
    const token = Array.isArray(raw) ? raw[0] : raw
    if (!token) throw new UnauthorizedException('这台手机还没有巡查许可')

    const row = await this.prisma.notificationPatrolToken.findUnique({ where: { tokenHash: digest(token) } })
    // 三种情况同一句话：**不给"这个令牌存在但被吊销了"这种区分**（与登录接口同样的克制）
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('巡查许可已失效')
    }
    request.userId = row.userId
    return true
  }
}
