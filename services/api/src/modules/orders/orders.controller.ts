import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { OrdersService } from './orders.service'

interface AddItemBody { recipeId?: string; mealDate?: string; meal?: string; note?: string }
interface StatusBody { status?: string }

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // 与 /family/options、/auth/options 同理：免登录可读，前端不硬编码状态与餐次
  @Get('options')
  @ApiOperation({ summary: '点单口径（餐次、状态、可选日期）（F3-01）' })
  options() {
    return this.orders.options()
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '点单列表（含状态计数）；family=false 只看我参与的（F3-01/03）' })
  @ApiQuery({ name: 'family', required: false, description: 'false 时只看我点过菜的餐次' })
  @ApiQuery({ name: 'status', required: false, description: 'ALL 或不传即全部' })
  async list(
    @CurrentUserId() userId: string,
    @Query('family') family?: string,
    @Query('status') status?: string,
  ) {
    if (family !== undefined && family !== 'true' && family !== 'false') {
      throw new BadRequestException('family 只能是 true 或 false')
    }
    return this.orders.list(userId, { family: family === undefined ? undefined : family === 'true', status })
  }

  @Post('items')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '点菜（需 order.create；已安排的餐不能再加）（F3-01/05）' })
  async addItem(@CurrentUserId() userId: string, @Body() body: AddItemBody) {
    return this.orders.addItem(userId, body ?? {})
  }

  @Delete('items/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '撤回自己点的一份菜（仅待确认阶段）（F3-05）' })
  async removeItem(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.orders.removeItem(userId, id)
  }

  @Post('meals/:mealKey/status')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '整餐状态流转（按目标状态校验能力）（F3-02）' })
  async updateStatus(@CurrentUserId() userId: string, @Param('mealKey') mealKey: string, @Body() body: StatusBody) {
    return this.orders.updateStatus(userId, mealKey, body?.status)
  }
}
