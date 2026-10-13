import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { TasteService } from './taste.service'
import { ALLERGY_SUGGESTIONS, DIET_OPTIONS, DISLIKE_SUGGESTIONS, FLAVOR_SUGGESTIONS, SPICY_LEVELS } from './taste.rules'

/**
 * 口味与健康档案（M8 / F8-01、F8-02）。
 *
 * 请求体用**普通 interface**（不是带 `@ApiProperty` 的 class）：全局 ValidationPipe 是
 * `whitelist + forbidNonWhitelisted`，没有校验装饰器的 class DTO 会让每个请求 400
 * （见 fridge.controller 的 ⚠️）。校验都在 `taste.rules.ts` 里做。
 */
interface TasteBody {
  spicyLevel?: unknown
  flavors?: unknown
  diet?: unknown
  allergies?: unknown
  dislikes?: unknown
  note?: unknown
}

@ApiTags('taste')
@Controller('taste')
export class TasteController {
  constructor(private readonly taste: TasteService) {}

  /**
   * 可选项与建议词（免登录）。
   *
   * 免登录是有意的：**空态就要能看见这些东西长什么样**（"原来可以写过敏"），
   * 而不是登录后才给一个空白表单。这些内容不含任何用户数据。
   */
  @Get('options')
  @ApiOperation({ summary: '口味档案的可选项与建议词（F8-01/02）' })
  options() {
    return {
      spicyLevels: SPICY_LEVELS,
      diets: DIET_OPTIONS,
      allergies: ALLERGY_SUGGESTIONS,
      dislikes: DISLIKE_SUGGESTIONS,
      flavors: FLAVOR_SUGGESTIONS,
    }
  }

  /** 我自己的档案 */
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我的口味与忌口档案（没写过返回 null）（F8-01/02）' })
  async mine(@CurrentUserId() userId: string) {
    return this.taste.mine(userId)
  }

  /**
   * 全家的档案（含**还没写的人**）。
   *
   * 单独一个接口而不是塞进 `/family`：那一个是家庭成员管理（角色、邀请码），
   * 而这一份是"谁吃不了什么"——两者改动频率差很远，混在一起会让家庭页
   * 每次都要多取一堆用不上的字段。
   */
  @Get('family')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '全家的口味与忌口（含"还没写"的成员，F8-02）' })
  async family(@CurrentUserId() userId: string) {
    const result = await this.taste.family(userId)
    /*
     * 判据（`active`）**不下发**：它是服务端内部用来过滤推荐/提醒的形状，
     * 前端需要的是那几个人（`members`）与"谁还没写"（`missing`）。
     * 下发一份判据等于把内部形状变成对外契约，将来改判据就成了一次破坏性变更。
     */
    return { me: result.me, members: result.members, missing: result.missing }
  }

  /** 改我自己的档案（部分更新：传了哪个字段才动哪个） */
  @Patch()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改我的口味与忌口（只改自己那份）（F8-01/02）' })
  async update(@CurrentUserId() userId: string, @Body() body: TasteBody) {
    return this.taste.update(userId, body ?? {})
  }
}
