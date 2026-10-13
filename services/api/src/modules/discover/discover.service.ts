import { Injectable, NotFoundException } from '@nestjs/common'
import { publicImageUrl } from '../media/media.storage'
import type { FamilyRole } from '../family/family.roles'
import { dateKey, visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import { canWriteRecipe, sourceLabel } from '../recipes/recipe.rules'
import { expiryState } from '../fridge/fridge.rules'
import { matchDish } from '../fridge/pantry.rules'
import { judgeDish } from '../taste/taste.rules'
import { TasteService } from '../taste/taste.service'
import {
  countCooked,
  countFavorites,
  parsePicksLimit,
  rankPicks,
  type CookedRow,
  type FavoriteRow,
} from './discover.rules'
import {
  decideReason,
  excludeSeen,
  parseExclude,
  pickOne,
  preferFresh,
  rankDecide,
  RECENT_DAYS,
  type DecideCandidate,
} from './decide.rules'
import {
  fillWithExtras,
  parseRecommendCount,
  pickRecommendations,
  scoreCandidates,
  type RecommendScore,
} from './recommend.rules'

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly taste: TasteService,
  ) {}

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
     * 做过：只认**已做好**（DONE）的餐——"安排了但没做"不算做过，取消的也不算。
     *
     * 两份查询都在下面的 `favoriteRows` / `cookedRows` 里，与「帮我决定」（F5-05）
     * **共用同一段**：这一页说"做过 3 次"、那一页说"你们家做过 3 次"，两个数字必须同源，
     * 否则同一道菜在两张卡上会有两个次数（两边各写一遍必然漂移，见 D-059 四）。
     */
    const onlyUserId = scope === 'mine' ? userId : null
    const [favoriteRows, cookedRowList] = await Promise.all([
      this.favoriteRows(familyId, onlyUserId),
      this.cookedRows(familyId, onlyUserId),
    ])

    const ranked = rankPicks(countCooked(cookedRowList), countFavorites(favoriteRows))
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

  /**
   * 帮我决定（M5 / F5-05）：**只给一道**，而且是你家此刻最该做的那道。
   *
   * 与「摇一道」的区别不是"随机不随机"，是**知不知道这个家**：这一条要把冰箱（M6）、
   * 口味档案（M8）、家人的做过/收藏（F5-02）一起看进来，再一个都不让用户挑。
   * 档位与那句话的规则全在 `decide.rules`（纯函数、单测直接验）。
   *
   * 五件事刻意的：
   *
   * - **只返回一道**：返回三条就又变成"让用户挑"了，而这条出口的整个卖点就是不挑；
   * - **每次不一样**：在定序后的前几名里随机（`PICK_WINDOW`）。永远给第一名的话，
   *   用户连点两次看到同一道菜，只会认为按钮坏了（「换一道」用 `exclude` 排除已看过的）；
   * - **口味过滤在这里也生效**（F5-03 同一个 `judgeDish` 判据）：给不吃辣的人推荐辣菜，
   *   比不给推荐更糟——那是在告诉他"你们家爱吃这个"；
   * - **拿不出菜时明说原因**，不给一道编的：库是空的 / 冰箱还没记东西 / 口味档案排掉了全部，
   *   三种情况的去路完全不同（去加菜、去记冰箱、去看档案），说错了他就白折腾一趟；
   * - **不调 AI**：纯规则，毫秒级。这条出口的意义是"立刻给我一个答案"，
   *   让用户等十几秒（那是「AI 帮你想」）就违背了它的用途。
   */
  async decide(userId: string, rawExclude?: unknown) {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException('先加入家庭，才能让家里的事有个主意')
    const { familyId } = membership
    const role = membership.role as FamilyRole
    const scope = visibleToMember(membership.family.shared, role)
    const exclude = parseExclude(rawExclude)

    /*
     * 三样输入并行取：冰箱、做过/收藏、菜谱全表。
     *
     * 菜谱**全表扫**（612 道）与 `cookable` 同一个理由：一次查询约 190KB，
     * 比一次 AI 调用的千分之一还小；真到几万道再谈倒排索引。
     */
    const now = new Date()
    const [fridgeRows, itemRows, favoriteRows, recipes] = await Promise.all([
      this.prisma.fridgeItem.findMany({
        where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
        select: { name: true, expiresOn: true },
      }),
      this.cookedRows(familyId, scope === 'mine' ? userId : null),
      this.favoriteRows(familyId, scope === 'mine' ? userId : null),
      this.prisma.recipe.findMany({
        select: { id: true, name: true, image: true, imageKey: true, category: true, cuisine: true, calories: true, caloriesEstimated: true, spiciness: true, ingredients: true },
      }),
    ])

    if (recipes.length === 0) {
      // 空库是正常状态，不是错误：说清"还没菜可挑"，别给一道编的
      return { scope, reason: '菜谱小书里还没有菜，先去加几道', recipe: null, fridgeEmpty: fridgeRows.length === 0 }
    }

    /*
     * 冰箱里"该先吃"的那几样（F6-05 同一个判据）：它们既是排序的第一权重，
     * 也会进那句话（"豆腐也该先吃了"）——这是这条出口最具体、最有用的理由。
     */
    const soonNames = new Set(
      fridgeRows
        .filter((row) => row.expiresOn !== null && expiryState(row.expiresOn, now) !== null)
        .map((row) => row.name),
    )
    const pantry = fridgeRows.map((row) => row.name)

    const cooked = countCooked(itemRows)
    const favorites = countFavorites(favoriteRows)
    const profiles = await this.taste.activeProfiles(familyId)

    const candidates: DecideCandidate[] = []
    for (const recipe of recipes) {
      const ingredients = readIngredientNames(recipe.ingredients)
      // 口味优先于一切：有人过敏的菜根本不该成为"这个家的主意"（F5-03 同一个判据）
      if (
        profiles.length > 0 &&
        judgeDish({ name: recipe.name, spiciness: recipe.spiciness, ingredients }, profiles).verdict === 'block'
      ) {
        continue
      }
      const match = matchDish(ingredients, pantry)
      /*
       * 没匹配上（`null`：配料表全是调料，或压根没有配料表）**不是排除**，是"这道菜算不出
       * 用得上什么"——它仍可能是一家人常做的菜。所以给它一份空的匹配结果，让它走
       * `favorite` / `any` 档，而不是从候选里消失（`cookable` 那边相反：那边问的是
       * "我这些东西能做什么"，匹配不上就不该出现）。
       */
      const have = match?.have ?? []
      const missing = match?.missing ?? []
      candidates.push({
        recipeId: recipe.id,
        name: recipe.name,
        have,
        missing,
        soon: have.filter((name) => soonNames.has(name)),
        cooked: cooked.get(recipe.id)?.cooked ?? 0,
        favorites: favorites.get(recipe.id) ?? 0,
        lastCookedOn: cooked.get(recipe.id)?.lastCookedOn ?? null,
      })
    }

    const recentKeys = recentDayKeys(RECENT_DAYS, now)
    /*
     * 顺序：排序 → 把最近做过的往后放 → 排掉这一轮看过的 → 在前几名里抽一条。
     *
     * 「最近做过」与「换一道」两步都只在**还有别的可选**时生效（见 decide.rules），
     * 所以库里菜少或全家就吃那几道时不会回一句"没有"——那种答案对用户毫无用处。
     */
    const ranked = preferFresh(rankDecide(candidates), recentKeys)
    const left = excludeSeen(ranked, exclude)
    const picked = pickOne(left, Math.random())

    return {
      scope,
      /** 一句话说清为什么是这道（后端拼，前端只照搬）——与采购清单那句同一条规矩 */
      reason: picked ? decideReason(picked) : null,
      fridgeEmpty: fridgeRows.length === 0,
      /** 这一轮还能不能继续换（前端据此决定「换一道」是否可点） */
      canSwap: left.length > 1,
      recipe: picked
        ? (() => {
            const source = recipes.find((recipe) => recipe.id === picked.recipeId)
            if (!source) return null
            return {
              id: source.id,
              name: source.name,
              image: publicImageUrl(source.imageKey, source.image),
              category: source.category,
              cuisine: source.cuisine,
              calories: source.calories,
              caloriesEstimated: source.caloriesEstimated,
              /** 用上了冰箱里的哪几样（按用户自己的说法回显） */
              have: picked.have,
              /** 还差哪几样：**列名字**——用户要拿它决定顺不顺路买 */
              missing: picked.missing,
              cooked: picked.cooked,
              favorites: picked.favorites,
            }
          })()
        : null,
    }
  }

  /**
   * 首页「菜谱推荐」（用户 2026-10-14 报的第三件事）。口径见 D-071。
   *
   * 与 `decide` 的分工：那个是"**就现在这一餐**给我一道"，要冰箱、要临期、要挑到一道；
   * 这个是"**这一屏放几道**"，要的是"像他家会吃的、但每次不太一样"。
   *
   * 为什么不直接在 `/recipes` 上加个 `random=1`：那一支是**公共菜谱库的读接口**，
   * 匿名也能翻（应用门面，见 recipes.controller 的注释）。个性化要家庭关系、要共享开关、
   * 要口味档案——这些是"这家人"的东西，塞进公共读接口会让它一半公开一半私人
   * （同一个 URL 带不带 token 返回两套语义，缓存与权限都说不清）。
   * 所以挂在 `discover` 下，与「家人最爱」「帮我决定」同一处。
   */
  async recommend(userId: string, rawCount?: unknown) {
    const count = parseRecommendCount(rawCount)

    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException('先加入家庭，才能给你挑你家的菜')
    const { familyId } = membership
    const role = membership.role as FamilyRole
    const scope = visibleToMember(membership.family.shared, role)

    /*
     * 五样输入并行取：冰箱、做过、收藏、口味档案、菜谱全表。
     * 与 `decide` 同一套信号——**不另定一份权重**（那里是 `COOKED_WEIGHT`/`FAVORITE_WEIGHT`）。
     */
    const now = new Date()
    const [fridgeRows, itemRows, favoriteRows, recipes, profiles] = await Promise.all([
      this.prisma.fridgeItem.findMany({
        where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
        select: { name: true, expiresOn: true },
      }),
      this.cookedRows(familyId, scope === 'mine' ? userId : null),
      this.favoriteRows(familyId, scope === 'mine' ? userId : null),
      this.prisma.recipe.findMany({
        select: {
          id: true, name: true, image: true, imageKey: true, category: true, cuisine: true,
          calories: true, caloriesEstimated: true, spiciness: true, ingredients: true,
          // 下面四个是**卡片直接要的**（与 `/recipes` 的 `RecipeSummary` 同形，见下）
          tags: true, origin: true, familyId: true, createdById: true,
        },
      }),
      this.taste.activeProfiles(familyId),
    ])

    if (recipes.length === 0) {
      return { scope, reason: '菜谱小书里还没有菜，先去加几道', items: [], total: 0, fridgeEmpty: fridgeRows.length === 0 }
    }

    const soonNames = new Set(
      fridgeRows
        .filter((row) => row.expiresOn !== null && expiryState(row.expiresOn, now) !== null)
        .map((row) => row.name),
    )
    const pantry = fridgeRows.map((row) => row.name)
    const cooked = countCooked(itemRows)
    const favorites = countFavorites(favoriteRows)

    const scored: RecommendScore[] = scoreCandidates(
      recipes
        .filter((recipe) => {
          // 口味优先于一切：过敏的菜不该出现在首页（F5-03 同一个判据）
          if (profiles.length === 0) return true
          const ingredients = readIngredientNames(recipe.ingredients)
          return (
            judgeDish({ name: recipe.name, spiciness: recipe.spiciness, ingredients }, profiles).verdict !== 'block'
          )
        })
        .map((recipe) => {
          const ingredients = readIngredientNames(recipe.ingredients)
          const match = matchDish(ingredients, pantry)
          const soon = (match?.have ?? []).filter((name) => soonNames.has(name))
          /*
           * `ready` 只给"冰箱里正好有临期的"加分，**满分也就 1**——
           * 它比一次收藏（`FAVORITE_WEIGHT` = 1）一样重，比一次做过（2）轻。
           * 这个位置是刻意的：临期是"今天就能做"的强信号，但不该盖过"他家常做这道"。
           */
          return {
            id: recipe.id,
            cooked: cooked.get(recipe.id)?.cooked ?? 0,
            favorites: favorites.get(recipe.id) ?? 0,
            lastCookedOn: cooked.get(recipe.id)?.lastCookedOn ?? null,
            ready: soon.length > 0 ? 1 : 0,
          }
        }),
    )

    /*
     * 顺序与 `decide` 一致：**先把最近做过的往后放，再在分数靠前的那一池里随机**。
     *
     * 两步都只在"还有别的可选"时改变结果（`fillWithExtras` 兜底），
     * 所以小家庭（就爱吃那几道）不会因此得到一屏陌生菜。
     */
    const recentKeys = recentDayKeys(RECENT_DAYS, now)
    const fresh = preferFresh(scored, recentKeys)
    const filled = fillWithExtras(pickRecommendations(fresh, count), fresh, count)

    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]))
    const items = filled.flatMap((row) => {
      const source = byId.get(row.id)
      if (!source) return []
      /*
       * 字段与 `/recipes` 的 `RecipeSummary` **同形**（外加 `cooked`/`favorites`）：
       * 首页用的还是同一张 `DishCard`，卡片要 `origin`/`sourceLabel` 画来源角标、
       * 要 `mine` 决定画不画编辑键。少一个字段卡片就画不出来，而"再写一张推荐专用卡"
       * 会让两处的样式慢慢分叉——复用同一张卡是这一条的目的。
       */
      return [{
        id: source.id,
        name: source.name,
        image: publicImageUrl(source.imageKey, source.image),
        category: source.category,
        cuisine: source.cuisine,
        tags: source.tags as string[],
        calories: source.calories,
        caloriesEstimated: source.caloriesEstimated,
        origin: source.origin,
        sourceLabel: sourceLabel(source.origin),
        mine: canWriteRecipe(source, { userId, familyId }),
        /** 做过几次（首页要能说清"凭什么推这几道"，否则与随机没区别） */
        cooked: row.cooked,
        favorites: row.favorites,
      }]
    })

    return {
      scope,
      items,
      /** 参与挑选的菜一共几道（空状态时说清"库里有 600 道，只是没挑出来"） */
      total: recipes.length,
      /** 冰箱里一条都没记：界面要说"记了冰箱，推荐会跟着变" */
      fridgeEmpty: fridgeRows.length === 0,
    }
  }

  /** 「做过」的行（F5-02 家人最爱与 F5-05 帮我决定共用：只认 DONE、按餐去重） */
  private async cookedRows(familyId: string, onlyUserId: string | null): Promise<CookedRow[]> {
    const rows = await this.prisma.orderItem.findMany({
      where: {
        recipeId: { not: null },
        mealOrder: { familyId, status: 'DONE', ...(onlyUserId ? { items: { some: { userId: onlyUserId } } } : {}) },
      },
      select: { recipeId: true, mealOrderId: true, mealOrder: { select: { mealDate: true } } },
    })
    return rows.map((row) => ({
      // recipeId 已在上面的 where 里过滤掉 null（自由菜品没有菜谱，不参与榜单）
      recipeId: row.recipeId as string,
      mealOrderId: row.mealOrderId,
      // 取回的是**条目**而不是聚合数：同一餐里同一道菜可能有多条（两个人各点一份），
      // 按"餐"去重这件事在 `countCooked` 里做（纯函数，单测直接验）
      cookedOn: dateKey(row.mealOrder.mealDate),
    }))
  }

  /** 「收着」的行（同上：family 口径 = 全家，mine 口径 = 只算自己） */
  private async favoriteRows(familyId: string, onlyUserId: string | null): Promise<FavoriteRow[]> {
    // 家庭人数上限 10（FAMILY_MEMBER_LIMIT），所以先取成员 id 再 `in` 一次，比连表查询好读
    const collectorIds = onlyUserId
      ? [onlyUserId]
      : (
          await this.prisma.familyMember.findMany({ where: { familyId }, select: { userId: true } })
        ).map((member) => member.userId)
    return this.prisma.favorite.findMany({
      where: { userId: { in: collectorIds } },
      select: { recipeId: true, userId: true },
    })
  }
}

/** 最近 `days` 天的日期键（含今天）：用来判断"最近刚做过" */
function recentDayKeys(days: number, now: Date): string[] {
  return Array.from({ length: days }, (_, index) =>
    dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - index)),
  )
}

/**
 * Prisma 的 `ingredients` 是 Json 列（形状不受类型系统保护），读成配料名。
 * 与 `fridge.service` / `ai.service` 里的同名函数是同一段代码——**没有抽公共函数是刻意的**，
 * 理由见 `fridge.service` 那段注释（第四处调用点出现前不抽）。
 */
function readIngredientNames(raw: unknown): { name: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name: unknown }).name) : ''))
    .filter((name) => name.trim() !== '')
    .map((name) => ({ name }))
}
