import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { ShoppingController } from './shopping.controller'
import { ShoppingService } from './shopping.service'

/**
 * 采购清单模块（M7 / F7-01）。
 * 与 FamilyModule / OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [ShoppingController],
  providers: [PrismaService, ShoppingService, JwtAuthGuard],
  exports: [ShoppingService],
})
export class ShoppingModule {}
