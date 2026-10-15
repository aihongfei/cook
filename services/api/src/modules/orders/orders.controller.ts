import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { OrdersService } from './orders.service'

interface AddItemBody { recipeId?: string; dishName?: string; mealDate?: string; meal?: string; note?: string }
interface BulkItemsBody { recipeIds?: unknown; mealDate?: string; meal?: string }
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

  @Get('history')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '点单历史：按日期区间往前翻（默认最近 31 天），每天的午/晚餐（F3-09）' })
  @ApiQuery({ name: 'to', required: false, description: '这一页的结束日（含），默认今天' })
  @ApiQuery({ name: 'pageSize', required: false, description: '一页多少天，默认 31，上限 62' })
  async history(@CurrentUserId() userId: string, @Query('to') to?: string, @Query('pageSize') pageSize?: string) {
    return this.orders.history(userId, { to, pageSize })
  }

  /**
   * 某一餐的详情（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
   *
   * **必须排在最后**：`:mealKey` 会吃掉同层的任何一段路径，写在 `today` / `plan` /
   * `history` 前面的话，`GET /orders/today` 会被它当成一个 mealKey（Nest 按声明顺序匹配）。
   * 参数形状是第二道防线（`parseMealKey` 只认 `YYYY-MM-DD-LUNCH|DINNER`），
   * 但"路由到哪一条"这件事不该靠参数校验兜。
   */
  @Get(':mealKey')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '某一餐的详情（点卡片进入；可见性与列表同一口径）' })
  async detail(@CurrentUserId() userId: string, @Param('mealKey') mealKey: string) {
    return this.orders.detail(userId, mealKey)
  }

  @Post('items')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '点菜：点菜谱里的（recipeId）或自己写一道（dishName），二选一（F3-01/05、F3-10）' })
  async addItem(@CurrentUserId() userId: string, @Body() body: AddItemBody) {
    return this.orders.addItem(userId, body ?? {})
  }

  /**
   * 一次加一组（F5-01「摇一桌」的「全都加进这一餐」）。
   *
   * **不是 `items` 加个复数参数**：那会让"加一道"的契约（recipeId 或 dishName 二选一）
   * 变得含糊——批量这一支只收菜谱 id（自己写的菜没有稳定 id，成组加它没有意义）。
   * 分成两个路由，两边的校验与语义各自清楚。
   */
  @Post('items/bulk')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '批量加菜：一组菜谱一次加进某一餐，已有跳过（F5-01）' })
  async addItems(@CurrentUserId() userId: string, @Body() body: BulkItemsBody) {
    return this.orders.addItems(userId, body ?? {})
  }

  @Delete('items/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '退掉一份菜（家里谁都退得掉；到「正在做」为止，DONE 封口）（F3-05）' })
  async removeItem(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.orders.removeItem(userId, id)
  }

  /**
   * 整桌退掉（列表里长按多选 → 批量操作；用户 2026-10-15）。
   *
   * 与上面那条是**同一套守卫**（谁能退、退到哪一步），只是范围从"一份"变成"这一餐全部"。
   * 退完这一餐空了，整张卡随之消失——用户说的"卡片要能删除"就是它。
   */
  @Delete('meals/:mealKey/items')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '把这一餐整桌退掉（卡片随之消失；家里谁都退得掉）（用户 2026-10-15）' })
  async clearItems(@CurrentUserId() userId: string, @Param('mealKey') mealKey: string) {
    return this.orders.clearItems(userId, mealKey)
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
