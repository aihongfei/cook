import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { OrdersService } from './orders.service'

interface AddItemBody { recipeId?: string; dishName?: string; mealDate?: string; meal?: string; note?: string }
interface StatusBody { status?: string }
interface DinersBody { dinerCount?: number | null }
interface RepeatBody { mealDate?: string; meal?: string }

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

  @Get('today')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '今日安排：今天午/晚餐各自的进度（M4 / F4-01）' })
  async today(@CurrentUserId() userId: string) {
    return this.orders.today(userId)
  }

  @Get('plan')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '菜单安排：从今天起 N 天（默认 3 天）每天的午/晚餐进度（M4 / F4-02）' })
  @ApiQuery({ name: 'days', required: false, description: '看几天，默认 3（今天/明天/后天），上限 7' })
  async plan(@CurrentUserId() userId: string, @Query('days') days?: string) {
    return this.orders.plan(userId, days)
  }

  @Post('items')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '点菜：点菜谱里的（recipeId）或自己写一道（dishName），二选一（F3-01/05、F3-10）' })
  async addItem(@CurrentUserId() userId: string, @Body() body: AddItemBody) {
    return this.orders.addItem(userId, body ?? {})
  }

  @Delete('items/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '撤回自己点的一份菜（仅待确认阶段）（F3-05）' })
  async removeItem(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.orders.removeItem(userId, id)
  }

  @Post('meals/:mealKey/diners')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '设定这一餐的就餐人数（需 menu.manage；传 null 清除）（M4 / F4-05）' })
  async setDiners(@CurrentUserId() userId: string, @Param('mealKey') mealKey: string, @Body() body: DinersBody) {
    return this.orders.setDiners(userId, mealKey, body?.dinerCount)
  }

  @Post('meals/:mealKey/status')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '整餐状态流转（按目标状态校验能力）（F3-02）' })
  async updateStatus(@CurrentUserId() userId: string, @Param('mealKey') mealKey: string, @Body() body: StatusBody) {
    return this.orders.updateStatus(userId, mealKey, body?.status)
  }

  @Post('meals/:mealKey/repeat')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '再点一次：把这一餐整桌照抄到另一天某一餐，已有的菜跳过（F3-06）' })
  async repeat(@CurrentUserId() userId: string, @Param('mealKey') mealKey: string, @Body() body: RepeatBody) {
    // 与「整组加入」同一个校验点：缺参数在这里挡掉，服务层不用再猜"没给是默认还是忘了"
    if (!body || body.mealDate === undefined || body.meal === undefined) {
      throw new BadRequestException('要说清照到哪一天哪一餐')
    }
    return this.orders.repeat(userId, mealKey, body)
  }
}
