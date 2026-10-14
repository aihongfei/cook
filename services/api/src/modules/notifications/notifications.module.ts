import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { NotificationsController } from './notifications.controller'
import { PatrolAuthGuard } from './notifications.patrol.guard'
import { NotificationsService } from './notifications.service'

/**
 * 消息提醒（M10）。口径见 D-078。
 *
 * 不依赖 OrdersModule / FridgeModule：它**只读**那两张表（自己用 PrismaService 查），
 * 不调用它们的服务——反过来让它们依赖本模块会成环。判据里用到的纯函数（`visibleToMember`、
 * `expiryState`）是**从各自模块直接引的纯规则**，这与"服务之间不互相调"是两件事：
 * 纯规则没有状态，引它不会带来耦合，反而是"同一口径只有一份"的保证。
 *
 * 两个守卫并存：`JwtAuthGuard`（界面上的人）与 `PatrolAuthGuard`（后台那段代码，
 * 凭巡查令牌）。两条路对下游完全一样——都把身份挂到 `request.userId`（见守卫里那段说明）。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [NotificationsController],
  providers: [PrismaService, NotificationsService, JwtAuthGuard, PatrolAuthGuard],
  // 导出给 AiModule 用：AI 若以后要"看我的提醒"，走同一份实现（不另查一遍）
  exports: [NotificationsService],
})
export class NotificationsModule {}
