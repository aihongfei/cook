import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PrismaService } from '../recipes/prisma.service'
import { RealtimeService } from './realtime.service'

/**
 * 实时通道（M10 交付五 / F10-08）。
 *
 * **单向依赖**：这个模块什么都不 import 业务模块，业务模块反过来 import 它
 * （与 `NotificationsModule` 同一个方向——`realtime.service` 只是个管道，
 * 不认识"通知"是什么，见那边的文件头）。
 *
 * 需要 `AuthModule` 是因为要复用它的 `JwtService`（那条路要验登录令牌），
 * 而 `AuthModule` 已经 `exports: [JwtAuthGuard, JwtModule]`，不用再改它。
 */
@Module({
  imports: [AuthModule],
  providers: [PrismaService, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
