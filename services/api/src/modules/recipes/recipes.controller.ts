import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard, type AuthedRequest } from '../auth/jwt-auth.guard'
import { OptionalAuthGuard } from '../auth/optional-auth.guard'
import { RECIPE_PROVIDER, RecipeProvider } from './recipe.types'
import { parseRecipeQuery } from './recipe.query'
import { PrismaService } from './prisma.service'
import { RecipeWriteService } from './recipe-write.service'

/**
 * 菜谱：读是**公开**的（匿名只看全局库），写**只对自家自建**放行（F1-12）。
 *
 * 读之所以不强制登录：菜谱库是应用门面，未登录也该能翻（验收脚本就是这么调的）。
 * 而"自己家的菜谱"是私人的，所以同一个列表要按"有没有登录"给出不同范围——
 * 用 `OptionalAuthGuard`（带令牌就挂上 userId，没带或过期就当匿名、**不抛错**）。
 *
 * 两个写操作都只认**自建**：全局库那份是第三方数据的镜像，改了下次导入就对不上
 * （判据见 `recipe.rules` 的 `canWriteRecipe`，服务层是唯一出口，AI 也走它）。
 */
@ApiTags('recipes')
@Controller('recipes')
export class RecipesController {
  constructor(
    @Inject(RECIPE_PROVIDER) private readonly provider: RecipeProvider,
    private readonly writer: RecipeWriteService,
    private readonly prisma: PrismaService,
  ) {}

  /** 当前请求者的可见范围。匿名或没加入家庭都返回 null（调用方按"只看全局库"处理） */
  private async viewer(request: AuthedRequest): Promise<{ userId: string; familyId: string | null } | null> {
    if (!request.userId) return null
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId: request.userId },
      select: { familyId: true },
    })
    return { userId: request.userId, familyId: membership?.familyId ?? null }
  }

  @Get()
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: '菜谱分页、菜名/别名/食材/标签模糊搜索与筛选（登录后额外带上自家自建的）' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'cuisine', required: false, type: String })
  @ApiQuery({ name: 'tag', required: false, type: String, description: '按标签精确筛（可逗号给多个＝命中其一，如 秋季,秋季菜谱）' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1–10000，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: '1–100，默认 12' })
  @ApiQuery({ name: 'mine', required: false, type: String, description: '只看自己家上传的（F1-12）' })
  async list(@Query() query: Record<string, unknown>, @Req() request: AuthedRequest) {
    return this.provider.list({ ...parseRecipeQuery(query), viewer: await this.viewer(request) })
  }

  @Get('filters')
  @ApiOperation({ summary: '数据中实际存在的品类与菜系' })
  filters() { return this.provider.filters() }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: '菜谱详情与固定版本来源许可' })
  @ApiParam({ name: 'id', type: String })
  async detail(@Param('id') id: string, @Req() request: AuthedRequest) {
    const recipe = await this.provider.findById(id, await this.viewer(request))
    if (!recipe) throw new NotFoundException('Recipe not found')
    return recipe
  }

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '上传一道自己的菜谱（F1-12）' })
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    return this.writer.create(userId, body)
  }

  /**
   * 改一道自建菜谱。
   *
   * **用 PATCH 只改传了的字段**：AI 说一句"把盐改成一勺"时不该把别人写的步骤清掉，
   * 所以 `undefined` = 没提就保持原样（见 `parseRecipePatch` 的说明）。
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改一道自建菜谱（只改传了的字段）' })
  async update(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.writer.update(userId, id, body)
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '删一道自建菜谱' })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.writer.remove(userId, id)
  }
}
