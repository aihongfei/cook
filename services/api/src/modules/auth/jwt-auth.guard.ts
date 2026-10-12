import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Request } from 'express'

/** 通过鉴权的请求会挂上 userId；控制器用 @CurrentUserId() 取 */
export interface AuthedRequest extends Request {
  userId?: string
}

/**
 * JWT 鉴权守卫（F2-02）。
 * 未登录访问受保护接口统一返回 401，前端据此跳登录页。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    const header = request.headers.authorization ?? ''
    const [scheme, token] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('请先登录')
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token)
      if (!payload.sub) throw new Error('missing sub')
      request.userId = payload.sub
      return true
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录')
    }
  }
}

/** 取当前登录用户 id（仅用于已挂 JwtAuthGuard 的接口） */
export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<AuthedRequest>()
  if (!request.userId) throw new UnauthorizedException('请先登录')
  return request.userId
})
