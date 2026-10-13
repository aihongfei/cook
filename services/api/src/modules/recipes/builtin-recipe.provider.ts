import { Injectable } from '@nestjs/common'
import { Prisma, Recipe as RecipeRow } from '@prisma/client'
import { publicImageUrl } from '../media/media.storage'
import { sourceLabel } from './recipe.rules'
import { Ingredient, Recipe, RecipeFilters, RecipePage, RecipeProvider, RecipeQuery, RecipeSource, RecipeSummary } from './recipe.types'
import { PrismaService } from './prisma.service'

/**
 * 从库里的一行拼摘要。
 *
 * `viewerFamilyId` 决定 `mine`（能不能改）：判据与写操作**是同一个**
 * （`canWriteRecipe`：familyId 精确相等才算自己的）。界面画不画"编辑"按钮
 * 与接口放不放行必须是同一件事——两处各判一次必然分叉，一处放行一处拦截。
 */
function summary(row: RecipeRow, viewerFamilyId: string | null): RecipeSummary {
  // 已备份到自托管存储的用自托管地址（第三方链接会过期），没备份的才回退源站直链
  return { id: row.id, name: row.name, image: publicImageUrl(row.imageKey, row.image), category: row.category, cuisine: row.cuisine,
    tags: row.tags as string[], calories: row.calories, caloriesEstimated: row.caloriesEstimated,
    origin: row.origin, sourceLabel: sourceLabel(row.origin),
    mine: row.familyId !== null && row.familyId === viewerFamilyId }
}

/**
 * 可见范围（F1-12）：**全局库 + 自己家的**。
 *
 * 匿名（`viewer` 为空）只看全局库；登录后额外带上自家传的那些。
 * 别人家的自建菜谱一律看不见——与冰箱、常用组合同一个口径：
 * 一家人的东西不给外人看，判据是 `familyId` **精确相等**（不是"非空就可见"）。
 *
 * `mine=1` 是同一条件的"只要自己那半"（列表页的「我的菜谱」用）。
 */
function visibility(query: RecipeQuery): Prisma.RecipeWhereInput {
  const familyId = query.viewer?.familyId ?? null
  if (query.mine) {
    // 只看自己家的：没登录/没有家庭时给一个恒假条件（匹配不到东西，而不是报错）
    return { familyId: familyId ?? '__none__' }
  }
  if (!familyId) return { familyId: null }
  return { OR: [{ familyId: null }, { familyId }] }
}

@Injectable()
export class BuiltinRecipeProvider implements RecipeProvider {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: RecipeQuery): Promise<RecipePage> {
    const where: Prisma.RecipeWhereInput = {
      ...visibility(query),
      ...(query.category ? { category: query.category } : {}),
      ...(query.cuisine ? { cuisine: query.cuisine } : {}),
      ...(query.q ? { AND: query.q.toLowerCase().split(/\s+/).map(term => ({ searchText: { contains: term } })) } : {}),
    }
    const [rows, total] = await this.prisma.$transaction([
      /*
       * 自己家的排最前。用 `familyId: 'desc'` 表达"非空优先"：MySQL 里 NULL 是最小值，
       * 降序就把它排到最后（导入的菜 familyId 都是 null）。
       *
       * **不按 origin 字母序排**（'user' 恰好大于 'jisu' 只是巧合）：将来加一个新源
       * 名字排在 u 之后，导入的菜就会跑到自己家的前面去——那种错误只在加了源之后才出现，
       * 到时候没人会想到是这里。按"有没有家"排则与来源名字无关。
       */
      this.prisma.recipe.findMany({ where, orderBy: [{ familyId: 'desc' }, { name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.recipe.count({ where }),
    ])
    const viewerFamilyId = query.viewer?.familyId ?? null
    return { items: rows.map((row) => summary(row, viewerFamilyId)), total, page: query.page, pageSize: query.pageSize }
  }

  async filters(): Promise<RecipeFilters> {
    const rows = await this.prisma.recipe.findMany({ select: { category: true, cuisine: true } })
    return { categories: [...new Set(rows.map(row => row.category))].sort(), cuisines: [...new Set(rows.map(row => row.cuisine))].sort() }
  }

  /**
   * 详情。**这里必须做可见性检查**：列表做了、详情没做是经典的越权口子——
   * 别人家的自建菜谱，直接敲 id 照样取得到。
   */
  async findById(id: string, viewer?: { userId: string; familyId: string | null } | null): Promise<Recipe | null> {
    const row = await this.prisma.recipe.findUnique({ where: { id }, include: { createdBy: { select: { nickname: true } } } })
    if (!row) return null
    const viewerFamilyId = viewer?.familyId ?? null
    if (row.familyId !== null && row.familyId !== viewerFamilyId) return null
    return { ...summary(row, viewerFamilyId), aliases: row.aliases as string[], spiciness: row.spiciness,
      ingredients: row.ingredients as unknown as Ingredient[], steps: row.steps as string[], notes: row.notes as string[],
      videoUrl: row.videoUrl, source: row.source as unknown as RecipeSource,
      // 自建的显示"谁传的"；导入的那份没有这一项（null）
      createdBy: row.createdBy?.nickname ?? null }
  }
}
