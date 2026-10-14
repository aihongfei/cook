import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AiModule } from './modules/ai/ai.module'
import { AuthModule } from './modules/auth/auth.module'
import { CheckInsModule } from './modules/checkins/checkins.module'
import { CombosModule } from './modules/combos/combos.module'
import { DiscoverModule } from './modules/discover/discover.module'
import { FamilyModule } from './modules/family/family.module'
import { FavoritesModule } from './modules/favorites/favorites.module'
import { FridgeModule } from './modules/fridge/fridge.module'
import { HealthModule } from './modules/health/health.module'
import { NotificationsModule } from './modules/notifications/notifications.module'
import { OrdersModule } from './modules/orders/orders.module'
import { RecipesModule } from './modules/recipes/recipes.module'
import { ShoppingModule } from './modules/shopping/shopping.module'
import { TasteModule } from './modules/taste/taste.module'

/**
 * 应用根模块。
 * 业务模块（order / inventory / ai …）在后续里程碑依次挂到这里。
 * 说明：菜谱图片不放这里提供——图片存在 MinIO，由它自己对外服务（见 modules/media/media.storage.ts）。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    // 接口限流（R-07）：全局兜底 60 次/分钟，登录等敏感接口在控制器上用 @Throttle 收紧
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    HealthModule,
    AiModule,
    NotificationsModule,
    AuthModule,
    FamilyModule,
    OrdersModule,
    CombosModule,
    FavoritesModule,
    FridgeModule,
    TasteModule,
    DiscoverModule,
    ShoppingModule,
    CheckInsModule,
    RecipesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
