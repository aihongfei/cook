import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { PrismaService } from '../recipes/prisma.service'
import { FavoritesController } from './favorites.controller'
import { FavoritesService } from './favorites.service'

/**
 * 收藏（M1 / F1-09）。
 *
 * 不依赖 OrdersModule：收藏与点单没有关系（它是私人偏好，不是家庭协作），
 * 也没有"一键把收藏加进菜单"这种动作——要做的话走菜谱卡上的「点这道」（F1-10）即可。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [FavoritesController],
  providers: [PrismaService, FavoritesService, JwtAuthGuard],
})
export class FavoritesModule {}
