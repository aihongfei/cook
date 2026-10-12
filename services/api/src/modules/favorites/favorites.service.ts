import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { publicImageUrl } from '../media/media.storage'
import { PrismaService } from '../recipes/prisma.service'
import { FAVORITES_MAX, canFavorite, parseRecipeId } from './favorites.rules'

/**
 * 收藏（M1 / F1-09）。口径见 D-037。
 *
 * 三件事刻意的：
 * - **按人存，不按家庭**：收藏是"我爱吃/我想做"的个人偏好，与点单（家庭协作）、
 *   常用组合（一家人的常用搭配）不是一回事；家庭共享开关（F2-07）管的是"家人的点单与照片
 *   互相可见"，与私人收藏无关——所以这里**不引入家庭概念**，只要有账号就能用。
 * - **收藏/取消是同一个接口的两次调用**（`POST` 切换）：界面上它就是一颗心的开与关，
 *   分两个接口（收藏/取消）会让前端必须先知道当前状态、再多一条分支——而它手里本来就有。
 * - **到上限明确拒绝**，不顶掉最早的（理由见 favorites.rules 的 FAVORITES_MAX）。
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 收藏列表（最近收藏的在前）。
   *
   * 菜谱被删时收藏记录会跟着删（外键 Cascade），所以这里查出来的每一道菜都还在——
   * `recipe` 关联不会是 null，不用做"菜没了但收藏还在"的空壳处理。
   */
  async list(userId: string) {
    const rows = await this.prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { recipe: true },
    })
    return {
      items: rows.map(row => ({
        id: row.recipe.id,
        name: row.recipe.name,
        image: publicImageUrl(row.recipe.imageKey, row.recipe.image),
        category: row.recipe.category,
        cuisine: row.recipe.cuisine,
        tags: row.recipe.tags as string[],
        calories: row.recipe.calories,
        caloriesEstimated: row.recipe.caloriesEstimated,
        favoritedAt: row.createdAt.toISOString(),
      })),
      total: rows.length,
      /** 上限也下发：前端据此说清"收藏满了"，而不是让用户点到失败才知道 */
      limit: FAVORITES_MAX,
    }
  }

  /**
   * 切换收藏：已收藏 → 取消；未收藏 → 收藏。返回切换后的状态与最新条数。
   *
   * 一句话说完这个接口的语义：**它回答的是"现在是不是收藏了"**，
   * 前端拿到 `favorited` 直接改那颗心，不用自己推。
   */
  async toggle(userId: string, rawRecipeId: unknown): Promise<{ favorited: boolean; total: number }> {
    const recipeId = parseRecipeId(rawRecipeId)

    // 菜谱不在库里就别写收藏记录：外键会拦，但那时报的是一句数据库错误
    const recipe = await this.prisma.recipe.findUnique({ where: { id: recipeId }, select: { id: true } })
    if (!recipe) throw new NotFoundException('这道菜不在菜谱库里')

    const existing = await this.prisma.favorite.findUnique({
      where: { userId_recipeId: { userId, recipeId } },
    })
    if (existing) {
      await this.prisma.favorite.delete({ where: { id: existing.id } })
      const total = await this.prisma.favorite.count({ where: { userId } })
      return { favorited: false, total }
    }

    const total = await this.prisma.favorite.count({ where: { userId } })
    if (!canFavorite(total, false)) {
      throw new ConflictException(`最多收藏 ${FAVORITES_MAX} 道，先取消一道再收新的`)
    }

    /*
     * 并发下两个人同一时刻点同一道（同一个人的两个页面）：唯一约束会让其中一个失败。
     * 这时正确的语义是"已经收藏了"，而不是报错——用户看到的是自己点了两下。
     */
    try {
      await this.prisma.favorite.create({ data: { userId, recipeId } })
    } catch (error) {
      // 与 orders 的 ensureMealOrder 同一套判定（用 Prisma 的错误类型，不靠字符串包含）
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    }
    return { favorited: true, total: total + 1 }
  }

  /** 一批菜各自的收藏状态（列表页用：一次问清一屏，不要每张卡各发一个请求） */
  async statusOf(userId: string, rawIds: unknown): Promise<Record<string, boolean>> {
    if (!Array.isArray(rawIds)) return {}
    const ids = rawIds
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim())
      .slice(0, 100)
    if (ids.length === 0) return {}
    const rows = await this.prisma.favorite.findMany({
      where: { userId, recipeId: { in: ids } },
      select: { recipeId: true },
    })
    const favorited = new Set(rows.map(row => row.recipeId))
    // 只回"收藏了的"：没回的就是没收藏，界面按 falsy 处理（省一半体积）
    return Object.fromEntries([...favorited].map(id => [id, true]))
  }
}
