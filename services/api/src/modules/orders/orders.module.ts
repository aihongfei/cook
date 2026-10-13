import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { TasteModule } from '../taste/taste.module'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'

/**
 * 点单模块（M3 / F3-01~F3-05）。
 * 与 FamilyModule 同理：JwtModule 的作用域是按模块隔离的，这里要自己 register 一次。
 *
 * 引 `TasteModule`：点完一道菜要判"这家有人对这个过敏吗"（F3-08）。
 * **漏引的后果是进程起不来**（Nest 解析不了 `TasteService` 这个构造参数），
 * 而 `tsc --noEmit` 看不见——依赖注入是运行期的事。本轮就是这么发现的。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    TasteModule,
  ],
  controllers: [OrdersController],
  providers: [PrismaService, OrdersService, JwtAuthGuard],
  exports: [OrdersService],
})
export class OrdersModule {}
