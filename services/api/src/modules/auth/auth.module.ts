import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PrismaService } from '../recipes/prisma.service'
import { MailModule } from '../mail/mail.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt-auth.guard'
import { jwtSecret } from './jwt.config'

/**
 * 注册登录模块（F2-01/02/03）。
 *
 * 限流（R-07 防爆破）用 `@nestjs/throttler` 的内存实现：单实例足够，
 * 将来多实例部署时把 storage 换成 Redis 即可，接口与用法不变（见 auth.controller 的 @Throttle）。
 */
@Module({
  imports: [
    MailModule,
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [AuthController],
  providers: [PrismaService, AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
