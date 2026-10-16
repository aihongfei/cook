import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaService } from '../recipes/prisma.service'
import { CheckInsController } from './checkins.controller'
import { CheckInsService } from './checkins.service'

/**
 * 打卡照片模块（M9 / F9-03、F9-07、F9-08）。
 * 与 FamilyModule / OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 *
 * 引 `NotificationsModule`（2026-10-16）：上传与评论都要告诉家里人
 * （用户：「打卡墙有上传、评论」）。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    NotificationsModule,
  ],
  controllers: [CheckInsController],
  providers: [PrismaService, CheckInsService, JwtAuthGuard],
  exports: [CheckInsService],
})
export class CheckInsModule {}
