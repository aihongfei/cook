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
   *
   * `occasion` 是抽屉里那行「换个场合挑」（2026-10-16 定）：**可选**，默认不问场合。
   * 给的是**标签名**（`快手菜`/`下饭菜`/`宴请`/`儿童`），不是界面上那三个字
   * ——展示名会改，而 URL 上这个值一旦发出去就有人保存。可用的值见 `/discover/occasions`。
   */
  @Get('decide')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '帮我决定：只给一道、且是此刻最该做的那道（F5-05）' })
  @ApiQuery({ name: 'exclude', required: false, description: '这一轮已经看过的菜谱 id，逗号分隔（「换一道」用）' })
  @ApiQuery({ name: 'occasion', required: false, description: '换个场合挑：标签名，取值见 /discover/occasions' })
  async decide(
    @CurrentUserId() userId: string,
    @Query('exclude') exclude?: string,
    @Query('occasion') occasion?: string,
  ) {
    return this.discover.decide(userId, exclude, occasion)
  }

  /**
   * 「时令精选」（发现页那一块，2026-10-16 新增）：这个季节有什么。
   *
   * **季节由后端按月份算**，不接受参数（见 service 里的说明：能传就会有人做出"十二月看夏菜"）。
   */
  @Get('seasonal')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '时令精选：按当月季节取应季菜（D-108）' })
  async seasonal(@CurrentUserId() userId: string) {
    return this.discover.seasonal(userId)
  }

  /**
   * 「换个场合挑」的那几个词与它们的道数（发现页抽屉里的那一行胶囊）。
   *
   * 不需要登录：它读的是公共菜谱库的标签统计，与"谁在看"无关。
   */
  @Get('occasions')
  @ApiOperation({ summary: '换个场合挑：四个场合词与各自的道数（D-108）' })
  async occasions() {
    return this.discover.occasions()
  }

  /**
   * 「家庭月报」（发现页那一块，2026-10-16 新增）：全家这个月过得怎么样。
   *
   * **不足 3 顿返回 `report: null`**（不是错误、也不是一堆 0）：界面据此整块不画。
   */
  @Get('report')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '家庭月报：本月全家的四个数（D-108）' })
  async report(@CurrentUserId() userId: string) {
    return this.discover.monthlyReport(userId)
  }

  /**
   * 我做过（M9 / F9-01）：**我点过、且那一餐已经做好的**菜。
   *
   * 与「家人最爱」不是一回事：那一份按家庭口径（"我们家做过 3 次"），这一份只算我自己点的
   * ——"我的手艺账本"。所以它**不受共享开关影响**（那是"家人之间互相可见"的开关，
   * 而看自己的记录不需要别人允许）。
   */
  @Get('cooked')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我做过：我点过且那一餐已做好的菜（做过几次 · 最近日期，F9-01）' })
  @ApiQuery({ name: 'limit', required: false, description: '最多给几道，默认 30、上限 60' })
  async cooked(@CurrentUserId() userId: string, @Query('limit') limit?: string) {
    return this.discover.cooked(userId, limit)
  }
}
