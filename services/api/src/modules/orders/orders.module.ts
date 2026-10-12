import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'

/**
 * 点单模块（M3 / F3-01~F3-05）。
 * 与 FamilyModule 同理：JwtModule 的作用域是按模块隔离的，这里要自己 register 一次。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [OrdersController],
  providers: [PrismaService, OrdersService, JwtAuthGuard],
  exports: [OrdersService],
})
export class OrdersModule {}
