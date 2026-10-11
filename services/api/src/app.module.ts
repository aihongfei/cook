import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { HealthModule } from './modules/health/health.module'

/**
 * 应用根模块。
 * 业务模块（recipe / order / inventory / ai …）在 M1、M2、M6、M16 依次挂到这里。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    HealthModule,
  ],
})
export class AppModule {}
