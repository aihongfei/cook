import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CombosService } from './combos.service'

interface ComboBody { name?: string; note?: string; recipeIds?: unknown }
interface AddBody { mealDate?: string; meal?: string }

/**
 * 常用组合（M4 / F4-04）。
 *
 * 全部接口都要求登录 + 属于某个家庭（组合是**家庭内共用**的）。
 * 「一键加入」复用点菜那套权限（`order.create`）：能点菜的就能用组合，
 * 组合本身不额外要求角色——它是"帮人少点几下"的东西。
 */
@ApiTags('combos')
@Controller('combos')
export class CombosController {
  constructor(private readonly combos: CombosService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '家里的常用组合（M4 / F4-04）' })
  async list(@CurrentUserId() userId: string) {
    return this.combos.list(userId)
  }

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '新建一个组合（从这一餐存下来或从菜谱里挑几道）' })
  async create(@CurrentUserId() userId: string, @Body() body: ComboBody) {
    return this.combos.create(userId, body ?? {})
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改组名/说明，或整组替换菜（发完整列表）' })
  async update(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: ComboBody) {
    return this.combos.update(userId, id, body ?? {})
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '删掉一个组合（组它的人或掌勺人/帮厨）' })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.combos.remove(userId, id)
  }

  @Post(':id/add')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '一键把整组加进某一天某一餐（已有的菜跳过，不叠加份数）' })
  async addToMeal(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: AddBody) {
    if (!body || body.mealDate === undefined || body.meal === undefined) {
      throw new BadRequestException('要说清加到哪一天哪一餐')
    }
    return this.combos.addToMeal(userId, id, body)
  }
}
