import { Injectable } from '@nestjs/common'
import { Prisma, Recipe as RecipeRow } from '@prisma/client'
import { publicImageUrl } from '../media/media.storage'
import { canReadRecipe, canWriteRecipe, sourceLabel } from './recipe.rules'
import { Ingredient, Recipe, RecipeFilters, RecipePage, RecipeProvider, RecipeQuery, RecipeSource, RecipeSummary } from './recipe.types'
import { PrismaService } from './prisma.service'

/**
 * 从库里的一行拼摘要。
 *
 * `viewer` 决定 `mine`（能不能改）：判据与写操作**是同一个**
 * （`canWriteRecipe`）。界面画不画"编辑"按钮与接口放不放行必须是同一件事——
 * 两处各判一次必然分叉，一处放行一处拦截。
 */
function summary(row: RecipeRow, viewer: { userId: string; familyId: string | null } | null): RecipeSummary {
  // 已备份到自托管存储的用自托管地址（第三方链接会过期），没备份的才回退源站直链
  return { id: row.id, name: row.name, image: publicImageUrl(row.imageKey, row.image), category: row.category, cuisine: row.cuisine,
    tags: row.tags as string[], calories: row.calories, caloriesEstimated: row.caloriesEstimated,
    origin: row.origin, sourceLabel: sourceLabel(row.origin),
    mine: Boolean(viewer) && canWriteRecipe(row, viewer as { userId: string; familyId: string | null }) }}

/**
 * 可见范围（F1-12）：**全局库 + 自己家的 + 我自己的**。
 *
 * 三种归属各自的可见性由 `canReadRecipe` 定义（那里是唯一判据），这里只是把它翻成
 * SQL 条件。三者的 `familyId` 都是 null，所以**必须靠 `createdById` 区分**：
 * - 全局库：`familyId=null` **且** `createdById=null`（导入器写的，没有主人）；
 * - 个人菜谱：`familyId=null` 且 `createdById=我`（还没建家庭时先记下的，**只给自己看**）；
 * - 家庭菜谱：`familyId=我的家庭`。
 *
 * 漏掉中间那一条会同时踩两个坑：隐私上，一个人的私人笔记变成全站可见（实测撞到过）；
 * 权限上，他自己反而改不了——`familyId=null` 在写那一侧正是"公共菜谱"。
 *
 * `mine=1` 是"只要自己那一份"（「我的菜谱」用）：自家的 + 我自己的都算，
 * 因为两者在界面上都是"我能改的菜"。
 */
function visibility(query: RecipeQuery): Prisma.RecipeWhereInput {
  const viewer = query.viewer
  const familyId = viewer?.familyId ?? null
  const personal: Prisma.RecipeWhereInput = viewer ? { familyId: null, createdById: viewer.userId } : { id: '__none__' }
  const publicLibrary: Prisma.RecipeWhereInput = { familyId: null, createdById: null }
  if (query.mine) {
    // 只看自己那份：没登录时给一个恒假条件（匹配不到东西，而不是报错）
    if (!viewer) return { id: '__none__' }
    return { OR: [personal, ...(familyId ? [{ familyId }] : [])] }
  }
  return { OR: [publicLibrary, personal, ...(familyId ? [{ familyId }] : [])] }
}

@Injectable()
export class BuiltinRecipeProvider implements RecipeProvider {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: RecipeQuery): Promise<RecipePage> {
    /*
     * 三个筛选条件都收进 `and` 数组里，**不直接铺在 where 上**：
     * `visibility()` 自己带一个 `OR`（全局库 + 自己家的 + 我自己的），而标签命中也是 `OR`
     * ——两个 `OR` 同层的话后写的那个会把前面整个覆盖掉，等于**悄悄放开了可见性**。
     * 这种错不会报错，只会让不该看见的菜谱出现在列表里，所以这里从一开始就分开。
     */
    const and: Prisma.RecipeWhereInput[] = []
    if (query.q) and.push({ AND: query.q.toLowerCase().split(/\s+/).map(term => ({ searchText: { contains: term } })) })
    /*
     * 标签：`array_contains` 是 JSON 数组的**元素精确相等**（不是子串），
     * 多个标签之间是 OR＝命中其中一个即可（见 parseRecipeQuery 的 tagList）。
     * `tags` 列可空：库里 16 道自建菜没有标签，array_contains 对它们一律不命中，
     * 这正是"按标签筛"该有的样子。
     */
    if (query.tags && query.tags.length > 0) and.push({ OR: query.tags.map(tag => ({ tags: { array_contains: tag } })) })
    const where: Prisma.RecipeWhereInput = {
      ...visibility(query),
      ...(query.category ? { category: query.category } : {}),
      ...(query.cuisine ? { cuisine: query.cuisine } : {}),
      ...(and.length > 0 ? { AND: and } : {}),
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
    return { items: rows.map((row) => summary(row, query.viewer ?? null)), total, page: query.page, pageSize: query.pageSize }
  }

  async filters(): Promise<RecipeFilters> {
    const rows = await this.prisma.recipe.findMany({ select: { category: true, cuisine: true } })
    return { categories: [...new Set(rows.map(row => row.category))].sort(), cuisines: [...new Set(rows.map(row => row.cuisine))].sort() }
  }

  /**
   * 详情。**这里必须做可见性检查**：列表做了、详情没做是经典的越权口子——
   * 别人家（或别人的私人菜谱）直接敲 id 照样取得到。
   *
   * 判据与列表用的是同一个 `canReadRecipe`：两处各写一遍必然分叉，
   * 而分叉的方向是"列表藏住了、详情漏出去"——最难发现的那一种。
   */
  async findById(id: string, viewer?: { userId: string; familyId: string | null } | null): Promise<Recipe | null> {
    const row = await this.prisma.recipe.findUnique({ where: { id }, include: { createdBy: { select: { nickname: true } } } })
    if (!row) return null
    if (!canReadRecipe(row, viewer ?? null)) return null
    return { ...summary(row, viewer ?? null), aliases: row.aliases as string[], spiciness: row.spiciness,
      ingredients: row.ingredients as unknown as Ingredient[], steps: row.steps as string[], notes: row.notes as string[],
      videoUrl: row.videoUrl, source: row.source as unknown as RecipeSource,
      // 自建的显示"谁传的"；导入的那份没有这一项（null）
      createdBy: row.createdBy?.nickname ?? null }
  }
}
