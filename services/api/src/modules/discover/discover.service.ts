import { Injectable, NotFoundException } from '@nestjs/common'
import { publicImageUrl } from '../media/media.storage'
import type { FamilyRole } from '../family/family.roles'
import { dateKey, visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import {
  countCooked,
  countFavorites,
  parsePicksLimit,
  rankPicks,
  type CookedRow,
  type FavoriteRow,
} from './discover.rules'

/**
 * 家人最爱 / 家人常点（M5 / F5-02）。口径见 D-038。
 *
 * 三件事刻意的：
 * - **两个信号都来自已经发生过的事**（"已做好"的餐次 + 收藏），不额外让用户打分：
 *   家庭应用里没人愿意给菜评星，而"做过几次"本身就是最诚实的一票；
 * - **收藏是私人偏好，聚合前先过共享开关**（F2-07）：共享关着时只算自己的收藏，
 *   否则一个吃货能从"3 人收着"这种数字上看出别人收了什么——与照片张数同一类泄漏
 *   （见 orders.rules 的 photoVisibleTo）；
 * - **只取前十来道的菜谱详情**：榜单只要一屏，没必要把 600 道全查出来再截断。
 */
@Injectable()
export class DiscoverService {
  constructor(private readonly prisma: PrismaService) {}

  async familyPicks(userId: string, rawLimit: unknown) {
    const limit = parsePicksLimit(rawLimit)

    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException('先加入家庭，才能看家人最爱')
    const { familyId } = membership
    const role = membership.role as FamilyRole
    const scope = visibleToMember(membership.family.shared, role)

    /*
     * 收藏：family 口径 = 家里每个人的收藏都算（"几个人收着"）；mine 口径 = 只算自己。
     * 家庭人数上限 10（FAMILY_MEMBER_LIMIT），所以先取成员 id 再 `in` 一次，比连表查询好读。
     */
    const collectorIds =
      scope === 'family'
        ? (
            await this.prisma.familyMember.findMany({ where: { familyId }, select: { userId: true } })
          ).map((member) => member.userId)
        : [userId]
    const favoriteRows: FavoriteRow[] = await this.prisma.favorite.findMany({
      where: { userId: { in: collectorIds } },
      select: { recipeId: true, userId: true },
    })

    /*
     * 做过：只认**已做好**（DONE）的餐——"安排了但没做"不算做过，取消的也不算。
     *
     * 取回的是**条目**而不是聚合数：同一餐里同一道菜可能有多条（两个人各点一份），
     * 按"餐"去重这件事在 `countCooked` 里做（纯函数，单测直接验）。
     */
    const itemRows = await this.prisma.orderItem.findMany({
      where: {
        recipeId: { not: null },
        mealOrder: {
          familyId,
          status: 'DONE',
          ...(scope === 'mine' ? { items: { some: { userId } } } : {}),
        },
      },
      select: { recipeId: true, mealOrderId: true, mealOrder: { select: { mealDate: true } } },
    })
    const cookedRows: CookedRow[] = itemRows.map((item) => ({
      // recipeId 已在上面的 where 里过滤掉 null（自由菜品没有菜谱，不参与榜单）
      recipeId: item.recipeId as string,
      mealOrderId: item.mealOrderId,
      cookedOn: dateKey(item.mealOrder.mealDate),
    }))

    const ranked = rankPicks(countCooked(cookedRows), countFavorites(favoriteRows))
    const top = ranked.slice(0, limit)

    const recipes = await this.prisma.recipe.findMany({
      where: { id: { in: top.map((pick) => pick.recipeId) } },
      select: {
        id: true,
        name: true,
        image: true,
        imageKey: true,
        category: true,
        cuisine: true,
        calories: true,
        caloriesEstimated: true,
      },
    })
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]))

    return {
      scope,
      limit,
      /** 有信号的菜一共多少道（不是返回了多少道）——界面据此说"还有 N 道做过或收过" */
      total: ranked.length,
      items: top.flatMap((pick) => {
        const recipe = byId.get(pick.recipeId)
        // 菜谱在这两次查询之间被删掉时会拿不到详情：宁可少一行，也不给一条没有菜名的空壳
        if (!recipe) return []
        return [
          {
            id: recipe.id,
            name: recipe.name,
            image: publicImageUrl(recipe.imageKey, recipe.image),
            category: recipe.category,
            cuisine: recipe.cuisine,
            calories: recipe.calories,
            caloriesEstimated: recipe.caloriesEstimated,
            cooked: pick.cooked,
            favorites: pick.favorites,
            score: pick.score,
            lastCookedOn: pick.lastCookedOn,
          },
        ]
      }),
    }
  }
}
