import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { ShoppingService } from './shopping.service'

/**
 * 采购清单（M7 / F7-01）。口径见 D-039。
 *
 * 路径用 `shopping-list` 而不是 `shopping`：后者容易被读成"购物"这个动作，
 * 而这里读的是**一份清单**（以后若有"把某样标记为已买"，那是另一个接口）。
 */
@ApiTags('shopping')
@Controller('shopping-list')
export class ShoppingController {
  constructor(private readonly shopping: ShoppingService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '按接下来几天的最终菜单汇总一份采购清单（F7-01）' })
  @ApiQuery({ name: 'days', required: false, description: '看几天，默认与备菜计划同一个窗口（默认 3、上限 7）' })
  async list(@CurrentUserId() userId: string, @Query('days') days?: string) {
    return this.shopping.list(userId, days)
  }
}
