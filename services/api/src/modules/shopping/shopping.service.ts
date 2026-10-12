import { Injectable, NotFoundException } from '@nestjs/common'
import type { FamilyRole } from '../family/family.roles'
import { MEAL_LABEL, dateKey, dateOnly, dayWindow, parsePlanDays, visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import { aggregateIngredients, type DishIngredients } from './shopping.rules'

/**
 * 采购清单（M7 / F7-01）。口径见 D-039。
 *
 * 它把"接下来 N 天要做的菜"翻成"要买什么"：取那一餐的**最终菜单**，
 * 把每道菜的配料按名字合起来，告诉用户买多少、为哪几道菜买。
 *
 * 四件事刻意的：
 * - **只算"定了的"菜单**（PLANNED / COOKING，不含 PENDING）：还在收集中意味着
 *   "可能还要加菜、也可能取消"，照它去买会白跑一趟。已做好（DONE）的也不用买；
 * - **可见性沿用点单那一套**（共享关掉时吃货只看自己参与的餐）：采购清单是从点单推出来的，
 *   它要是绕过可见性，就等于开了个"看别人点了什么"的后门；
 * - **不查库存**（F7-02 才做）：不会说"这个你家里还有"——冰箱（M6）还没建，
 *   装不知道比编一句"库存充足"更诚实；
 * - **查不到配料的菜单独说出来**（`missing`）：自由菜品（F3-10）没有配料可聚合，
 *   但它们**不能就这么消失**——否则用户以为"要买的就是这些"，漏掉一整道菜的用料。
 */
@Injectable()
export class ShoppingService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, rawDays?: unknown) {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException('先加入家庭，才能和家里一起列采购清单')
    const { familyId } = membership
    const role = membership.role as FamilyRole
    const scope = visibleToMember(membership.family.shared, role)

    const window = dayWindow(parsePlanDays(rawDays))
    const first = dateOnly(window[0].value)
    const last = dateOnly(window[window.length - 1].value)

    const meals = await this.prisma.mealOrder.findMany({
      where: {
        familyId,
        mealDate: { gte: first, lte: last },
        status: { in: ['PLANNED', 'COOKING'] },
        // 共享关掉时吃货只看自己参与的餐（与点单/历史/家人最爱同一套闸门）
        ...(scope === 'mine' ? { items: { some: { userId } } } : {}),
      },
      include: { items: { select: { recipeId: true, recipeName: true } } },
      orderBy: [{ mealDate: 'asc' }, { meal: 'asc' }],
    })

    const recipeIds = [
      ...new Set(
        meals
          .flatMap((meal) => meal.items.map((item) => item.recipeId))
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    const recipes = await this.prisma.recipe.findMany({
      where: { id: { in: recipeIds } },
      select: { id: true, name: true, ingredients: true },
    })
    const ingredientsById = new Map(
      recipes.map((recipe) => [recipe.id, recipe.ingredients as { name: string; amount: string }[]]),
    )
    const nameById = new Map(recipes.map((recipe) => [recipe.id, recipe.name]))

    const dishes: DishIngredients[] = []
    const missing: string[] = []
    const mealsUsed: { mealKey: string; date: string; mealLabel: string; dishCount: number }[] = []
    for (const meal of meals) {
      if (meal.items.length === 0) continue
      for (const item of meal.items) {
        // 自由菜品、或菜谱在这两次查询之间被删：都没有配料表可算，交给人自己补
        const ingredients = item.recipeId ? ingredientsById.get(item.recipeId) : undefined
        if (!ingredients) {
          const name = item.recipeName
          if (!missing.includes(name)) missing.push(name)
          continue
        }
        dishes.push({ dish: nameById.get(item.recipeId as string) ?? item.recipeName, ingredients })
      }
      mealsUsed.push({
        mealKey: `${dateKey(meal.mealDate)}-${meal.meal}`,
        date: dateKey(meal.mealDate),
        mealLabel: MEAL_LABEL[meal.meal],
        dishCount: meal.items.length,
      })
    }

    return {
      scope,
      /** 窗口（`YYYY-MM-DD`）：界面要说清"这份清单是按哪几天算的" */
      days: window.length,
      from: window[0].value,
      to: window[window.length - 1].value,
      /** 参与汇总的那几餐（没定菜的那几餐不在这里） */
      meals: mealsUsed,
      items: aggregateIngredients(dishes),
      /** 有待补的菜（没有配料表）：它们**不在上面的清单里**，界面必须说出来 */
      missing,
      /** 一共几道菜参与（含待补的）：清单为空时界面据此说清原因 */
      dishCount: dishes.length + missing.length,
    }
  }
}
