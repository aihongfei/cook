import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { FamilyRole } from '../family/family.roles'
import { publicImageUrl } from '../media/media.storage'
import { NotificationsService } from '../notifications/notifications.service'
import { dateKey, visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import { TasteService } from '../taste/taste.service'
import { judgeDish } from '../taste/taste.rules'
import {
  FRIDGE_ZONES,
  RECENT_LIMIT_DEFAULT,
  expiryState,
  type FridgeZone,
  parseAmount,
  parseExpiry,
  parseName,
  parseNote,
  parseZone,
  toView,
  type FridgeItemView,
} from './fridge.rules'
import {
  isSeasoning,
  matchDish,
  parseCookableLimit,
  parseCookableOffset,
  parseMaxMissing,
  parsePantry,
  rankMatches,
  type DishMatch,
} from './pantry.rules'

/**
 * 冰箱库存（M6 / F6-01/02/03/04/05）。形态见 D-049：录入 = 手动 + 拍照（拍照那半待多模态模型）。
 *
 * 四件事刻意的：
 *
 * - **可见性沿用家庭那一套**（共享关掉时吃货只看自己放的）：冰箱是家里共用的，
 *   但"共享"这个开关是全网通用的语义，这里单独开一个洞会让人无法预期
 *   （与点单/打卡/家人最爱同一套闸门，见 `visibleToMember`）。
 * - **同名同区是"改"不是"再加一条"**：库层有唯一约束（`familyId + zone + name`）。
 *   用户第二次说"鸡蛋"时想要的是"再记两个"，不是列表里出现两行鸡蛋；
 *   所以这里把"已经有一条"的情况转成一句人话，让前端去走编辑。
 * - **排序按"要不要先吃"**（F6-05）：临期的排前面，没写保质期的排后面——
 *   冰箱这个界面的用途就是"今天做什么"，把还有两个月的酱油排在上面没有意义。
 * - **不编数字**：概览里的"快过期"只数真的写了保质期且到期的（F6-02），
 *   与 D-040 撤掉假数据是同一条线。
 */
@Injectable()
export class FridgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taste: TasteService,
    /** 「冰箱有变化」要告诉家里人（用户 2026-10-16）。冰箱是家里共用的，谁动了都该能看见 */
    private readonly notifications: NotificationsService,
  ) {}

  /** 库存全量 + 概览（F6-02）。四区各自一组，前端直接画（不在前端再分组一遍） */
  async board(userId: string) {
    const { familyId, role, shared } = await this.requireMember(userId)
    const scope = visibleToMember(shared, role)

    const rows = await this.prisma.fridgeItem.findMany({
      where: {
        familyId,
        // 共享关掉时吃货只看自己放的（与点单/历史同一套闸门）
        ...(scope === 'mine' ? { addedById: userId } : {}),
      },
      include: { addedBy: { select: { nickname: true } } },
    })

    const now = new Date()
    const items = rows.map(row => toView({ ...row, addedByName: row.addedBy.nickname }, now))

    /*
     * 排序：**临期的先看**（F6-05），然后是有保质期的按日期，最后是没写保质期的。
     * 同一天里按名字排，这样同一区的位置是稳定的（用户下次找同一样东西在同一个位置）。
     */
    const order = (a: FridgeItemView, b: FridgeItemView) => {
      if (a.attention !== b.attention) return a.attention ? -1 : 1
      if (a.expiresOn && b.expiresOn && a.expiresOn !== b.expiresOn) return a.expiresOn < b.expiresOn ? -1 : 1
      if (a.expiresOn !== b.expiresOn) return a.expiresOn ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    }

    const zones = FRIDGE_ZONES.map(zone => ({
      zone,
      items: items.filter(item => item.zone === zone).sort(order),
    }))

    /*
     * 「今日先吃」（F6-05）也要**按同一条规则排序**。
     * 第一版这里写的是 `items.filter(...)`（直接用未排序的原数组），
     * 于是"过期 1 天"排在"过期 3 天"前面——最该先处理的反而在最后（验收脚本抓到的）。
     */
    const attention = items.filter(item => item.attention).sort(order)
    /*
     * 「最近录入」（F6-06）：按**记的时间**倒序给一页，与上面的排序（临期优先）无关。
     *
     * 这一块回答的是"家里最近新添了什么、谁添的"，所以它的排序**必须**是时间倒序——
     * 用临期那套排会让人以为"最近记的是那盒快过期的奶"。
     *
     * 可见性**沿用同一份 `items`**（已经在上面按共享开关收窄过了）：这里绝不能再查一次库，
     * 否则两处口径会分叉（一处收窄一处没收窄，就是 D-056 那个泄漏的形状）。
     */
    const recent = [...items]
      .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.name.localeCompare(b.name, 'zh')))
      .slice(0, RECENT_LIMIT_DEFAULT)
    return {
      scope,
      zones,
      /** 最近记的几样（F6-06）：时间倒序，每条带「刚刚/今天/昨天/N 天前」那句话 */
      recent,
      /** 最近记的一共几样（界面说"还有 N 样"用；`items` 是全量） */
      recentTotal: items.length,
      /** 概览（F6-02）：都是真数字（空冰箱就是 0，不是"还没做"） */
      summary: {
        total: items.length,
        attention: attention.length,
        /*
         * 过期数按**日期**判定，不按那句文案的前缀（`startsWith('过期')`）：
         * 文案是给人看的、会改（"过期 3 天"→"坏了 3 天"），拿它当判据等于把显示和逻辑绑死。
         */
        expired: items.filter(item => item.expiresOn !== null && expiryState(new Date(`${item.expiresOn}T00:00:00Z`), now) === 'expired').length,
        /** 写了保质期的样数——用来回答"还有多少样没标保质期"这种追问 */
        withExpiry: items.filter(item => item.expiresOn !== null).length,
      },
      /** 「今日先吃」（F6-05）：临期清单单独给一份，前端不必自己筛 */
      soon: attention,
    }
  }

  /** 放进冰箱（F6-03 手动录入；将来拍照识别的批量入库也走这里） */
  async add(userId: string, input: FridgeInput) {
    const { familyId } = await this.requireMember(userId)
    const name = parseName(input?.name)
    // 数量与保质期都在 rules 里解析：非法值要抛 400，而不是存进去一个 "2026-13-45"
    const amount = parseAmount(input?.amount)
    const zone = input?.zone === undefined ? '冷藏' : parseZone(input.zone)
    const expiresOn = parseExpiry(input?.expiresOn)
    const note = parseNote(input?.note)

    const existing = await this.prisma.fridgeItem.findUnique({
      where: { familyId_zone_name: { familyId, zone, name } },
    })
    if (existing) {
      /*
       * 同名同区已经有一条：**不悄悄叠加、也不新建第二条**。
       * 这两条路都错——悄悄叠加会让"我填的数量"变成"两次之和"（用户没法知道库里现在是几），
       * 新建第二条则会污染概览件数、也让"两盒鸡蛋"变成一个要用户自己算的谜题。
       * 所以明说，并指出该怎么改（前端据此打开编辑）。
       */
      throw new ConflictException(`「${name}」在${zone}里已经记了一条，直接改它就行`)
    }

    const created = await this.prisma.fridgeItem.create({
      data: { familyId, addedById: userId, name, amount, zone, expiresOn, note },
    })

    // 「冰箱有变化」：谁放了什么（用户 2026-10-16）。键用新建那一行的 id（同名同区不可能同时出现两条）
    await this.notifications.recordChange(familyId, {
      kind: 'fridge',
      action: `往冰箱放了「${name}」`,
      body: [amount, zone].filter(Boolean).join(' · ') || null,
      to: '/fridge',
      mealKey: null,
      tag: '入库',
      scope: `add:${created.id}`,
    }, userId)

    return this.board(userId)
  }

  /** 改一条（数量/位置/保质期/备注）。菜名也能改（打错字很常见） */
  async update(userId: string, itemId: string, input: FridgeInput) {
    const { familyId, role, shared } = await this.requireMember(userId)
    const item = await this.prisma.fridgeItem.findUnique({ where: { id: itemId } })
    if (!item || item.familyId !== familyId) throw new NotFoundException('这条食材不在了')
    // 共享关掉时，吃货只能动自己放的那几条（与"只看得到自己的"是同一个范围）
    if (visibleToMember(shared, role) === 'mine' && item.addedById !== userId) {
      throw new ForbiddenException('这条不是你放的，改不了')
    }

    const name = input?.name === undefined ? item.name : parseName(input.name)
    const zone = input?.zone === undefined ? (item.zone as FridgeZone) : parseZone(input.zone)
    const amount = input?.amount === undefined ? item.amount : parseAmount(input.amount)
    const expiresOn = input?.expiresOn === undefined ? item.expiresOn : parseExpiry(input.expiresOn)
    const note = input?.note === undefined ? item.note : parseNote(input.note)

    // 改名或改区之后可能与另一条撞名（唯一约束），先查一次为的是给一句人话
    if (name !== item.name || zone !== item.zone) {
      const clash = await this.prisma.fridgeItem.findUnique({
        where: { familyId_zone_name: { familyId, zone, name } },
      })
      if (clash && clash.id !== itemId) {
        throw new ConflictException(`${zone}里已经有一条「${name}」了，两条合成一条吧`)
      }
    }

    await this.prisma.fridgeItem.update({
      where: { id: itemId },
      data: { name, zone, amount, expiresOn, note },
    })

    /*
     * 「冰箱有变化」：谁改了什么（用户 2026-10-16）。
     *
     * **只在真的改了东西时提醒**（快照比对）：点开编辑框又原样保存不该打扰家里人一次。
     *
     * 键里带**改完之后的那个快照**（名字/区/数量/保质期拼起来），于是：
     * ① 连点两次保存同一个值不刷两条（键一样，`skipDuplicates` 挡掉）；
     * ② 改成不同的值各提醒一次。**改回原值不重复提醒**——这一条说的是
     * "它现在是 X"，而这句话已经告诉过家里人了；把时刻塞进键里能绕开这一点，
     * 但代价是"网络重试/重复提交会刷出一串同样的提醒"，那更糟。
     */
    const snapshotOf = (values: { name: string; zone: string; amount: string | null; expiresOn: Date | null }) =>
      [values.name, values.zone, values.amount ?? '', values.expiresOn ? dateKey(values.expiresOn) : ''].join('|')

    if (snapshotOf({ name, zone, amount, expiresOn }) !== snapshotOf(item)) {
      await this.notifications.recordChange(familyId, {
        kind: 'fridge',
        action: name === item.name ? `动了冰箱里的「${name}」` : `把「${item.name}」改成了「${name}」`,
        body: [amount, zone].filter(Boolean).join(' · ') || null,
        to: '/fridge',
        mealKey: null,
        tag: '改了',
        scope: `edit:${itemId}:${snapshotOf({ name, zone, amount, expiresOn })}`,
      }, userId)
    }

    return this.board(userId)
  }

  /** 拿出来了/吃完了：删掉。冰箱里"还有"的东西才该留着 */
  async remove(userId: string, itemId: string) {
    const { familyId, role, shared } = await this.requireMember(userId)
    const item = await this.prisma.fridgeItem.findUnique({ where: { id: itemId } })
    if (!item || item.familyId !== familyId) throw new NotFoundException('这条食材不在了')
    if (visibleToMember(shared, role) === 'mine' && item.addedById !== userId) {
      throw new ForbiddenException('这条不是你放的，拿不了')
    }
    await this.prisma.fridgeItem.delete({ where: { id: itemId } })

    // 「冰箱有变化」：谁拿走了什么（用户 2026-10-16）。键用被删掉那一行的 id——它已不在库里，但那次动作有它唯一
    await this.notifications.recordChange(familyId, {
      kind: 'fridge',
      action: `从冰箱拿走了「${item.name}」`,
      body: item.amount ? `原来的量：${item.amount}` : null,
      to: '/fridge',
      mealKey: null,
      tag: '拿走',
      scope: `remove:${itemId}`,
    }, userId)

    return this.board(userId)
  }

  /**
   * 手边食材能做什么（F5-04 选食材找菜 / F6-07 库存↔推荐 / F7-02 只买缺的）。
   *
   * 三处用同一个判断，只是输入不同（F5-04 用户勾的、F6-07 整个冰箱、F7-02 反过来问）。
   * 匹配规则全在 `pantry.rules`（纯函数、单测直接验）——三个页面各写一套的话，
   * "家里有辣椒算不算有"会给出三个答案。
   *
   * 五件事刻意的：
   *
   * - **不传食材就用整个冰箱**（F6-07 的"入库即推荐"）：冰箱页打开就要看到"N 道菜能用上冰箱食材"，
   *   不该让用户先把冰箱里的东西挨个勾一遍。传了就用传的（F5-04 的"今天就想用手边这几样"）；
   * - **共享关掉时用"我能看见的那部分"**：冰箱可见性那一套，与 board 完全一致；
   * - **口味过滤在这里也生效**（F5-03）：这道菜里有人过敏就不该进候选。判据同 F8-02（只看配料表）；
   * - **不查 AI、不问模型**：这是纯规则算出来的，毫秒级、可解释、离线可用。用户要的是
   *   "我有什么能做什么"，不是又一次十几秒的等待；
   * - **菜谱全表扫**：612 道 × 平均 307 字节配料 = 约 190KB，比一次 AI 调用的千分之一还小。
   *   真到几万道再谈倒排索引，现在建索引是给一个不存在的问题写代码。
   */
  async cookable(
    userId: string,
    options: { ingredients?: unknown; limit?: unknown; offset?: unknown; maxMissing?: unknown; forMeal?: unknown } = {},
  ) {
    const { familyId, role, shared } = await this.requireMember(userId)
    const scope = visibleToMember(shared, role)
    const limit = parseCookableLimit(options.limit)
    const offset = parseCookableOffset(options.offset)
    const maxMissing = parseMaxMissing(options.maxMissing)

    const given = parsePantry(options.ingredients)
    /*
     * 用户没指定就用冰箱里那些（且只算**他能看见的**）。
     * 空冰箱时 `pantry` 为空 → 结果必然是空 → 界面说"冰箱还是空的"，
     * 而不是给一份"用料最少的菜"去装成推荐（见 rankMatches 的第一条筛选）。
     */
    const fridgeRows = given.length
      ? []
      : await this.prisma.fridgeItem.findMany({
          where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
          select: { name: true },
          orderBy: { createdAt: 'desc' },
        })
    /*
     * 从冰箱来的清单里**把调料摘出去**（用户手勾的照留）。
     *
     * 冰箱是照实记的：谁家冰箱里都有盐和生抽。但放进手边清单会让两件事说错——
     * ① `usable`（"能用出菜的东西有几样"）把盐算成一样，用户会以为有 9 样可用，其实只有 6 样；
     * ② 界面上那颗颗小标签会列出一排"盐 食用油 生抽"，看着像在说"用盐能做菜"。
     * 调料本来就不参与匹配（`matchDish` 那边整个跳过），所以摘掉不影响任何判断，
     * 只是让"手边有什么"这句人话是真的。摘掉几样要报数（`skipSeasonings`）。
     */
    const rawSource = given.length ? given : fridgeRows.map((row) => row.name)
    const pantry = given.length ? rawSource : rawSource.filter((name) => !isSeasoning(name))
    const source: 'fridge' | 'picked' = given.length ? 'picked' : 'fridge'
    const skipSeasonings = rawSource.length - pantry.length

    if (pantry.length === 0) {
      return {
        source,
        scope,
        pantry: [],
        /** 手边能拿来做菜的东西一共几样（调料不算）——界面据此说"冰箱还是空的" */
        usable: 0,
        skipSeasonings,
        maxMissing,
        filteredOut: 0,
        /** 什么都不做（不是"没找到"）：冰箱空着，任何"推荐"都是编的 */
        total: 0,
        /** 与下面那条正常返回保持同一个形状（前端只认一种响应，不用分情况） */
        offset,
        items: [],
      }
    }

    const recipes = await this.prisma.recipe.findMany({
      select: { id: true, name: true, image: true, imageKey: true, category: true, cuisine: true, calories: true, caloriesEstimated: true, spiciness: true, ingredients: true },
    })

    const matched: { recipeId: string; name: string; match: DishMatch; recipe: (typeof recipes)[number] }[] = []
    for (const recipe of recipes) {
      const match = matchDish(readIngredientNames(recipe.ingredients), pantry)
      if (match) matched.push({ recipeId: recipe.id, name: recipe.name, match, recipe })
    }

    /*
     * 口味过滤在**排序之前**（F5-03）：过敏的菜根本不该出现在"想做什么"里。
     * 与 AI 推荐同一个判据（`judgeDish` 只看配料表），只是那边是"交给模型之前排掉"，
     * 这里是"交给用户之前排掉"。
     */
    const profiles = await this.taste.activeProfiles(familyId)
    const safe = profiles.length
      ? matched.filter((row) =>
          judgeDish(
            { name: row.name, spiciness: row.recipe.spiciness, ingredients: readIngredientNames(row.recipe.ingredients) },
            profiles,
          ).verdict !== 'block',
        )
      : matched

    const ranked = rankMatches(safe, maxMissing)
    /*
     * "挡掉了几道"数在**排完序的两个集合之差**上，不是 `matched` 的差。
     *
     * 第一版数的是 `matched - safe`，验收脚本立刻给了反例：写一个与这些菜无关的过敏词，
     * 它照样报"挡住了 4 道"——那 4 道确实含那个词，但它们**本来也进不了这份结果**
     * （差得太远、超出了容忍度）。用户看到"N 道被挡掉"会以为是自己眼前少了几道，
     * 而这句话必须是真的。现在它数的是"按这份手边清单本来会出现在结果里、因为过敏被拿掉的"。
     */
    const unfiltered = profiles.length ? rankMatches(matched, maxMissing) : ranked
    const filteredOut = unfiltered.length - ranked.length

    const byId = new Map(safe.map((row) => [row.recipeId, row]))

    return {
      source,
      scope,
      /** 手边用的那几样（从冰箱来时按用户记的名字，勾选时按他勾的名字） */
      pantry,
      usable: pantry.length,
      skipSeasonings,
      maxMissing,
      /** 能做的菜一共几道（不是返回了几道）——界面据此说"还有 N 道" */
      total: ranked.length,
      /** 这一页从第几道开始（0 基）。翻页的调用方拿它算下一页，不用自己记 */
      offset,
      /** 口味挡掉了几道（F5-03）：只数**本来会出现在这份结果里**的 */
      filteredOut,
      items: ranked.slice(offset, offset + limit).flatMap((row) => {
        const entry = byId.get(row.recipeId)
        if (!entry) return []
        const { recipe } = entry
        return [
          {
            id: recipe.id,
            name: recipe.name,
            image: publicImageUrl(recipe.imageKey, recipe.image),
            category: recipe.category,
            cuisine: recipe.cuisine,
            calories: recipe.calories,
            caloriesEstimated: recipe.caloriesEstimated,
            /** 用上了手边的哪几样（这是这一行最该看见的话） */
            have: row.have,
            /** 还差哪几样：**列名字**，用户要拿它去决定买不买 */
            missing: row.missing,
            missingCount: row.missingCount,
          },
        ]
      }),
    }
  }

  // ---------- 内部 ----------

  private async requireMember(userId: string) {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException('先加入家庭，才能记冰箱里的东西')
    return {
      familyId: membership.familyId,
      role: membership.role as FamilyRole,
      shared: membership.family.shared,
    }
  }
}

interface FridgeInput {
  name?: unknown
  amount?: unknown
  zone?: unknown
  expiresOn?: unknown
  note?: unknown
}

/**
 * Prisma 的 `ingredients` 是 Json 列（形状不受类型系统保护），读成配料名给匹配用。
 * 脏数据一律丢掉而不是抛：一道菜谱的配料写坏了不该让整个"能做什么" 500。
 *
 * 与 `ai.service` / `orders.service` 里的同名函数是同一段代码——**没有抽公共函数是刻意的**：
 * 那两处要的是 `{ name }[]` 给判据，这里要的是同样的东西，但抽出去会多一个只有三行、
 * 被四个模块依赖的 util（而且改一处要动四处）。真要抽取，等第五个调用点出现。
 */
function readIngredientNames(raw: unknown): { name: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name: unknown }).name) : ''))
    .filter((name) => name.trim() !== '')
    .map((name) => ({ name }))
}
