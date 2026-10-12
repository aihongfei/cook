import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { HealthModule } from './modules/health/health.module'
import { RecipesModule } from './modules/recipes/recipes.module'

/**
 * 应用根模块。
 * 业务模块（recipe / order / inventory / ai …）在 M1、M2、M6、M16 依次挂到这里。
 * 说明：菜谱图片不放这里提供——图片存在 MinIO，由它自己对外服务（见 modules/media/media.storage.ts）。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    HealthModule,
    RecipesModule,
  ],
})
export class AppModule {}
