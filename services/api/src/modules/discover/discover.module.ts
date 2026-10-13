import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { TasteModule } from '../taste/taste.module'
import { DiscoverController } from './discover.controller'
import { DiscoverService } from './discover.service'

/**
 * 决策引擎模块（M5 / F5-02 家人最爱、F5-05 帮我决定）。
 * 与 FamilyModule / OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 *
 * ⚠️ **imports 里少一个模块，症状是容器无限重启**，而 `tsc` 与单测全绿
 * （Nest 的注入错误运行时才炸，见 RISKS R-43）。`TasteModule` 是给「帮我决定」的
 * 口味过滤（F5-03 的同一个判据）用的。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    TasteModule,
  ],
  controllers: [DiscoverController],
  providers: [PrismaService, DiscoverService, JwtAuthGuard],
  exports: [DiscoverService],
})
export class DiscoverModule {}
