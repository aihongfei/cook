import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'

/**
 * AI 推荐与问答（M16 子集 / 用户 2026-10-12 的新需求，口径见 D-026）。
 * 与 OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [AiController],
  providers: [PrismaService, AiService, JwtAuthGuard],
})
export class AiModule {}
