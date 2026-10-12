import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { DiscoverController } from './discover.controller'
import { DiscoverService } from './discover.service'

/**
 * 决策引擎模块（M5 / F5-02）。
 * 与 FamilyModule / OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [DiscoverController],
  providers: [PrismaService, DiscoverService, JwtAuthGuard],
  exports: [DiscoverService],
})
export class DiscoverModule {}
