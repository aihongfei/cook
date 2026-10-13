import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'

async function bootstrap() {
  /*
   * 泛型必须是 `NestExpressApplication`（不是默认的 `INestApplication`）：
   * `useBodyParser` 只有 Express 适配器才有——不写这个泛型，`tsc` 直接报
   * `Property 'useBodyParser' does not exist on type 'INestApplication'`
   * （构建镜像时就会红在这，见 RUNBOOK R-059 的坑 1）。
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  const config = app.get(ConfigService)

  /*
   * 请求体上限（**必须放在路由之前**，body-parser 是先注册先处理）。
   *
   * 为什么非改不可：图片是以 **base64 塞在 JSON 里**传的，而 Express 默认的 JSON 上限只有
   * **100kb**——这个数远小于任何一张真实照片：客户端已按「最长边 1600px / JPEG 0.85」压过，
   * 一张菜照仍有几百 KB，base64 之后再 ×4/3。于是**请求还没进到业务校验就被 body-parser 拒了**，
   * 用户看到的是 413 `request entity too large`（英文原文，前端连话术都换不了），
   * 而业务侧那句友好的「单张照片不能超过 8MB」（checkins.rules / image.rules）**永远走不到**。
   *
   * 定 14MB 的依据：业务上限是 **8MB 二进制**（`CHECKIN_MAX_BYTES` / `IMAGE_MAX_BYTES`），
   * 而 base64 会把体积放大到 **4/3**——8MB 的图 base64 后就是 10.67MB，加 JSON 外壳与
   * data URL 前缀约 10.7MB。**必须比这个数再留余量**，否则用户上传一张"刚好超一点"的图，
   * 拿到的会是英文 413，而不是"单张照片不能超过 8MB"那句人话。
   * 14MB 对应"能完整收到约 10.5MB 的二进制图"——业务上限之内的都进得来，
   * 超出 8MB 但不到 10.5MB 的也能进到业务层拿到中文话术（实测过，见 RUNBOOK R-059）。
   *
   * ⚠️ 别把它当成"可以随便调大"的旋钮：每多 1MB 就是一个可被放大 60 次/分的解析开销
   * （见 `RISKS.md` 的说明）。真要传大文件，正路是改成 multipart/流式，不是继续抬这个数。
   */
  app.useBodyParser('json', { limit: '14mb' })
  app.useBodyParser('urlencoded', { extended: true, limit: '14mb' })

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
