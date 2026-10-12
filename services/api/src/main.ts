import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  // 统一前缀 /api（前端 VITE_API_BASE_URL 末尾同样是 /api）
  app.setGlobalPrefix('api')

  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN')?.split(',') ?? true,
    credentials: true,
  })

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  )

  const swaggerConfig = new DocumentBuilder()
    .setTitle('御膳私房菜 API')
    .setDescription('家庭点菜 / 冰箱库存 / 菜谱 / AI 识图')
    .setVersion('0.1')
    .build()
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig))

  const port = Number(config.get('PORT') ?? 3000)
  // 容器里必须监听 0.0.0.0，否则同网络内的 nginx/其它服务连不上；本机开发保持只绑回环。
  const host = config.get<string>('HOST') ?? '127.0.0.1'
  await app.listen(port, host)
  // eslint-disable-next-line no-console
  console.log(`[api] ready → http://${host}:${port}/api  (docs: /api/docs)`)
}

void bootstrap()
