import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PrismaService } from '../recipes/prisma.service'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { FamilyController } from './family.controller'
import { FamilyService } from './family.service'

/**
 * 家庭与成员模块（F2-05/06/07/09）。
 *
 * JwtModule 在 AuthModule 里已经 register 过，但 Nest 的 module 作用域是隔离的：
 * 这里要自己 register 一次才能注入 JwtService / 使用 JwtAuthGuard（两处用同一个 secret 来源）。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [FamilyController],
  providers: [PrismaService, FamilyService, JwtAuthGuard],
  exports: [FamilyService],
})
export class FamilyModule {}
