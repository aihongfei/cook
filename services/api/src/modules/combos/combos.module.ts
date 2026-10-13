import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { OrdersModule } from '../orders/orders.module'
import { PrismaService } from '../recipes/prisma.service'
import { CombosController } from './combos.controller'
import { CombosService } from './combos.service'

/**
 * 常用组合（M4 / F4-04）。
 *
 * 依赖 `OrdersModule`：一键加入是**逐道走 `orders.addItem`**，而不是在这里另写一段写库逻辑
 * （"加了菜之后整餐回到待确认"这类语义只有这样才只有一份）。
 */
@Module({
  imports: [
    OrdersModule,
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [CombosController],
  providers: [PrismaService, CombosService, JwtAuthGuard],
  // AI 的组合四件要走这套服务（"谁能改哪个组合"只写在 canEditCombo 里，AI 不该另写一份）
  exports: [CombosService],
})
export class CombosModule {}
