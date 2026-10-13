import { Injectable, NotFoundException } from '@nestjs/common'
import type { FamilyRole } from '../family/family.roles'
import { MEAL_LABEL, dateKey, dateOnly, dayWindow, parsePlanDays, visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import {
  aggregateIngredients,
  applyStock,
  type DishIngredients,
  type StockRow,
} from './shopping.rules'

/**
 * 采购清单（M7 / F7-01、F7-02）。口径见 D-039 与 D-059。
 *
 * 它把"接下来 N 天要做的菜"翻成"要买什么"：取那一餐的**最终菜单**，
 * 把每道菜的配料按名字合起来，告诉用户买多少、为哪几道菜买。
 *
 * 五件事刻意的：
 * - **只算"定了的"菜单**（PLANNED / COOKING，不含 PENDING）：还在收集中意味着
 *   "可能还要加菜、也可能取消"，照它去买会白跑一趟。已做好（DONE）的也不用买；
 * - **可见性沿用点单那一套**（共享关掉时吃货只看自己参与的餐）：采购清单是从点单推出来的，
 *   它要是绕过可见性，就等于开了个"看别人点了什么"的后门；
 * - **与库存比对（F7-02）**：冰箱里有的划到"家里有"、算得清的自动扣掉。**算不清的照实说**
 *   （"家里有 半盒，够不够看一眼"，见 `shopping.rules` 的 `compareWithStock`）；
 * - **查不到配料的菜单独说出来**（`missing`）：自由菜品（F3-10）没有配料可聚合，
 *   但它们**不能就这么消失**——否则用户以为"要买的就是这些"，漏掉一整道菜的用料；
 * - **一个假数字都不编**：能算才算，算不了就不算。这与 D-039 拒绝给"3-4颗"求平均是同一条。
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

    /*
     * 冰箱里的东西（F7-02）。**可见性用同一套**：共享关掉时只拿自己放的那几条，
     * 否则"家里有"会把别人放的东西算进他自己的采购单里——那既是泄漏，也会让他少买。
     *
     * 只取名字与数量：比对只需要这两样。
     */
    const stockRows: StockRow[] = await this.prisma.fridgeItem.findMany({
      where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
      select: { name: true, amount: true },
    })

    const items = applyStock(aggregateIngredients(dishes), stockRows)
    /** 还要买的（`missing` 与"家里不够"）；界面拿它算"买到几样"的进度 */
    const toBuy = items.filter((item) => item.needsBuy)
    /** 家里已经有、不用买的（含"量算不清"的那几条：没法说够，就不说够） */
    const covered = items.filter((item) => !item.needsBuy)

    return {
      scope,
      /** 窗口（`YYYY-MM-DD`）：界面要说清"这份清单是按哪几天算的" */
      days: window.length,
      from: window[0].value,
      to: window[window.length - 1].value,
      /** 参与汇总的那几餐（没定菜的那几餐不在这里） */
      meals: mealsUsed,
      /** 全部条目（每条带 `stock` 结论，界面按它分组、标色、写那一行话） */
      items,
      /** 还要买的净数（F7-02：算得清的已经扣掉了）——界面上的"共 N 样"用这个 */
      toBuyCount: toBuy.length,
      /** 家里已有、不用买的样数 */
      coveredCount: covered.length,
      /** 其中"量算不清、够不够自己看"的样数（最需要用户自己判断的那几条） */
      unsureCount: covered.filter((item) => item.stock.verdict === 'unknown').length,
      /**
       * 冰箱里一条都没记：界面要说"记了冰箱才能替你扣掉"。
       *
       * 不说的话，用户看到"不用买 0 样"会以为这个功能没用——而其实是他还没记冰箱。
       * 这是"空状态要说出原因"的一贯做法（与冰箱页的"还是空的"同一条）。
       */
      stockEmpty: stockRows.length === 0,
      /** 有待补的菜（没有配料表）：它们**不在上面的清单里**，界面必须说出来 */
      missing,
      /** 一共几道菜参与（含待补的）：清单为空时界面据此说清原因 */
      dishCount: dishes.length + missing.length,
    }
  }
}
