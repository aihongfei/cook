import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { FavoritesService } from './favorites.service'

interface ToggleBody { recipeId?: unknown }

/**
 * 收藏（M1 / F1-09）。口径见 D-037。
 *
 * 全部接口都要求登录（收藏挂在账号上，不在家庭上——见 FavoritesService 的说明）。
 */
@ApiTags('favorites')
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我收藏的菜（最近收藏的在前）（F1-09）' })
  async list(@CurrentUserId() userId: string) {
    return this.favorites.list(userId)
  }

  /**
   * 一批菜各自的收藏状态：列表页一屏十几张卡，逐个问会有十几个请求。
   * 放在 `POST` 而不是 `GET ?ids=a,b,c`：id 列表可能很长，塞进 URL 会撞长度上限。
   */
  @Post('status')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '批量查收藏状态（列表页一次问清一屏）（F1-09）' })
  async status(@CurrentUserId() userId: string, @Body() body: { recipeIds?: unknown }) {
    return { favorited: await this.favorites.statusOf(userId, body?.recipeIds) }
  }

  @Post('toggle')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '收藏/取消收藏（同一个接口切换，返回切换后的状态）（F1-09）' })
  async toggle(@CurrentUserId() userId: string, @Body() body: ToggleBody) {
    return this.favorites.toggle(userId, body?.recipeId)
  }
}
