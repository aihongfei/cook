import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { AuthedRequest } from './jwt-auth.guard'

/**
 * **可选登录**守卫（M1 / F1-12，用户 2026-10-13「自己上传的要和极速 api 的区分下」）。
 *
 * 菜谱列表原来是纯公开读（验收脚本 `verify-recipes-http.cjs` 就不带 token，那是刻意的：
 * 菜谱库是应用的门面，未登录也该能翻）。加了"自建菜谱"之后，同一个列表要**既公开又私人**：
 * - 没登录 → 只看见全局库；
 * - 登录了 → 全局库 + 你们家自己传的那些。
 *
 * 所以不能用 `JwtAuthGuard`（未登录就 401，把公开读也一起挡了，验收脚本会全红），
 * 也不能不要守卫（拿不到 userId，自建那份就永远看不到）。这个守卫的职责是：
 * **带了有效令牌就把 userId 挂上，没带或无效就当作匿名继续**——不抛错。
 *
 * 一个刻意的细节：**令牌无效不报错、只当匿名**。令牌过期时用户仍应该能翻菜谱库
 * （前端会在别的请求上拿到 401 并去续期），而不是这里甩一个"登录已过期"。
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    const header = request.headers.authorization ?? ''
    const [scheme, token] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !token) return true
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token)
      if (payload.sub) request.userId = payload.sub
    } catch {
      // 过期/伪造都当匿名：只读接口不该因为令牌问题而不可用
    }
    return true
  }
}

/** 取"登录了就有的 userId"（配 OptionalAuthGuard 用；匿名时为 null） */
export function optionalUserId(request: AuthedRequest): string | null {
  return request.userId ?? null
}
