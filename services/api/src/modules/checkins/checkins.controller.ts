import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CheckInsService } from './checkins.service'
import { assertSize, parseContentType } from './checkins.rules'
import { verifyPhotoSignature } from './checkins.signature'

interface CreateBody {
  /** dataURL 或纯 base64（前端已缩到 1600px） */
  image?: string
  contentType?: string
  note?: string
  /** 可选的餐次标识（`2026-10-13-DINNER`）：只能挂"已做好"的那一餐（F9-08） */
  mealKey?: string
}

/**
 * 打卡照片（M9 / F9-03、F9-07、F9-08）。
 *
 * 上传走 **JSON + base64** 而不是 multipart：前端本来就要用 canvas 把手机原图缩到 1600px
 * （原图 3–10MB，缩完通常 < 500KB），拿到的就是 dataURL，直接放进 JSON 少一个 multer 依赖、
 * 也少一处"表单字段与文件字段混在一起"的解析复杂度。8MB 上限在解码前后都校验。
 */
@ApiTags('checkins')
@Controller('checkins')
export class CheckInsController {
  constructor(private readonly checkins: CheckInsService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  // 上传是重操作（解码 + 写对象存储）：限流比读接口紧一档
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @ApiOperation({ summary: '上传一张打卡照片（家庭成员都能传）（F9-07/08）' })
  async create(@CurrentUserId() userId: string, @Body() body: CreateBody) {
    const image = typeof body?.image === 'string' ? body.image : ''
    const base64 = image.replace(/^data:[^;]+;base64,/, '')
    if (!base64) throw new BadRequestException('缺少图片内容')

    // base64 字符集校验：不合格的输入不该走到解码（Buffer.from 会静默丢弃非法字符）
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new BadRequestException('图片内容不是合法的 base64')

    const bytes = Buffer.from(base64, 'base64')
    assertSize(bytes.byteLength)

    // contentType 可以从前端给，也可以从 dataURL 前缀推；两者都缺就按 JPEG 兜底前先校验一次
    const declared = body?.contentType
      ?? (/^data:([^;]+);base64,/.exec(image)?.[1] ?? 'image/jpeg')
    const contentType = parseContentType(declared)

    return this.checkins.create(userId, { bytes, contentType, note: body?.note, mealKey: body?.mealKey })
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '家庭打卡墙（最新在前）；共享关闭时吃货只看自己的（F9-03）' })
  @ApiQuery({ name: 'family', required: false, description: 'false 时只看我上传的' })
  @ApiQuery({ name: 'limit', required: false, description: '1–90，默认 30' })
  async wall(
    @CurrentUserId() userId: string,
    @Query('family') family?: string,
    @Query('limit') limit?: string,
  ) {
    if (family !== undefined && family !== 'true' && family !== 'false') {
      throw new BadRequestException('family 只能是 true 或 false')
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit)
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 90)) {
      throw new BadRequestException('limit 只能是 1–90 的整数')
    }
    return this.checkins.wall(userId, { family: family === undefined ? undefined : family === 'true', limit: parsedLimit })
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我的打卡统计（热力图 + 连续天数）与全家累计（F9-03）' })
  async stats(@CurrentUserId() userId: string) {
    return this.checkins.stats(userId)
  }

  /**
   * 取照片字节（F9-03）。**两道门都要过**：
   * ① 链接签名 + 24 小时有效期（防枚举、防长期外传）；
   * ② `JwtAuthGuard` + 服务层校验"这个人和照片同属一个家庭"。
   *
   * 为什么不做成"只靠签名、直接放进 `<img src>`"：那样链接一旦被转发，任何拿到它的人
   * 在 24 小时内都能看别人的家庭照片——签名只证明"链接是我们发的"，不证明"看的人是这家人"。
   * 所以前端用带令牌的请求取回字节（blob）再显示，图片接口也就成了登录接口之一。
   */
  @Get('photos/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '取打卡照片（签名 + 家庭成员双重校验）（F9-03）' })
  @Header('Cache-Control', 'private, max-age=3600')
  async photo(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query('e') expires: string,
    @Query('s') signature: string,
    @Res() response: Response,
  ) {
    verifyPhotoSignature(id, expires, signature)
    const photo = await this.checkins.readPhoto(userId, id)
    response.setHeader('Content-Type', photo.contentType)
    response.end(photo.body)
  }
}
