import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { ShoppingService } from './shopping.service'

/**
 * ⚠️ 请求体用**普通 interface**，不要写成带 `@ApiProperty` 的 class。
 *
 * `main.ts` 的全局 `ValidationPipe` 是 `whitelist: true` + `forbidNonWhitelisted: true`：
 * 一个 class DTO 只要没挂 class-validator 的校验装饰器，它的每个字段都会被判为"不在白名单"，
 * 于是**每个请求都 400**。校验都在 `shopping.rules.ts` 里做（能单测、能给中文人话）。
 */
interface CheckBody {
  name?: string
  /** `false` = 取消勾选；不传当作勾上 */
  checked?: boolean
}

interface ExtraBody {
  name?: string
  amount?: string
}

interface RestockBody {
  /** 勾掉的那几样（"我真的买到了"） */
  names?: string[]
}

/**
 * 采购清单（M7 / F7-01、F7-02、F7-03、F7-05）。口径见 D-039、D-059 与 D-064。
 *
 * 路径用 `shopping-list` 而不是 `shopping`：后者容易被读成"购物"这个动作，
 * 而这里读的是**一份清单**。下面那几条写动作的（勾选/增减/补货）挂在它下面，
 * 因为它们改的都是**这份清单**。
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

  @Post('check')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '勾掉 / 取消勾选一样东西（F7-03 持久化）' })
  async check(@CurrentUserId() userId: string, @Body() body: CheckBody) {
    return this.shopping.check(userId, body?.name, body?.checked)
  }

  @Post('extras')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '自己往清单上加一条（F7-03「增减条目」）' })
  async addExtra(@CurrentUserId() userId: string, @Body() body: ExtraBody) {
    return this.shopping.addExtra(userId, body ?? {})
  }

  @Delete('extras/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '删掉自己加的那一条（菜单推出来的不在其中）' })
  async removeExtra(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.shopping.removeExtra(userId, id)
  }

  /**
   * 一键补货（F7-05）。**用 POST 而不是 PATCH**：它一次改动好几条数据
   * （往冰箱里写 N 条 + 取消那几个勾），不是"改一下这条记录"。
   */
  @Post('restock')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '把勾掉的几样补进冰箱（F7-05）' })
  async restock(@CurrentUserId() userId: string, @Body() body: RestockBody) {
    return this.shopping.restock(userId, body?.names)
  }
}
