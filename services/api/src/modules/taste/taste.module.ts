import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { TasteController } from './taste.controller'
import { TasteService } from './taste.service'

/**
 * 口味与健康档案（M8 / F8-01、F8-02）。
 *
 * 导出 `TasteService` 给三处用：AI 助手（读写档案 + 每轮对话带上忌口）、
 * 发现页推荐（F5-03 过滤）、点菜（F3-08 提醒）。这三处都要"这家谁能吃什么"，
 * 而那件事只有一个权威来源——这一份。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [TasteController],
  providers: [PrismaService, TasteService, JwtAuthGuard],
  exports: [TasteService],
})
export class TasteModule {}
