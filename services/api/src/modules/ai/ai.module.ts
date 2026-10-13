import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { FridgeModule } from '../fridge/fridge.module'
import { PrismaService } from '../recipes/prisma.service'
import { AiActionService } from './ai-action.service'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'

/**
 * AI 推荐与问答（M16 子集 / 用户 2026-10-12 的新需求，口径见 D-026）；
 * 全局助手与"对话里办事"见 D-052（F16-10）。
 * 与 OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 *
 * 引 `FridgeModule` 是为了让 AI 走**用户自己那套冰箱服务**写库（不另写一份）：
 * 这样"AI 记的食材"与"用户手记的"在数据、校验、权限上没有半点区别（D-052）。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    FridgeModule,
  ],
  controllers: [AiController],
  providers: [PrismaService, AiService, AiActionService, JwtAuthGuard],
})
export class AiModule {}
