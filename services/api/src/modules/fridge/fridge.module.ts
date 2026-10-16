import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaService } from '../recipes/prisma.service'
import { TasteModule } from '../taste/taste.module'
import { FridgeController } from './fridge.controller'
import { FridgeService } from './fridge.service'

/**
 * 冰箱库存（M6 / F6-01~F6-05）。
 *
 * 只读自己那张表，除了**口味档案**（FridgeService 注入了 `TasteService`）：F5-04 的
 * "手边食材能做什么"要把有人过敏的菜排掉（F5-03 的同一个判据），所以要 import `TasteModule`。
 *
 * 引 `NotificationsModule`（2026-10-16）：放进来 / 改动 / 拿走都要告诉家里人
 * （用户：「冰箱有变化」——冰箱是家里共用的，谁动了都该能看见）。
 *
 * ⚠️ **imports 里少一个模块，症状是容器无限重启**，而 `tsc` 与单测全绿
 * （Nest 的注入错误运行时才炸，见 RISKS R-43）。加注入就顺手把这里补上。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    TasteModule,
    NotificationsModule,
  ],
  controllers: [FridgeController],
  providers: [PrismaService, FridgeService, JwtAuthGuard],
  // 导出给 AI 助手用：它要经**这一套**（而不是自己再写一份）往冰箱里写（D-052 的 A 档）
  exports: [FridgeService],
})
export class FridgeModule {}
