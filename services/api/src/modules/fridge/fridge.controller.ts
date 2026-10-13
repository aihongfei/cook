import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { FridgeService } from './fridge.service'

/**
 * ⚠️ 请求体用**普通 interface**，不要写成带 `@ApiProperty` 的 class。
 *
 * `main.ts` 的全局 `ValidationPipe` 是 `whitelist: true` + `forbidNonWhitelisted: true`：
 * 一个 class DTO 只要没挂 class-validator 的校验装饰器，它的每个字段都会被判为"不在白名单"，
 * 于是**每个请求都 400**（`property name should not exist`）。本项目其它控制器都写 interface
 * （运行时被擦除，ValidationPipe 看不到元数据、原样放行），这里与它们保持一致。
 * 校验都在 `fridge.rules.ts` 里做（那是一套能单测、能给中文人话的校验）。
 */
interface FridgeBody {
  name?: string
  amount?: string
  zone?: string
  expiresOn?: string
  note?: string
}

/**
 * 冰箱库存（M6 / F6-01~F6-05）。形态见 D-049。
 *
 * 全部接口都要求登录 + 属于某个家庭：冰箱是**家里共用的**（一台冰箱一家人用），
 * 与菜单、采购、组合同一层可见性。共享关掉时的收窄在 service 里做（同一套 `visibleToMember`）。
 */
@ApiTags('fridge')
@Controller('fridge')
export class FridgeController {
  constructor(private readonly fridge: FridgeService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '冰箱里的全部食材 + 概览 + 今日先吃（M6 / F6-02/04/05）' })
  async board(@CurrentUserId() userId: string) {
    return this.fridge.board(userId)
  }

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '记一样食材（M6 / F6-03 手动录入；拍照批量入库将来也走这里）' })
  async add(@CurrentUserId() userId: string, @Body() body: FridgeBody) {
    return this.fridge.add(userId, body ?? {})
  }

  /**
   * 手边食材能做什么（F5-04 / F6-07 / F7-02 共用同一个判断）。
   *
   * **`GET /fridge/cookable` 必须挂在 `@Get(':id')` 之类的前面**——本项目没有 `:id` 的 GET
   * （冰箱是按整块读的），所以这里没有冲突；写在 `board()` 之后只是为了让"读冰箱"两个接口挨着。
   */
  @Get('cookable')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '手边食材能做哪些菜（不传 ingredients 就用整个冰箱）（F5-04 / F6-07）' })
  @ApiQuery({ name: 'ingredients', required: false, description: '手边食材，逗号分隔（如 `鸡蛋,土豆`）；不传 = 用整个冰箱' })
  @ApiQuery({ name: 'limit', required: false, description: '一页最多几道，默认 12、上限 30' })
  @ApiQuery({ name: 'maxMissing', required: false, description: '最多容忍差几样，默认 1、上限 3（0 = 只看不用买的）' })
  async cookable(
    @CurrentUserId() userId: string,
    @Query('ingredients') ingredients?: string,
    @Query('limit') limit?: string,
    @Query('maxMissing') maxMissing?: string,
  ) {
    return this.fridge.cookable(userId, { ingredients, limit, maxMissing })
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改一样食材（数量/位置/保质期/备注，也可改名字）' })
  async update(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: FridgeBody) {
    return this.fridge.update(userId, id, body ?? {})
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '拿出来了/吃完了：删掉这一条' })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.fridge.remove(userId, id)
  }
}
