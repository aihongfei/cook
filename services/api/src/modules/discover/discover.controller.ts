import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { DiscoverService } from './discover.service'

/**
 * 发现（M5 / F5-02）。口径见 D-038。
 *
 * 挂在 `discover` 而不是 `recipes` 下：它是**这一家人的**榜单（要家庭关系、要共享开关），
 * 而 `/recipes` 是公共菜谱库的读接口——两者权限与语义都不同，混在一起以后会有人拿错。
 */
@ApiTags('discover')
@Controller('discover')
export class DiscoverController {
  constructor(private readonly discover: DiscoverService) {}

  @Get('family-picks')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '家人最爱 / 家人常点（做过与收藏合起来的榜单）（F5-02）' })
  @ApiQuery({ name: 'limit', required: false, description: '一页最多几道，默认 8、上限 24' })
  async familyPicks(@CurrentUserId() userId: string, @Query('limit') limit?: string) {
    return this.discover.familyPicks(userId, limit)
  }
}
