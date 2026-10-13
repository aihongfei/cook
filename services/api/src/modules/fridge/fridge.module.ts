import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { FridgeController } from './fridge.controller'
import { FridgeService } from './fridge.service'

/**
 * 冰箱库存（M6 / F6-01~F6-05）。
 *
 * 不依赖别的业务模块：它只读写自己那张表（库存是"家里确实有什么"的事实，
 * 不从菜单推、也不回写菜单——那两件事分别是采购清单与将来 F7-02/F6-07 的事）。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [FridgeController],
  providers: [PrismaService, FridgeService, JwtAuthGuard],
})
export class FridgeModule {}
