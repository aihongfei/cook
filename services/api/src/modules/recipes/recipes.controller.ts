import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common'
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger'
import { RECIPE_PROVIDER, RecipeProvider } from './recipe.types'
import { parseRecipeQuery } from './recipe.query'

@ApiTags('recipes')
@Controller('recipes')
export class RecipesController {
  constructor(@Inject(RECIPE_PROVIDER) private readonly provider: RecipeProvider) {}

  @Get()
  @ApiOperation({ summary: '菜谱分页、菜名/别名/食材/标签模糊搜索与筛选' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'cuisine', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1–10000，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: '1–100，默认 12' })
  list(@Query() query: Record<string, unknown>) {
    return this.provider.list(parseRecipeQuery(query))
  }

  @Get('filters')
  @ApiOperation({ summary: '数据中实际存在的品类与菜系' })
  filters() { return this.provider.filters() }

  @Get(':id')
  @ApiOperation({ summary: '菜谱详情与固定版本来源许可' })
  @ApiParam({ name: 'id', type: String })
  async detail(@Param('id') id: string) {
    const recipe = await this.provider.findById(id)
    if (!recipe) throw new NotFoundException('Recipe not found')
    return recipe
  }
}
