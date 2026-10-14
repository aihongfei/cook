import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { DiscoverService } from './discover.service'

/**
 * 发现（M5 / F5-02 家人最爱、F5-05 帮我决定）。口径见 D-038 与 D-060。
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

  /**
   * 首页「菜谱推荐」：按这家人的口味/收藏/做过排序，**在这一批里随机取几道**。
   *
   * 它替代了首页原来直接调 `GET /recipes` 的做法（用户 2026-10-14：
   * 「首页的菜谱推荐现在固定那几样了」——原来按 `name ASC` 取前 6 条，每天一样）。
   */
  @Get('recommend')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '首页菜谱推荐：按口味与习惯挑一屏，每次不同（D-071）' })
  @ApiQuery({ name: 'count', required: false, description: '要几道，默认 6、上限 18' })
  async recommend(@CurrentUserId() userId: string, @Query('count') count?: string) {
    return this.discover.recommend(userId, count)
  }

  /**
   * 「摇一桌」（F5-01）：按这一餐几个人吃配一组菜。
   *
   * `mealKey` 必填——道数要按午餐/晚餐算（晚饭多一道），而且这一餐可能已经存过就餐人数。
   * `diners` 可选：这一餐没存过人数、用户又想说"今天六个人"时用它。
   * 两个都没有就按 `SPREAD_DINERS_DEFAULT` 算，并在响应里如实标 `dinersFromMeal: false`。
   */
  @Get('spread')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '摇一桌：按人数与餐次配一组菜，过忌口（F5-01）' })
  @ApiQuery({ name: 'mealKey', required: true, description: '配哪一餐，如 2026-10-14-DINNER' })
  @ApiQuery({ name: 'diners', required: false, description: '几个人吃；不给就用这一餐已存的或默认值' })
  async spread(
    @CurrentUserId() userId: string,
    @Query('mealKey') mealKey?: string,
    @Query('diners') diners?: string,
  ) {
    return this.discover.spread(userId, mealKey, diners)
  }

  /**
   * 帮我决定（F5-05）：**只给一道**。
   *
   * `exclude` 是「换一道」用的：把这一轮已经看过的 id 报回来（逗号分隔），
   * 于是"再换"不会换到同一道。校验与上限在 `decide.rules` 的 `parseExclude`。
   */
  @Get('decide')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '帮我决定：只给一道、且是此刻最该做的那道（F5-05）' })
  @ApiQuery({ name: 'exclude', required: false, description: '这一轮已经看过的菜谱 id，逗号分隔（「换一道」用）' })
  async decide(@CurrentUserId() userId: string, @Query('exclude') exclude?: string) {
    return this.discover.decide(userId, exclude)
  }
}
