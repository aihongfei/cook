import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { FamilyRole } from '../family/family.roles'
import { toView, type FridgeItemView } from '../fridge/fridge.rules'
import {
  MEAL_LABEL,
  dateKey,
  dateOnly,
  dayWindow,
  mealKeyOf,
  parseMealKey,
  parsePlanDays,
  visibleToMember,
} from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import {
  AISLE_ORDER,
  aisleOf,
  aisleZone,
  aggregateIngredients,
  applyStock,
  checkFresh,
  isBuyable,
  parseExtraAmount,
  parseExtraName,
  type DishIngredients,
  type ShoppingItemWithStock,
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
    // 家庭与角色只在一处取（`requireMember`）：新增的几个写方法也要它，两处各写一遍必然漂移
    const { familyId, role, shared } = await this.requireMember(userId)
    const scope = visibleToMember(shared, role)

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

    /*
     * 用户自己加的条目（F7-03「增减条目」）**并进同一张清单**：
     * 垃圾袋、洗洁精这些没有菜谱，但买菜路上想起来就得记下来。
     * 它们与菜单推出来的条目在界面上是同一种东西（一样勾、一样能补货进冰箱），
     * 所以在这里合并，而不是让前端画两组。
     */
    const extras = await this.prisma.shoppingExtra.findMany({
      where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
      orderBy: { createdAt: 'asc' },
    })

    /*
     * **滤掉"不是商品"的东西**（水/清水/温水，见 `isBuyable`）。
     * 菜谱里 38 处写"水"、17 处"清水"——没人去超市买温水。滤掉的代价是这一条不在清单上，
     * 那正是对的；留着它用户还得自己划掉。
     *
     * 自加的条目不滤（用户自己写的"水"可能是"桶装水"，那是真要买的）——
     * 判据只对**菜谱推出来的**那部分生效，这是"别替用户改写他写的东西"的一贯做法。
     */
    const fromMenu = applyStock(
      aggregateIngredients(dishes).filter((item) => isBuyable(item.name)),
      stockRows,
    )
    const fromExtras: ShoppingItemWithStock[] = extras.map((row) => ({
      name: row.name,
      amount: row.amount,
      from: [],
      extra: true as const,
      // 删它要用（界面拿它去 DELETE）；菜单推出来的条目没有 id = 不能删
      extraId: row.id,
      stock: { verdict: 'missing' as const, stockName: null, stockAmount: null, remaining: null },
      needsBuy: true,
      stockLabel: null,
    }))

    /*
     * 勾选状态（F7-03）：读的时候顺手**删掉过期行**（`checkFresh`，7 天）。
     * 这周还亮着上周勾的"葱"，用户会以为自己买过了——宁可让他重新勾一次。
     */
    const checkRows = await this.prisma.shoppingCheck.findMany({
      where: { familyId, ...(scope === 'mine' ? { checkedById: userId } : {}) },
    })
    const stale = checkRows.filter((row) => !checkFresh(row.checkedAt))
    if (stale.length > 0) {
      await this.prisma.shoppingCheck.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } })
    }
    const checkedNames = checkRows.filter((row) => checkFresh(row.checkedAt)).map((row) => row.name)

    const items = [...fromMenu, ...fromExtras]
    /** 还要买的（`missing` 与"家里不够"）；界面拿它算"买到几样"的进度 */
    const toBuy = items.filter((item) => item.needsBuy)
    /** 家里已经有、不用买的（含"量算不清"的那几条：没法说够，就不说够） */
    const covered = items.filter((item) => !item.needsBuy)
    /** 已勾掉的（只在"要买的"里算——家里有的那几条本来就没有勾选框） */
    const checked = toBuy.filter((item) => checkedNames.includes(item.name))

    /*
     * 按货架分组（F7-03）：清单原来是一长条按名字排的（`aggregateIngredients` 的排序），
     * 名字排得整齐，但**买菜不是按名字买的**——是按货架一个个区扫过去的。
     * 分组之后"蔬菜水果"那几样挨在一起，走到菜摊一次拿完。
     *
     * 空组不返回（下面的 filter）：否则用户会看到五个空标题。
     */
    const aisles = AISLE_ORDER.map((aisle) => ({
      aisle,
      items: items.filter((item) => aisleOf(item.name) === aisle),
    })).filter((group) => group.items.length > 0)

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
      /** 按货架分好组的条目（F7-03；空组不在里面）——界面的主要渲染源 */
      aisles,
      /** 已经勾掉的条目名（F7-03 持久化：刷新、换设备都还在） */
      checkedNames: checked.map((item) => item.name),
      /** 已经勾掉几样（"买到 N/M" 的 N） */
      checkedCount: checked.length,
      /** 有待补的菜（没有配料表）：它们**不在上面的清单里**，界面必须说出来 */
      missing,
      /** 一共几道菜参与（含待补的）：清单为空时界面据此说清原因 */
      dishCount: dishes.length + missing.length,
    }
  }

  /* ---------------------------------------------------------------- *
   * F7-06 「这一餐要买什么」预览（定这一餐之前看的那一眼）
   * ---------------------------------------------------------------- */

  /**
   * 单看**一餐**：它要买哪些、家里已经有哪几样。用户 2026-10-14 报的第二件事。
   *
   * 与 `list` 的差别只有一处、但很关键：**不按状态过滤**。
   * `list` 只算 `PLANNED`/`COOKING`（那是"定了才去买"的规矩，D-059），
   * 而这一支是给**还没定的那一餐**看的——用户正在「定下这一餐」的汇总页上，
   * 正好要决定要不要定。如果它也按状态过滤，那时候看到永远是"没有要买的"，
   * 这个提示就等于不存在。
   *
   * 聚合与比对**复用 `list` 那一套规则函数**（`aggregateIngredients` + `isBuyable` + `applyStock`），
   * 不另写一份：另算一份必然分叉——汇总页说"缺 3 样"、清单页列 5 样，
   * 用户就不知道信哪个（与 `decide` 不自己重算推荐同一条道理）。
   */
  async previewMeal(userId: string, rawMealKey: unknown) {
    const { familyId, role, shared } = await this.requireMember(userId)
    const scope = visibleToMember(shared, role)

    const mealKey = typeof rawMealKey === 'string' ? rawMealKey.trim() : ''
    if (!mealKey) throw new BadRequestException('要告诉我哪一餐（mealKey）')
    // 格式不对时 `parseMealKey` 自己抛中文话术，这里不必再包一层
    const { mealDate, meal } = parseMealKey(mealKey)

    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
      include: {
        items: { select: { recipeId: true, recipeName: true, userId: true } },
      },
    })
    if (!row) throw new NotFoundException('这一餐还没有人点菜')

    // 可见性与 list 同一套闸门（共享关掉时只看自己参与的餐）
    if (scope === 'mine' && !row.items.some((item) => item.userId === userId)) {
      throw new NotFoundException('这一餐里没有你点的菜')
    }

    const recipeIds = [
      ...new Set(row.items.map((item) => item.recipeId).filter((id): id is string => Boolean(id))),
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
    for (const item of row.items) {
      const ingredients = item.recipeId ? ingredientsById.get(item.recipeId) : undefined
      if (!ingredients) {
        if (!missing.includes(item.recipeName)) missing.push(item.recipeName)
        continue
      }
      dishes.push({ dish: nameById.get(item.recipeId as string) ?? item.recipeName, ingredients })
    }

    const stockRows: StockRow[] = await this.prisma.fridgeItem.findMany({
      where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
      select: { name: true, amount: true },
    })

    const items = applyStock(
      aggregateIngredients(dishes).filter((item) => isBuyable(item.name)),
      stockRows,
    )
    const toBuy = items.filter((item) => item.needsBuy)
    const covered = items.filter((item) => !item.needsBuy)

    return {
      mealKey: mealKeyOf(mealDate, meal),
      date: dateKey(mealDate),
      meal,
      mealLabel: MEAL_LABEL[meal],
      /** 这一餐此刻的状态：界面据此说"定了才有清单"还是"清单上已经有了" */
      status: row.status,
      /** 几道菜（`missing` 那几道没有配料表，算不进条目里，但要说出来） */
      dishCount: dishes.length,
      missing,
      /** 要买的（`missing` 与"家里不够"）；界面主要看它 */
      toBuy: toBuy.map((item) => ({ name: item.name, amount: item.amount, from: item.from, stockLabel: item.stockLabel })),
      /** 家里已经有、不用买的 */
      covered: covered.map((item) => ({ name: item.name, amount: item.amount, stockLabel: item.stockLabel })),
      toBuyCount: toBuy.length,
      coveredCount: covered.length,
      /** 其中"量算不清、够不够自己看"的样数 */
      unsureCount: covered.filter((item) => item.stock.verdict === 'unknown').length,
      /** 冰箱里一条都没记：界面要说"记了冰箱才能替你扣掉" */
      stockEmpty: stockRows.length === 0,
    }
  }

  /* ---------------------------------------------------------------- *
   * F7-03 清单编辑：勾选持久化 / 自加条目 / 分组（分组在 list 里）
   * ---------------------------------------------------------------- */

  /**
   * 勾选 or 取消勾选一样东西（F7-03 持久化）。
   *
   * **按名字存**（不是按清单条目 id）：清单每次现算、没有稳定 id，而"这袋盐我买了"
   * 与"哪份菜单要多少盐"无关。好处是自加条目与菜单条目**共用同一套勾选**。
   *
   * 取消勾选用 `deleteMany`（幂等）：重复取消不是错误，用户点了两下而已。
   */
  async check(userId: string, rawName: unknown, rawChecked: unknown) {
    const { familyId } = await this.requireMember(userId)
    const name = parseExtraName(rawName)
    const checked = rawChecked === undefined ? true : rawChecked === true || rawChecked === 'true'
    if (checked) {
      await this.prisma.shoppingCheck.upsert({
        where: { familyId_name: { familyId, name } },
        create: { familyId, name, checkedById: userId },
        // 重新勾 = 刷新时间戳，让它从现在起算 7 天（而不是沿用第一次勾的时间）
        update: { checkedById: userId, checkedAt: new Date() },
      })
    } else {
      await this.prisma.shoppingCheck.deleteMany({ where: { familyId, name } })
    }
    return this.list(userId)
  }

  /** 自己往清单上加一条（F7-03「增减条目」）：垃圾袋、洗洁精这些没有菜谱的东西 */
  async addExtra(userId: string, body: { name?: unknown; amount?: unknown }) {
    const { familyId } = await this.requireMember(userId)
    const name = parseExtraName(body?.name)
    const amount = parseExtraAmount(body?.amount)
    const existing = await this.prisma.shoppingExtra.findUnique({
      where: { familyId_name: { familyId, name } },
    })
    // 同名只留一条（与冰箱同名同区只留一条同一规矩：两条同名会让人不知道怎么算）
    if (existing) throw new BadRequestException(`清单上已经有「${name}」了`)

    /*
     * 还要与**菜单推出来的条目**对一次名：它们每次现算、没有稳定 id，
     * 加一条同名的上去就会出现两行一模一样的「鸡蛋」——两行共用同一个勾选框
     * （勾选是按名字存的），勾一下两行一起划掉、"买到 N/M"也一下跳 2。
     * 这种同名只可能是重复：菜单要的东西本来就在清单上，用户不需要再加一条。
     */
    const board = await this.list(userId)
    if (board.items.some((item) => item.name === name)) {
      throw new BadRequestException(`清单上已经有「${name}」了（菜单里那道菜要用的，直接勾它就行）`)
    }

    await this.prisma.shoppingExtra.create({ data: { familyId, addedById: userId, name, amount } })
    return this.list(userId)
  }

  /** 删掉自己加的那一条（**只能删自加的**：菜单推出来的那条删了下次请求还会回来） */
  async removeExtra(userId: string, extraId: string) {
    const { familyId } = await this.requireMember(userId)
    const row = await this.prisma.shoppingExtra.findFirst({ where: { id: extraId, familyId } })
    if (!row) throw new NotFoundException('这条已经不在清单上了')
    await this.prisma.shoppingExtra.delete({ where: { id: row.id } })
    // 连带清掉它的勾（否则这个勾会一直留着，7 天后才自己过期）
    await this.prisma.shoppingCheck.deleteMany({ where: { familyId, name: row.name } })
    return this.list(userId)
  }

  /**
   * 一键补货（F7-05）：把**勾掉的**那几样写进冰箱。
   *
   * 这是 F7-02（"家里有的不用买"）的反动作，所以**必须复用同一套匹配规则**：
   * 补货时要按 `pantry.rules` 的写法归一，才与"清单上说家里有"的口径一致——
   * 不然会出现"清单说家里没有这袋盐，补货补进去两条盐"这种自相矛盾。
   *
   * 三件事刻意的：
   *
   * - **只补勾掉的**（`names` 由前端传勾选的那几样，服务端再与清单核一遍）：
   *   用户划掉的才表示"我真的买到了"，没勾的一样都没买；
   * - **同名同区已经有就不覆盖、只报出来**：与手动录入同一条（`fridge.service.add`
   *   撞了会 409 而不是悄悄叠加）——悄悄叠加会让"我填的数量"变成"两次之和"，
   *   而用户没法知道库里现在是几。这里选择**跳过并明说**，让用户自己去改那一条；
   * - **存放区按货架推**（`aisleZone`）：批量动作不能让用户每样选一次，
   *   否则"一键"就变回"填六张表单"。推错了能改（补完去冰箱页点那一样就行）。
   */
  async restock(userId: string, rawNames: unknown) {
    const { familyId } = await this.requireMember(userId)
    const wanted = Array.isArray(rawNames)
      ? [...new Set(rawNames.filter((n): n is string => typeof n === 'string').map((n) => n.trim()).filter(Boolean))]
      : []
    if (wanted.length === 0) throw new BadRequestException('先勾掉买到的几样，再一键补货')

    const now = new Date()
    const created: FridgeItemView[] = []
    const skipped: { name: string; why: string }[] = []

    for (const name of wanted) {
      const aisle = aisleOf(name)
      const zone = aisleZone(aisle)
      const existing = await this.prisma.fridgeItem.findUnique({
        where: { familyId_zone_name: { familyId, zone, name } },
      })
      if (existing) {
        skipped.push({ name, why: `${zone}里已经有一条了` })
        continue
      }
      const row = await this.prisma.fridgeItem.create({
        data: {
          familyId,
          addedById: userId,
          name,
          // 数量不写：清单上的"2个"是**菜谱要多少**，不是"买回来了多少"——
          // 把前者当后者记进冰箱，下次比对就会得出"家里够做两道菜"的假结论。
          amount: null,
          zone,
        },
        include: { addedBy: { select: { nickname: true } } },
      })
      created.push(toView({ ...row, addedByName: row.addedBy.nickname }, now))
    }

    /*
     * 补进去的那几样**顺手取消勾选**：它们已经进冰箱了，
     * 清单上还亮着勾会让人以为"还没放进去"。跳过的那几条**保留勾**——
     * 用户的动作（买到了）没有错，只是库里已经有了，他要自己去合并。
     */
    if (created.length > 0) {
      await this.prisma.shoppingCheck.deleteMany({
        where: { familyId, name: { in: created.map((item) => item.name) } },
      })
    }

    return { added: created, skipped, board: await this.list(userId) }
  }

  /** 取家庭 + 角色（与 list 里那一段同一判据；抽出来给上面几个写方法复用） */
  private async requireMember(userId: string) {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException('先加入家庭，才能和家里一起列采购清单')
    return {
      familyId: membership.familyId,
      role: membership.role as FamilyRole,
      shared: membership.family.shared,
    }
  }

}
