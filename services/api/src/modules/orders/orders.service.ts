import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { MealSlot, OrderStatus, Prisma } from '@prisma/client'
import { CAPABILITIES, FamilyRole, can } from '../family/family.roles'
import { publicImageUrl } from '../media/media.storage'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../recipes/prisma.service'
import { TasteService } from '../taste/taste.service'
import { judgeDish, type TasteJudgement } from '../taste/taste.rules'
import {
  MEAL_LABEL, MEAL_SLOTS, ORDER_STATUSES, STATUS_LABEL, TRANSITION_CAPABILITY,
  aggregateItems, canAddItem, canDeleteMeal, canRemoveItem, canRepeatFrom, confirmStampFor, dateKey, doneStampFor, dateOnly, dayWindow, isAllowedTransition, mealKeyOf, mealWhenLabel, nextActionsFor, parseDinerCount,
  parseHistoryQuery, historyRange, hasEarlier, weekdayOf,
  parseItemTarget, parseBulkRecipeIds, parseMealDate, parseMealKey, parseNote, parsePlanDays, parseSlot, parseStatus, photoVisibleTo, planRepeat, revivedStatus, splitExisting,
  todayKey, todayMealState, visibleToMember, listWindowDays,
  dayOptions, type AggregateItem, type DishRef, type ItemTarget, type MealProgressRow, type PlanDayRow,
} from './orders.rules'

/**
 * 点单（M3 / F3-01~F3-05，口径见 D-022）。
 *
 * 核心约定：
 * - 一张卡 = 一个「家庭 + 日期 + 餐次」（MealOrder），家人各自往里点菜，**状态是整餐的**；
 * - 权限直接复用 M2 的能力表（`order.create` 点菜、`menu.manage`/`menu.confirm` 改状态），不新增 key；
 * - 共享开关（F2-07）关闭时，吃货只看到与自己有关的餐次（见 orders.rules 的 visibleToMember）。
 *
 * 纯判定（状态机、合并、日期范围）都在 `orders.rules.ts`，这里只管数据库与视图组装。
 */

export interface OrderItemView {
  id: string
  recipeId: string | null
  name: string
  image: string | null
  userId: string
  nickname: string
  avatar: string
  isMe: boolean
  note: string | null
  createdAt: string
}

export interface MealCardView {
  /** 稳定标识：`2026-10-13-DINNER`，前端做流转与缓存键用 */
  mealKey: string
  date: string
  meal: MealSlot
  mealLabel: string
  status: OrderStatus
  statusLabel: string
  orderers: string[]
  ordererCount: number
  dishCount: number
  dishes: ReturnType<typeof aggregateItems>['dishes']
  items: OrderItemView[]
  mineCount: number
  /** 掌勺人设定的就餐人数（M4 / F4-05）；null = 还没定 */
  dinerCount: number | null
  /**
   * 这一版菜单是谁定下来的（M4 / F4-05 的确认留痕）；null = 还在收集中，或这一版已被取消。
   * 取消/取消后重新加菜会清空两人份（谁、何时）——上一版菜单不算数了。
   */
  confirmedBy: { nickname: string; avatar: string } | null
  confirmedAt: string | null
  /**
   * 谁把这一餐标成「做好了」、什么时候（M10 / F10-02）。
   *
   * 与 `confirmedBy` 是**两件事**：定菜单与做饭可以是两个人，这一版把两者
   * 一起下发，详情页才能把"谁定的、谁做的"分开说清。
   */
  doneBy: { nickname: string; avatar: string } | null
  doneAt: string | null
  /** 这一餐的成品照张数（F9-08）。按视图范围算：看不到的照片不计入（见 cardFromRow 说明） */
  photoCount: number
  /** 这一餐还收不收新菜（到「正在做」为止都能加，只有「做好了」封口）——详情页「再加一道」按它决定出不出现 */
  canAdd: boolean
  /**
   * 能不能拿这一餐去「再点一次」（F3-06）：做好了 / 已取消 / 日子已经过去。
   *
   * 由后端算好而不是让前端看着状态和日期自己判断——判据只有一份（`canRepeatFrom`），
   * 前端复刻一遍就会分叉（后端限了来源、前端却还显示按钮，点下去拿到 409）。
   */
  canRepeat: boolean
  nextActions: { status: OrderStatus; label: string; needsConfirm: boolean }[]
  submittedAt: string
}

/**
 * 点完一道菜的结果 = 那张餐卡 + **这一笔的提醒**（F3-08）。
 *
 * 为什么不把提醒塞进 `MealCardView`：卡片是"这一餐现在什么样"，从列表、今日安排、
 * 计划页都会下发——在那几处算一遍口味判据既是白算，也会让"提醒"出现在用户没点菜的
 * 时刻。提醒属于**这一笔动作**，所以只挂在 addItem 的返回上。
 */
export interface AddItemResult extends MealCardView {
  /**
   * 有人过敏或忌口时才有（见 `judgeDish`）。
   *
   * **只是提醒，不拦**：这是用户自己的选择（他可能就是给全家人之外的那位做），
   * 拦下来会让人以为菜谱库坏了。但要在**加入的那一刻**说，晚了就只剩添堵。
   */
  tasteWarning?: { verdict: 'warn' | 'block'; text: string }
}

/**
 * 整条删掉一餐记录之后的回执（见 `deleteMeal`）。
 *
 * 这一餐已经不在库里了，所以这些数字只能由删除这件事**顺手带回来**：
 * 前端拿它拼"删掉了 10-17 晚餐（3 道菜，2 张成品照留下来了）"，
 * 用户才知道刚才那一下到底删掉了什么、什么没被删掉。
 */
export interface DeletedMealView {
  mealKey: string
  date: string
  meal: MealSlot
  mealLabel: string
  /** 跟着一起没了的点单份数 */
  dishCount: number
  /** **没跟着死**的成品照张数（`CheckIn.mealOrderId` 会被置空，照片退回成独立打卡） */
  photoCount: number
}

/** Prisma 的 `ingredients` 是 Json 列：读成判据要的形状，脏数据丢掉而不是抛（见 ai.service 的同名工具） */
function ingredientNamesOf(raw: unknown): { name: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name: unknown }).name) : ''))
    .filter((name) => name.trim() !== '')
    .map((name) => ({ name }))
}

type MealOrderRow = Prisma.MealOrderGetPayload<{ include: typeof MEAL_ORDER_INCLUDE }>

/** 卡片组装要用的关联（列表与单卡共用，避免两处 include 漂移） */
const MEAL_ORDER_INCLUDE = {
  items: { include: { user: true }, orderBy: { createdAt: 'asc' } },
  checkIns: { select: { userId: true } },
  // 「谁定的这餐」要跟着卡片下发（列表里每张卡都可能带着它），只取显示要用的两个字段
  confirmedBy: { select: { nickname: true, avatar: true } },
  // 「谁做的这餐」（M10）同样跟着走：详情页要能说清"妈妈定、爸爸做"
  doneBy: { select: { nickname: true, avatar: true } },
} satisfies Prisma.MealOrderInclude

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    /*
     * 口味判据（F3-08）：点菜时提醒"这家有人对这个过敏/忌口"。
     * **提醒而不是拦截**——这是用户自己的选择，拦下来会让人以为菜谱库坏了
     * （"我明明想点这道"）。但它必须是**加入之前**的那一步：加进去之后再说，
     * 用户已经把这顿饭安排好了，提醒就只剩下添堵。
     */
    private readonly taste: TasteService,
    /** 「订单有变化」要告诉家里人（用户 2026-10-16）。口径与扇出都在通知服务里，这里只报事实 */
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 点菜（`order.create`，人人可点）：点菜谱里的，或者自己写一道（F3-10）。
   * 同一餐已有就复用；**能不能加只看 `canAddItem`**（到「正在做」为止都能加，只有「做好了」封口）。
   *
   * `silent` 只给 `addItems` 用（整组加菜）：它逐道走这里是为了语义一致，
   * 但**提醒要合成一条**——摇一桌五道菜在通知里刷五行是打扰，不是告知。
   * 别在业务代码里传它：那是"这一次不要提醒"的内部开关，不是功能选项。
   */
  async addItem(
    userId: string,
    input: { recipeId?: string; dishName?: string; mealDate?: string; meal?: string; note?: string },
    options: { silent?: boolean } = {},
  ): Promise<AddItemResult> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.ORDER_CREATE)

    const slot = parseSlot(input.meal)
    const mealDate = parseMealDate(input.mealDate)
    const note = parseNote(input.note)
    const target = parseItemTarget(input)
    const item = await this.resolveItem(target)

    const mealOrder = await this.ensureMealOrder(familyId, mealDate, slot)
    if (!canAddItem(mealOrder.status)) {
      // 已做好是终态、连取消都不行，别给出"先取消"这种做不到的建议
      throw new ConflictException(
        mealOrder.status === 'DONE'
          ? '这餐已经做好了，换个餐次再点吧'
          : `这餐已经「${STATUS_LABEL[mealOrder.status]}」了，加不进去了——要改这一餐的记录请到点单历史里删`,
      )
    }

    // 被取消过的餐：加菜时顺带复活成「待确认」（见 orders.rules 的 canAddItem）。
    // 连带清掉上一版的确认留痕（M4 / F4-05）：菜单回到"收集中"，"谁定过"就不再成立。
    if (mealOrder.status !== revivedStatus(mealOrder.status)) {
      await this.prisma.mealOrder.update({
        where: { id: mealOrder.id },
        data: { status: revivedStatus(mealOrder.status), confirmedById: null, confirmedAt: null },
      })
    }

    const created = await this.prisma.orderItem.create({
      data: { mealOrderId: mealOrder.id, userId, ...item, note },
    })
    const card = await this.card(mealOrder.id, userId)

    /*
     * 「订单有变化」告诉家里人（用户 2026-10-16）。
     * 键用**这一条点单的 id**：同一道菜今天点了、明天又点，是两件事，该有两条提醒
     * （拿"餐次"当键的话第二次会被当成重复丢掉）。
     *
     * **await 它、但不为它失败**（`recordChange` 内部吞异常）：先写完再回响应，
     * 客户端拿到"加菜成功"时提醒已经在库里了。第一版写成 `void`（不等）——
     * 那是错的：前端加完菜立刻重取一次通知，那几毫秒里它还没写进去，
     * 于是"刚做的事在通知里看不见"，要等下一次刷新（`staleTime` 60 秒）才出现。
     * 这是本项目反复记过的那一类（"页面上看不见刚发生的事"，见 R-78 一族）。
     * 代价是写接口多几次查询——`recordChange` 里那三条都是小查询，值。
     */
    if (!options.silent) {
      await this.notifications.recordChange(familyId, {
        kind: 'order',
        action: `点了「${item.recipeName}」`,
        body: `加进${mealWhenLabel(mealDate, slot)}了`,
        to: `/order/${mealKeyOf(mealDate, slot)}`,
        mealKey: mealKeyOf(mealDate, slot),
        tag: '加菜',
        scope: `add:${created.id}`,
      }, userId)
    }

    return { ...card, ...await this.tasteWarningFor(userId, item.recipeId, item.recipeName) }
  }

  /**
   * 批量加菜（F5-01「摇一桌」的「全都加进这一餐」）。
   *
   * 为什么要有它、而不是让前端循环调 `addItem`：**中途失败会加进去一半**。
   * 一次加五道，第四道撞上"这餐已经安排好了"（或网络断了），用户看到的是餐里多了三道菜
   * 加一句报错——既不是他要的，也不好收拾。所以这里是"**先一次判定、再逐道写入**"，
   * 与 `combos.addToMeal` 处理"一键加入"用的是同一个范式（那条路已经验过）。
   *
   * 三件事刻意的：
   * - **重复的跳过而不是报错**：这一桌里有一道这餐已经有了，那是很常见的情况
   *   （用户先点了排骨，又摇了含排骨的一桌）。跳过并回报 `skipped` 名字，
   *   用户从回执里看得见"哪几道本来就有"；
   * - **全都已有时不报错**（也没写库）：回 `added: []` 让界面说"这一桌都在了"，
   *   报错会让用户以为操作失败；
   * - **写入仍逐道走 `addItem`**：加菜之后整餐回到「待确认」、口味提醒、同名挂接这些语义
   *   两处各写一遍必然分叉（与 combos 同一条理由）。
   */
  async addItems(
    userId: string,
    input: { recipeIds?: unknown; mealDate?: unknown; meal?: unknown },
  ) {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.ORDER_CREATE)

    const slot = parseSlot(input.meal)
    const mealDate = parseMealDate(input.mealDate)
    const wanted = parseBulkRecipeIds(input.recipeIds)

    // 这一餐里已经有的菜（谁点的都算）：跳过，不叠加份数
    const existingRow = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal: slot } },
      include: { items: { select: { recipeId: true } } },
    })
    const existing = (existingRow?.items ?? [])
      .map((item) => item.recipeId)
      .filter((id): id is string => Boolean(id))
    const { toAdd, skipped } = splitExisting(existing, wanted)

    if (toAdd.length === 0) {
      // 一道都不用加：**不判定餐次状态也不写库**（没有要写的东西，就没必要要求这一餐能写）
      return {
        added: [] as string[],
        skipped,
        card: existingRow ? await this.card(existingRow.id, userId) : null,
      }
    }

    // 整组要么都进、要么都不进：先一次性判定这一餐收不收（不写库）
    await this.assertMealAcceptsItems(userId, mealDate, slot)

    for (const recipeId of toAdd) {
      // `silent`：提醒下面**合成一条**（摇一桌五道菜刷五行通知是打扰），见 addItem 的说明
      await this.addItem(userId, { recipeId, mealDate: dateKey(mealDate), meal: slot }, { silent: true })
    }

    const finalRow = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal: slot } },
      include: { items: { select: { id: true, recipeId: true, recipeName: true } } },
    })

    /*
     * 合成的那一条（"妈妈一次点了 3 道菜"）。
     *
     * 幂等键取**这次新加的那几条里 id 最小的那个**：那些 id 是本次调用刚创建的、
     * 全局唯一，所以① 同一次调用里它是确定的（不依赖查询返回顺序）；② 两次不同的
     * 整组加菜必然不同（第二次创建的是新行）；③ 重放同一个请求时 `toAdd` 会是空的
     * （菜已经有了）而**在上面的早返回里就结束了**，走不到这里——于是不会写出第二条。
     */
    const added = (finalRow?.items ?? []).filter((row) => row.recipeId && toAdd.includes(row.recipeId))
    const names = added.map((row) => row.recipeName)
    const anchor = [...added].map((row) => row.id).sort()[0]
    if (anchor) {
      const mealKey = mealKeyOf(mealDate, slot)
      await this.notifications.recordChange(familyId, {
        kind: 'order',
        action: `一次点了 ${names.length} 道菜`,
        body: `加进${mealWhenLabel(mealDate, slot)}了：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 道` : ''}`,
        to: `/order/${mealKey}`,
        mealKey,
        tag: '加菜',
        scope: `bulk:${anchor}`,
      }, userId)
    }

    return {
      added: toAdd,
      skipped,
      card: finalRow ? await this.card(finalRow.id, userId) : null,
    }
  }

  /**
   * 这道菜合不合这一家人的口味（F3-08）。
   *
   * **点完再说**而不是"点之前先弹一个确认框"：多一步确认会把点菜这件小事变成两下，
   * 而绝大多数菜本来就没问题。用户看到提醒时那道菜已经在菜单里了——他可以顺手撤掉
   * （「撤掉这一道」就在那张卡上），这比"先拦住他问一遍"更顺。
   *
   * 判据的来源是**全家填过的档案**：没人填过就什么都不说（不假装有保护，
   * 见 taste.rules 文件头 ③）。
   */
  private async tasteWarningFor(
    userId: string,
    recipeId: string | null,
    dishName: string,
  ): Promise<{ tasteWarning?: { verdict: 'warn' | 'block'; text: string } }> {
    const profiles = (await this.taste.family(userId)).active
    if (profiles.length === 0) return {}

    /*
     * 自己写的那道菜（`recipeId` 为 null）没有配料表——**只能什么都不说**。
     * 按菜名匹配是不行的：那正是判据刻意避开的做法（"鱼香肉丝"里没有鱼）。
     * 少提醒一次，好过说错一次（用户会因此不再信这个提醒）。
     */
    if (!recipeId) return {}

    const recipe = await this.prisma.recipe.findUnique({
      where: { id: recipeId },
      select: { name: true, spiciness: true, ingredients: true },
    })
    if (!recipe) return {}

    const judgement: TasteJudgement = judgeDish({
      name: recipe.name,
      spiciness: recipe.spiciness,
      ingredients: ingredientNamesOf(recipe.ingredients),
    }, profiles)

    if (judgement.verdict === 'ok') return {}
    return { tasteWarning: { verdict: judgement.verdict, text: judgement.text || `「${dishName}」可能有人吃不了` } }
  }

  /**
   * 这一餐现在还收不收新菜——**给"整组加入"这类一次要判定一次的调用方用**
   * （见 combos.service：整组要么都进、要么都不进，不能加到一半才发现"已做好了"）。
   *
   * 判定与 `addItem` 里那段是同一份（`canAddItem` + 终态文案），
   * 但**不写库**：它只回答"能不能"，真正的写入仍走 addItem。
   */
  async assertMealAcceptsItems(userId: string, mealDate: Date, meal: MealSlot): Promise<void> {
    const { familyId } = await this.requireMember(userId)
    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
    })
    // 还没有这一餐 = 当然能加（addItem 会建出来）
    if (!row || canAddItem(row.status)) return
    throw new ConflictException(
      row.status === 'DONE'
        ? '这餐已经做好了，换个餐次再点吧'
        : `这餐已经「${STATUS_LABEL[row.status]}」了，加不进去了——要改这一餐的记录请到点单历史里删`,
    )
  }

  /**
   * 点单条目落库要用的三个字段（菜名与图片是**冗余快照**：菜谱日后被删/换图，历史点单卡仍显示得出来）。
   *
   * 自由菜品（F3-10）在这里做一件"顺手但重要"的事：**菜名与库里某道菜完全同名时挂到那道菜上**——
   * 不然同一道菜会分成两行（库里点的一条 + 自己写的一条），看起来像 bug。
   * 只在完全同名（去首尾空格后）时挂接，宁可不猜，不做模糊匹配。
   */
  private async resolveItem(
    target: ItemTarget,
  ): Promise<{ recipeId: string | null; recipeName: string; recipeImage: string | null }> {
    if (target.kind === 'recipe') {
      const recipe = await this.prisma.recipe.findUnique({ where: { id: target.recipeId } })
      if (!recipe) throw new NotFoundException('这道菜不在菜谱库里')
      return { recipeId: recipe.id, recipeName: recipe.name, recipeImage: publicImageUrl(recipe.imageKey, recipe.image) }
    }

    // 重名菜谱理论上可能有多条：按 id 排序取第一条，保证每次挂到同一道，合并结果稳定
    const matched = await this.prisma.recipe.findFirst({ where: { name: target.dishName }, orderBy: { id: 'asc' } })
    return matched
      ? { recipeId: matched.id, recipeName: matched.name, recipeImage: publicImageUrl(matched.imageKey, matched.image) }
      : { recipeId: null, recipeName: target.dishName, recipeImage: null }
  }

  /**
   * 退掉一份菜（用户 2026-10-15：「订单里面的卡片要能删除…批量操作…退菜这种的」）。
   *
   * **两条口径都是那次定的，都从宽**：
   * - **谁都能退**（不再限于"只能退自己点的"）。家里谁发现菜单不对都能顺手去掉一道，
   *   而不是"等点菜的人回来自己退"——那是让全家为一个操作卡住。原来那句话术
   *   （「只能撤回自己点的菜」）连同那条判断一起去掉了；
   * - **到「正在做」为止都能退**（`canRemoveItem`：只有 DONE 封口），理由写在那条纯规则上。
   *
   * 取消整餐仍然走 `updateStatus`（那是另一件事：整桌不做了，且需要 menu.manage）。
   */
  async removeItem(userId: string, itemId: string): Promise<MealCardView> {
    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId }, include: { mealOrder: true } })
    if (!item) throw new NotFoundException('这条点单不存在了')

    const { familyId } = await this.requireMember(userId)
    if (item.mealOrder.familyId !== familyId) throw new NotFoundException('这条点单不存在了')
    if (!canRemoveItem(item.mealOrder.status)) {
      throw new ConflictException(`这一餐已经「${STATUS_LABEL[item.mealOrder.status]}」了，成品不能再改——记录要改请到点单历史里删`)
    }

    await this.prisma.orderItem.delete({ where: { id: itemId } })

    /*
     * 「订单有变化」：谁退了哪一道。键用**被退掉那一行的 id**——它已经删了，
     * 但那个 id 是这一件事的唯一标识（退同一道菜两次是两个 id、两条提醒）。
     * 放在删除**之后**发：删成功才算这件事发生过。
     */
    const mealKey = mealKeyOf(item.mealOrder.mealDate, item.mealOrder.meal)
    await this.notifications.recordChange(familyId, {
      kind: 'order',
      action: `退掉了「${item.recipeName}」`,
      body: `${mealWhenLabel(item.mealOrder.mealDate, item.mealOrder.meal)}少了一道`,
      to: `/order/${mealKey}`,
      mealKey,
      tag: '撤菜',
      scope: `remove:${itemId}`,
    }, userId)

    // 退掉最后一份菜后这张卡就空了，顺手删掉——免得列表里留一个"0 道菜"的餐次
    const remaining = await this.prisma.orderItem.count({ where: { mealOrderId: item.mealOrderId } })
    if (remaining > 0) return this.card(item.mealOrderId, userId)

    await this.prisma.mealOrder.delete({ where: { id: item.mealOrderId } })
    return emptyCard(item.mealOrder.mealDate, item.mealOrder.meal)
  }

  /**
   * 把**这一餐整桌**退掉（列表里长按多选 → 批量操作；用户 2026-10-15）。
   *
   * 为什么按 `mealKey` 而不是"传一串 item id"：点单列表上的卡片是**摘要**，
   * 它只带得出"我点的那几份"的 id（`mineItemIds`，见 `aggregateItems`）——
   * 而现在谁都能退任何菜，前端根本拿不到别人的条目 id。
   * 按餐来退，判据落在服务端一处，也顺带避免"前端自己拼一串 id、拼错一个就少退一道"。
   *
   * 退完这一餐就空了，于是**整张卡消失**——这正是用户说的"卡片要能删除"。
   * 与单条退菜共用同一套守卫（谁能退、退到哪一步），不另写一份。
   */
  async clearItems(userId: string, mealKey: string): Promise<MealCardView> {
    const { familyId } = await this.requireMember(userId)

    const { mealDate, meal } = parseMealKey(mealKey)
    const mealOrder = await this.prisma.mealOrder.findUnique({ where: { familyId_mealDate_meal: { familyId, mealDate, meal } } })
    if (!mealOrder) throw new NotFoundException('这一餐还没有人点菜')

    if (!canRemoveItem(mealOrder.status)) {
      throw new ConflictException(`这一餐已经「${STATUS_LABEL[mealOrder.status]}」了，成品不能再改——记录要改请到点单历史里删`)
    }

    const dishCount = await this.prisma.orderItem.count({ where: { mealOrderId: mealOrder.id } })
    await this.prisma.orderItem.deleteMany({ where: { mealOrderId: mealOrder.id } })
    await this.prisma.mealOrder.delete({ where: { id: mealOrder.id } })

    /*
     * 「订单有变化」：谁把这一桌退了。
     * 键用**被删掉的那一餐的 id**（`MealOrder.id`，不是 mealKey）：同一餐被退掉、
     * 又被人点起来、再被退掉，是两件事——mealKey 两次相同，而 `MealOrder.id` 每次新建都不同。
     */
    const key = mealKeyOf(mealOrder.mealDate, mealOrder.meal)
    await this.notifications.recordChange(familyId, {
      kind: 'order',
      action: `把${mealWhenLabel(mealOrder.mealDate, mealOrder.meal)}整桌退了`,
      body: `退了 ${dishCount} 道菜`,
      to: `/order`,
      mealKey: key,
      tag: '撤菜',
      scope: `clear:${mealOrder.id}`,
    }, userId)

    return emptyCard(mealOrder.mealDate, mealOrder.meal)
  }

  /**
   * 整条删掉一餐的**记录**（用户 2026-10-15：「点单历史里面要有」删整条）。
   *
   * 这是"做好了"封口之后**唯一的改错入口**：那一餐的明细已经不能改（`canRemoveItem` 挡着），
   * 而"这条记录本身就是错的"（点错了、重复记了一条、那顿其实没在家吃）只能整条删。
   * 判据是 `canDeleteMeal`（**只有 DONE / CANCELED**，理由见那个纯规则）。
   *
   * 三件事想清楚了才这么写：
   * - **谁都能删**，与退菜同一个口径（家里的事家里人说清就行，不是权限问题）。
   *   代价交给确认框讲清（点名日期餐次 + 几道菜 + 几张成品照会退回成独立打卡）——
   *   本项目对"不可逆"的一贯做法是**让它可见、让它可懂**，而不是靠角色拦着（D-066）；
   * - **成品照不跟着死**：`CheckIn.mealOrderId` 是 `onDelete: SetNull`——照片退回成"没挂在哪一餐上的打卡"
   *   （那是这家人的照片，删一条点单记录不该把照片一起删掉）。所以先数一遍再删，好把这句话说给用户听；
   * - **把被删的那一份信息返回**：删完这一餐就不在了，前端拼"删掉了 10 月 17 日晚餐"的回执
   *   只能靠这里带回去的数字（任何"再取一次"都拿不回来了）。
   */
  async deleteMeal(userId: string, mealKey: string): Promise<DeletedMealView> {
    const { familyId } = await this.requireMember(userId)
    const { mealDate, meal } = parseMealKey(mealKey)

    const mealOrder = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
    })
    if (!mealOrder) throw new NotFoundException('这一餐没有记录')

    if (!canDeleteMeal(mealOrder.status)) {
      throw new ConflictException(
        `这一餐还在「${STATUS_LABEL[mealOrder.status]}」，删记录得先有定局——`
        + '不想做这一餐就取消它，只想去掉某几道菜就退菜。',
      )
    }

    const [dishCount, photoCount] = await Promise.all([
      this.prisma.orderItem.count({ where: { mealOrderId: mealOrder.id } }),
      this.prisma.checkIn.count({ where: { mealOrderId: mealOrder.id } }),
    ])

    await this.prisma.mealOrder.delete({ where: { id: mealOrder.id } })

    /*
     * 「订单有变化」：谁删了哪一餐的记录（用户 2026-10-16）。
     * 这是**唯一一条去处不带 mealKey 的订单提醒**——那一餐已经不存在了，
     * 点进详情只会 404。所以去 `/order/history`：这条记录刚从那儿消失，
     * 用户点进来看得见"确实没有了"（比给一个打不开的链接好）。
     * `mealKey` 字段仍然带上：点单卡上可能还有那一张（列表缓存要几秒才更新），
     * 而且"这条提醒说的是哪一餐"对用户是有意义的。
     */
    await this.notifications.recordChange(familyId, {
      kind: 'order',
      action: `删掉了${mealWhenLabel(mealOrder.mealDate, meal)}的记录`,
      body: dishCount > 0 ? `那 ${dishCount} 道菜一起删了` : null,
      to: '/order/history',
      mealKey,
      tag: '删记录',
      scope: `delete:${mealOrder.id}`,
    }, userId)

    return {
      mealKey,
      date: dateKey(mealOrder.mealDate),
      meal,
      mealLabel: MEAL_LABEL[meal],
      dishCount,
      photoCount,
    }
  }

  /**
   * 再点一次（F3-06）：把**某一餐整桌**照抄到另一天某一餐。
   *
   * 复用的是"点菜"这条链路（逐道调 `addItem`），所以"做好了不能再加菜""取消过的餐加菜会复活"
   * 这些语义两处完全一致——另写一段写库逻辑迟早会分叉（combos 的"整组加入"也是这个做法）。
   *
   * 三件事刻意这样定：
   * - **只允许从定局的那一餐复制**（`canRepeatFrom`）：做好了 / 已取消 / 日子过去了。
   *   还在收集中的那一餐要加菜，直接点那道菜就行，不必绕道"复制"；
   * - **备注不带过来**：备注是**那个人对那一餐**的交代（"小满那份不要辣"），
   *   照抄到另一餐会出现"一个人名下挂着一句他这次没说过的话"，甚至点名点到没参与的人；
   * - **已有的菜跳过**（`planRepeat`）：同一餐里同一道菜变两行、份数 ×2，是最容易被误当成两个人想吃的一道，
   *   所以这一步不是优化，是避免用户看不懂。
   */
  async repeat(
    userId: string,
    mealKey: string,
    input: { mealDate?: unknown; meal?: unknown },
  ): Promise<{ added: string[]; skipped: string[]; card: MealCardView; message?: string }> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.ORDER_CREATE)

    const { mealDate: sourceDate, meal: sourceMeal } = parseMealKey(mealKey)
    const targetDate = parseMealDate(input?.mealDate)
    const targetMeal = parseSlot(input?.meal)

    const source = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate: sourceDate, meal: sourceMeal } },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    })
    if (!source) throw new NotFoundException('这一餐还没有人点菜')
    if (!canRepeatFrom(source.status, dateKey(source.mealDate), todayKey())) {
      throw new ConflictException(
        `这一餐还在「${STATUS_LABEL[source.status]}」，等它定局（做好或取消）之后再照它点`,
      )
    }

    // 先按"插进去之后长什么样"解析来源的菜：自由菜品在插入时可能挂到同名菜谱上
    // （见 resolveItem），不先解析就会漏判、插出一条卡上看着重复的菜
    const sourceDishes: DishRef[] = []
    for (const item of source.items) {
      sourceDishes.push(await this.repeatDishOf(item))
    }

    const targetRow = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate: targetDate, meal: targetMeal } },
      include: { items: true },
    })
    const existing: DishRef[] = (targetRow?.items ?? []).map(item => ({ recipeId: item.recipeId, name: item.recipeName }))
    const { toAdd, skipped } = planRepeat(existing, sourceDishes)

    if (toAdd.length === 0) {
      /*
       * 全被跳过 = 目标那一餐本来就有这一桌菜，卡一定在（`existing` 非空才有可跳过的）。
       * 这里不做任何写入，只把"都已经有了"如实回给用户：点两次的结果一样（幂等）。
       */
      return {
        added: [],
        skipped: skipped.map(dish => dish.name),
        card: await this.card(targetRow!.id, userId),
        message: '这一餐里这桌菜都有了',
      }
    }

    // 整桌要么都进、要么都不进：先判定目标那一餐收不收新菜，别加到一半才发现"已做好了"
    await this.assertMealAcceptsItems(userId, targetDate, targetMeal)

    const targetKey = dateKey(targetDate)
    for (const dish of toAdd) {
      // `silent`：与"摇一桌"同一个理由——照抄一桌菜合成一条提醒（见 addItem 的说明）
      await this.addItem(
        userId,
        dish.recipeId
          ? { recipeId: dish.recipeId, mealDate: targetKey, meal: targetMeal }
          : { dishName: dish.name, mealDate: targetKey, meal: targetMeal },
        { silent: true },
      )
    }

    const finalRow = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate: targetDate, meal: targetMeal } },
      include: { items: { select: { id: true } } },
    })

    /*
     * 合成的那一条（"爸爸照上次那桌又点了一次"）。
     * 键取本次新建条目里最小的 id（与 `addItems` 同一个做法与理由）。
     */
    const anchor = (finalRow?.items ?? []).map((row) => row.id).sort()[0]
    if (anchor) {
      const key = mealKeyOf(targetDate, targetMeal)
      await this.notifications.recordChange(familyId, {
        kind: 'order',
        action: `照上次那桌又点了 ${toAdd.length} 道菜`,
        body: `加进${mealWhenLabel(targetDate, targetMeal)}了：${toAdd.slice(0, 3).map(dish => dish.name).join('、')}${toAdd.length > 3 ? ` 等 ${toAdd.length} 道` : ''}`,
        to: `/order/${key}`,
        mealKey: key,
        tag: '加菜',
        scope: `repeat:${anchor}`,
      }, userId)
    }

    return {
      added: toAdd.map(dish => dish.name),
      skipped: skipped.map(dish => dish.name),
      card: finalRow ? await this.card(finalRow.id, userId) : emptyCard(targetDate, targetMeal),
    }
  }

  /**
   * 来源那一餐里的一条菜，**按"它重新插进去会变成什么样"**给出它的身份。
   *
   * 挂到同名菜谱上这件事只有 `resolveItem` 知道（F3-10 的自由菜品与库里同名的菜合并成一行）。
   * 这里要是不走同一套判定，就会出现：来源里写着"番茄炒蛋"（自由菜品、库里也有同名菜谱），
   * 目标那一餐里已经有"番茄炒蛋"（点的是菜谱），跳过判定按两条不同的键算成"不一样"，
   * 于是插进去之后卡上出现两行同名的番茄炒蛋。
   */
  private async repeatDishOf(item: {
    recipeId: string | null
    recipeName: string
  }): Promise<DishRef> {
    if (item.recipeId) {
      const recipe = await this.prisma.recipe.findUnique({ where: { id: item.recipeId } })
      // 菜谱还在就用它现在的名字（改过名的历史点单也会跟着显示新的，与卡片视图一致）
      return recipe ? { recipeId: recipe.id, name: recipe.name } : { recipeId: item.recipeId, name: item.recipeName }
    }
    const matched = await this.prisma.recipe.findFirst({
      where: { name: item.recipeName },
      orderBy: { id: 'asc' },
    })
    return matched
      ? { recipeId: matched.id, name: matched.name }
      : { recipeId: null, name: item.recipeName }
  }

  /** 整餐状态流转（F3-02）：按目标状态要对应能力，且必须走状态机允许的一步 */
  async updateStatus(userId: string, mealKey: string, next: unknown): Promise<MealCardView> {    const target = parseStatus(next)
    const { familyId, role } = await this.requireMember(userId)

    const { mealDate, meal } = parseMealKey(mealKey)
    const mealOrder = await this.prisma.mealOrder.findUnique({ where: { familyId_mealDate_meal: { familyId, mealDate, meal } } })
    if (!mealOrder) throw new NotFoundException('这一餐还没有人点菜')

    if (!isAllowedTransition(mealOrder.status, target)) {
      throw new ConflictException(`「${STATUS_LABEL[mealOrder.status]}」不能直接变成「${STATUS_LABEL[target]}」`)
    }
    if (!can(role, TRANSITION_CAPABILITY[target] as never)) {
      throw new ForbiddenException('这个操作需要更高的家庭角色')
    }

    /*
     * 确认留痕（M4 / F4-05）：定下这一版菜单时记「谁、什么时候」；取消时清掉（这一版作废了）；
     * 开始做/做好了不动它（做的还是那一版菜单）。判据在 orders.rules 的 confirmStampFor，
     * 服务层只负责把它翻成写入的字段值——三岔的判断不写在这里，单测才钉得住。
     *
     * 「谁做好的」留痕（M10 / F10-02）与它是**同一时刻的第二件事**，所以一起写：
     * 分开两处的话迟早出现"状态是已做好、但没人认领"那种自相矛盾的行。
     */
    const stampFor = confirmStampFor(target)
    const stamp =
      stampFor === 'stamp'
        ? { confirmedById: userId, confirmedAt: new Date() }
        : stampFor === 'clear'
          ? { confirmedById: null, confirmedAt: null }
          : {}

    const doneFor = doneStampFor(target)
    const done =
      doneFor === 'stamp'
        ? { doneById: userId, doneAt: new Date() }
        : doneFor === 'clear'
          ? { doneById: null, doneAt: null }
          : {}

    await this.prisma.mealOrder.update({ where: { id: mealOrder.id }, data: { status: target, ...stamp, ...done } })

    /*
     * 「订单有变化」——**只报那两档还没有专门提醒的**（2026-10-16）：
     *
     * - `PLANNED`（选好了）与 `DONE`（做好了）**不在这里报**：它们各自已经有一条
     *   **状态型**提醒（`plan` / `done`，从 `confirmedAt` / `doneAt` 现算）——
     *   在这里再写一条事件型的，用户会为同一件事收到两条通知（"选了好了"+"选好了"）。
     *   这也是这一版**唯一**需要小心的地方：两条路各报各的，就会在重叠处翻倍；
     * - `COOKING`（开始做）与 `CANCELED`（取消这一餐）没有专门的提醒，在这里补上。
     *
     * 键带目标状态：取消 → 重新点菜 → 再取消，第二次的 mealKey 相同，
     * 但那时候 `MealOrder.id` 已经变了（取消后加菜是复活同一行、不是新建，所以这里用状态区分）——
     * 用 `status:<MealOrder.id>:<状态>` 两边都覆盖到：同一餐只取消一次，而"取消又取消"
     * 本来也不可能（第一次就已经是终态）。
     */
    if (target === 'COOKING' || target === 'CANCELED') {
      const key = mealKeyOf(mealOrder.mealDate, mealOrder.meal)
      await this.notifications.recordChange(familyId, {
        kind: 'order',
        action: target === 'COOKING'
          ? `开始做${mealWhenLabel(mealOrder.mealDate, mealOrder.meal)}了`
          : `取消了${mealWhenLabel(mealOrder.mealDate, mealOrder.meal)}`,
        body: target === 'COOKING' ? '这一餐下锅了' : null,
        to: `/order/${key}`,
        mealKey: key,
        tag: target === 'COOKING' ? '开做了' : '取消了',
        scope: `status:${mealOrder.id}:${target}`,
      }, userId)
    } else if (target === 'PLANNED' || target === 'DONE') {
      /*
       * 这两档走**另一条**：它们不写事件型提醒（上面那段说了为什么），
       * 但**仍然要推**——正开着应用的家里人得当场看到红点亮、卡片上多出「选好了」/「做好了」
       * 那个角标，而那两样都是从 `confirmedAt` / `doneAt` 现算的，重取一次就有。
       *
       * 少了这一步，菜单定下来/饭做好了这两件事在"两台都开着"的场景里**反而是最慢的**
       * （要等 60 秒的 `staleTime`），而那正是用户这次报的那个毛病。
       */
      await this.notifications.signalFamily(familyId, 'order', userId)
    }

    return this.card(mealOrder.id, userId)
  }

  /**
   * 点单列表（F3-01/03）。
   * `family=false`（只看我的）只返回我点过菜的餐次；`counts` 与卡片用**同一可见范围**统计，
   * 否则"只看我的"下徽标会显示别人的数量。
   */
  async list(
    userId: string,
    options: { family?: boolean; status?: string } = {},
  ): Promise<{
    cards: MealCardView[]
    counts: Record<string, number>
    scope: 'family' | 'mine'
    /** 三天之外（第 4～7 天）还有几餐安排——列表底下那句入口要不要给、说几餐，都按它 */
    beyondCount: number
  }> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.requireFamily(familyId)

    const status = options.status && options.status !== 'ALL' ? parseStatus(options.status) : undefined
    const mineOnly = options.family === false
    const scope = visibleToMember(family.shared, role)

    // 共享关闭时吃货只能看自己参与的餐次；掌勺人/帮厨要干活，仍看全量
    const scoped: Prisma.MealOrderWhereInput =
      scope === 'mine' ? { familyId, items: { some: { userId } } } : { familyId }

    /*
     * **只看今明后三天**（用户 2026-10-16：「这块永远就展示今明后三天的菜单，其余历史的都放入历史中」）。
     *
     * 三件事一起说清，否则很容易改错一头：
     * - **过去**的餐次本来就不在这儿（2026-10-15 起收窗，回看/删记录在**点单历史** F3-09 那边）；
     * - **三天之外（第 4～7 天）**是**能安排但列表不铺**：点菜窗口仍是一周（备菜计划要排满，
     *   见 `ORDER_DAY_SPAN`），把那几餐从列表里拿掉之后，它们只在备菜计划页里看得到——
     *   所以那一页每行的「点进去」必须落到**这一餐的详情**（曾经落的是列表，收窗后会点个空）；
     * - 于是这里再数一个 `beyondCount`：三天之外**真有**餐次时，前端在列表底下给一句
     *   「还有 N 餐在三天之外 · 去备菜计划」。真有才说，不猜也不编。
     *
     * 写在 **where 里而不是取回来再 filter**：计数徽标与卡片必须出自同一份可见范围，
     * 先取后筛在取数上限附近会分叉。
     */
    const window = listWindowDays()
    const from = dateOnly(window.from)
    const to = dateOnly(window.to)

    /*
     * **今天排最前、往后顺排**（用户 2026-10-15：「订单页的排序，要先展示今日的，不然还得下滑」）。
     *
     * 收窗之后最先要看的必然是最近那一餐，而原来是 `desc`（越远的越靠前）——"今天"被压在
     * 十几张卡下面，每次进这一页都得先往下滑。同一天里也按**午饭 → 晚饭**的自然顺序
     * （`meal` 枚举的声明顺序就是 LUNCH、DINNER，`asc` 正好是它）。
     *
     * `take` 由三天窗口天然兜住（最多 6 餐），留着只是防御脏数据。
     */
    // 一次取**不带状态筛选**的全部餐次：卡片按状态筛，但计数徽标必须给出每个状态的数量，
    // 否则点了「待确认」之后，其它状态的徽标会全变成 0，用户就没法切回去了。
    const [rows, beyondCount] = await Promise.all([
      this.prisma.mealOrder.findMany({
        where: { ...scoped, mealDate: { gte: from, lte: to } },
        include: MEAL_ORDER_INCLUDE,
        orderBy: [{ mealDate: 'asc' }, { meal: 'asc' }],
        take: 60,
      }),
      this.prisma.mealOrder.count({ where: { ...scoped, mealDate: { gt: to } } }),
    ])

    const allCards = rows
      .map(row => this.cardFromRow(row, userId, role, family.shared))
      .filter(card => (mineOnly ? card.mineCount > 0 : true))

    const counts: Record<string, number> = { ALL: allCards.length }
    for (const statusKey of ORDER_STATUSES) {
      counts[statusKey] = allCards.filter(card => card.status === statusKey).length
    }

    const cards = status ? allCards.filter(card => card.status === status) : allCards
    return { cards, counts, scope: mineOnly ? 'mine' : 'family', beyondCount }
  }

  /** 单张卡片（点菜/撤回/流转后回传，前端据此刷新缓存） */
  async card(mealOrderId: string, viewerId: string): Promise<MealCardView> {
    const { familyId, role } = await this.requireMember(viewerId)
    const [family, row] = await Promise.all([
      this.requireFamily(familyId),
      this.prisma.mealOrder.findUnique({ where: { id: mealOrderId }, include: MEAL_ORDER_INCLUDE }),
    ])
    if (!row || row.familyId !== familyId) throw new NotFoundException('这一餐不存在了')
    return this.cardFromRow(row, viewerId, role, family.shared)
  }

  /**
   * 某一餐的详情（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
   *
   * 按 `mealKey` 取而不是按行 id：`mealKey`（`2026-10-13-DINNER`）是前端**已经在用**的
   * 稳定标识（流转接口、缓存键都是它），通知里的去处也带着它——详情页因此能直接由
   * 地址栏里的那一段取数，刷新、分享、从通知点进来都成立（用行 id 就得先有一份映射）。
   *
   * **可见性必须与列表一字不差**：共享开关关掉时，吃货看不到自己没参与的餐次——
   * 详情页若不守这条，就出现"列表里没有、直接输地址却看得到"的洞。
   * 所以这里复刻的是列表那一句判据（`items.some(userId)`）本身，**不是**"差不多的口径"：
   * 只要详情放行的比列表多一条，那个洞就存在。
   */
  async detail(userId: string, mealKey: string): Promise<MealCardView> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.requireFamily(familyId)
    const { mealDate, meal } = parseMealKey(mealKey)

    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
      include: MEAL_ORDER_INCLUDE,
    })
    if (!row) throw new NotFoundException('这一餐还没有人点菜')

    if (visibleToMember(family.shared, role) === 'mine' && !row.items.some(item => item.userId === userId)) {
      throw new NotFoundException('这一餐还没有人点菜')
    }
    return this.cardFromRow(row, userId, role, family.shared)
  }

  /**
   * 设定就餐人数（M4 / F4-05）：含**没点菜只吃饭的家人**，所以它和"有几个人点了菜"是两回事。
   * 需要 `menu.manage`（与安排菜单同一批人）。传 null/空 = 清除设定。
   */
  async setDiners(userId: string, mealKey: string, raw: unknown): Promise<MealCardView> {
    const count = parseDinerCount(raw)
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.MENU_MANAGE)

    const { mealDate, meal } = parseMealKey(mealKey)
    const mealOrder = await this.prisma.mealOrder.findUnique({ where: { familyId_mealDate_meal: { familyId, mealDate, meal } } })
    if (!mealOrder) throw new NotFoundException('这一餐还没有人点菜')

    await this.prisma.mealOrder.update({ where: { id: mealOrder.id }, data: { dinerCount: count } })

    /*
     * 「订单有变化」：人数改了（用户 2026-10-16）。
     * 键里带**改成了几**：同一个人把 4 改成 5 再改回 4，第二次不重复提醒——
     * 那是同一个事实（"这一餐 4 个人吃"），不是两件事（与"加菜/撤菜"不同：
     * 那些是**动作**，动作做两次就是两次）。
     */
    await this.notifications.recordChange(familyId, {
      kind: 'order',
      action: count === null
        ? `清掉了${mealWhenLabel(mealDate, meal)}的人数`
        : `把${mealWhenLabel(mealDate, meal)}改成 ${count} 人吃`,
      body: null,
      to: `/order/${mealKey}`,
      mealKey,
      tag: '改人数',
      scope: `diners:${mealOrder.id}:${count ?? 'none'}`,
    }, userId)

    return this.card(mealOrder.id, userId)
  }

  /**
   * 今日安排（M4 / F4-01）：厨房页那一块。
   *
   * 只回**今天**的两餐（午餐、晚餐），没点菜的那一餐也给一行（`state: 'none'`）——
   * 首页要能一眼看出"晚饭还没人点"，而不是让那一行凭空消失。
   * 可见性沿用列表那一套（共享关闭 + 吃货 → 只看自己参与的餐次）。
   */
  async today(userId: string): Promise<{ date: string; rows: MealProgressRow[] }> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.requireFamily(familyId)
    const date = todayKey()

    const rows = await this.prisma.mealOrder.findMany({
      where: { familyId, mealDate: dateOnly(date) },
      include: MEAL_ORDER_INCLUDE,
    })
    const byMeal = new Map(rows.map(row => [row.meal, row]))

    return {
      date,
      rows: MEAL_SLOTS.map(slot =>
        this.mealProgress(byMeal.get(slot), slot, date, userId, role, family.shared, '还没人点'),
      ),
    }
  }

  /**
   * 本周菜单（M4 / F4-02）：从今天起 `days` 天，每天午晚两餐各一行。
   *
   * 与今日安排同一份数据、同一套可见性，只是把窗口从 1 天摊成 N 天——
   * 发现页要能一眼看出"明天晚饭还没安排"，并就地给个去安排的入口。
   * 返回 `scope`：共享关闭时吃货看到的是收窄后的空行，前端要说清原因（见 CheckInPage 的同款提示）。
   */
  async plan(userId: string, rawDays?: unknown): Promise<{ scope: 'family' | 'mine'; days: PlanDayRow[] }> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.requireFamily(familyId)

    const window = dayWindow(parsePlanDays(rawDays))
    const first = dateOnly(window[0].value)
    const last = dateOnly(window[window.length - 1].value)

    const rows = await this.prisma.mealOrder.findMany({
      where: { familyId, mealDate: { gte: first, lte: last } },
      include: MEAL_ORDER_INCLUDE,
    })
    const byKey = new Map(rows.map(row => [`${dateKey(row.mealDate)}-${row.meal}`, row]))

    return {
      scope: visibleToMember(family.shared, role),
      days: window.map(day => ({
        date: day.value,
        label: day.label,
        weekday: day.weekday,
        meals: MEAL_SLOTS.map(slot =>
          this.mealProgress(byKey.get(`${day.value}-${slot}`), slot, day.value, userId, role, family.shared, '还没安排'),
        ),
      })),
    }
  }

  /** 点单口径（免登录可读，与 /family/options 同理）：前端不硬编码餐次、状态与可选日期 */
  options() {
    return {
      meals: MEAL_SLOTS.map(value => ({ value, label: MEAL_LABEL[value] })),
      statuses: ORDER_STATUSES.map(value => ({ value, label: STATUS_LABEL[value] })),
      dayOptions: dayOptions(),
    }
  }

  /**
   * 点单历史（F3-09）：按**日期区间**给一页（默认最近 31 天），并告诉前端还能不能往前翻。
   *
   * 与 `list()` 的分工：那边是"接下来要处理的单子"（今天起最近的 60 张，含状态筛选与计数徽标），
   * 这边是"回看过去"，所以
   * - **不设条数上限**（只按天区间查）：R-19 记的就是"超过 60 张就看不见了"，
   *   再给一个同样有上限的接口等于没解决；
   * - **按天铺开**（`days` 里每一天都给一行，没记录的那天是空行）：日历视图要能看出
   *   "这天家里没安排"，缺行和空行在界面上是两回事；
   * - **可见性沿用同一套**（共享关闭 + 吃货 → 只看自己参与的餐次），与列表一致。
   */
  async history(
    userId: string,
    raw: { to?: unknown; pageSize?: unknown } = {},
  ): Promise<{
    scope: 'family' | 'mine'
    from: string
    to: string
    pageSize: number
    hasMore: boolean
    days: { date: string; weekday: string; meals: MealProgressRow[] }[]
  }> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.requireFamily(familyId)
    const query = parseHistoryQuery(raw)
    const range = historyRange(query)
    const scope = visibleToMember(family.shared, role)

    const scoped: Prisma.MealOrderWhereInput =
      scope === 'mine' ? { familyId, items: { some: { userId } } } : { familyId }

    const rows = await this.prisma.mealOrder.findMany({
      where: {
        ...scoped,
        mealDate: { gte: dateOnly(range.from), lte: dateOnly(range.to) },
      },
      include: MEAL_ORDER_INCLUDE,
      orderBy: [{ mealDate: 'desc' }, { meal: 'desc' }],
    })
    const byKey = new Map(rows.map(row => [`${dateKey(row.mealDate)}-${row.meal}`, row]))

    // 还能不能往前翻：库里还有比这一页更早的餐次才算有（见 hasEarlier 的说明）
    const earliest = await this.prisma.mealOrder.findFirst({
      where: scoped,
      orderBy: { mealDate: 'asc' },
      select: { mealDate: true },
    })

    return {
      scope,
      from: range.from,
      to: range.to,
      pageSize: query.pageSize,
      hasMore: hasEarlier(earliest ? dateKey(earliest.mealDate) : null, range.from),
      // 新的在前（与列表同一个读法：越近的越该先看到）
      days: [...range.days].reverse().map(date => ({
        date,
        weekday: weekdayOf(date),
        meals: MEAL_SLOTS.map(slot =>
          this.mealProgress(byKey.get(`${date}-${slot}`), slot, date, userId, role, family.shared, '没有安排'),
        ),
      })),
    }
  }

  // ---------- 内部 ----------

  /**
   * 一餐的进度行（今日安排与本周菜单共用，见 orders.rules 的 MealProgressRow）。
   * `emptyLabel` 是"还没成卡"那行的文案：厨房页说「还没人点」，本周菜单说「还没安排」。
   */
  private mealProgress(
    row: MealOrderRow | undefined,
    slot: MealSlot,
    date: string,
    viewerId: string,
    role: FamilyRole,
    shared: boolean,
    emptyLabel: string,
  ): MealProgressRow {
    const base = {
      meal: slot,
      label: MEAL_LABEL[slot],
      mealKey: `${date}-${slot}`,
      dinerCount: row?.dinerCount ?? null,
    }
    if (!row) {
      return {
        ...base, state: 'none', status: null, statusLabel: emptyLabel,
        dishes: [], dishCount: 0, ordererCount: 0, photoCount: 0, canAdd: true,
      }
    }
    const card = this.cardFromRow(row, viewerId, role, shared)
    // 共享关闭时吃货看不到别人点的菜，那一餐对他就是"没有内容"。
    // 这里把它**做成与"真的没人安排"完全不可区分**：状态、人数、道数、菜名全部退回空，
    // 连底层 `status` 都不给（给了 PENDING 就等于承认"有人张罗了这一餐"）。
    // 口径是"宁可少说"（见 D-024），代价是这个人会以为家里没张罗——
    // 所以视图层要**明说共享被关了**（前端拿 `scope === 'mine'` 出提示，同打卡墙的做法）。
    const hiddenFromMe = visibleToMember(shared, role) === 'mine' && card.mineCount === 0
    return {
      ...base,
      dinerCount: hiddenFromMe ? null : base.dinerCount,
      state: hiddenFromMe ? 'none' : todayMealState(row.status),
      status: hiddenFromMe ? null : row.status,
      statusLabel: hiddenFromMe ? emptyLabel : STATUS_LABEL[row.status],
      dishes: hiddenFromMe ? [] : card.dishes.map(dish => dish.count > 1 ? `${dish.name} ×${dish.count}` : dish.name),
      dishCount: hiddenFromMe ? 0 : card.dishCount,
      ordererCount: hiddenFromMe ? 0 : card.ordererCount,
      photoCount: hiddenFromMe ? 0 : card.photoCount,
      // 「加菜」按钮出不出现：**按真实状态算，不跟着 hiddenFromMe 走**——他看不到别人点的菜，
      // 不代表他不能往这一餐里加自己想吃的那道（加菜走 order.create，人人都有）。
      // 跟着隐藏逻辑走的话，共享一关这个人连菜都点不了了。
      canAdd: canAddItem(row.status),
    }
  }

  private cardFromRow(row: MealOrderRow, viewerId: string, role: FamilyRole, shared: boolean): MealCardView {
    const aggregated = aggregateItems(row.items as AggregateItem[], viewerId)
    // 成品照张数与照片本身的可见范围一致：共享关闭时吃货不该从"张数"上看到别人传了几张
    // （打卡照片的可见性口径见 D-023 与 checkins 模块）
    const visiblePhotos = row.checkIns.filter(photo => photoVisibleTo(shared, role, viewerId, photo.userId))
    return {
      mealKey: mealKeyOf(row.mealDate, row.meal),
      date: dateKey(row.mealDate),
      meal: row.meal,
      mealLabel: MEAL_LABEL[row.meal],
      status: row.status,
      statusLabel: STATUS_LABEL[row.status],
      orderers: aggregated.orderers,
      ordererCount: aggregated.orderers.length,
      dishCount: aggregated.dishCount,
      dishes: aggregated.dishes,
      photoCount: visiblePhotos.length,
      items: row.items.map(item => ({
        id: item.id,
        recipeId: item.recipeId,
        name: item.recipeName,
        image: item.recipeImage,
        userId: item.userId,
        nickname: item.user.nickname,
        avatar: item.user.avatar,
        isMe: item.userId === viewerId,
        note: item.note,
        createdAt: item.createdAt.toISOString(),
      })),
      mineCount: aggregated.mineCount,
      dinerCount: row.dinerCount,
      // 确认留痕（M4 / F4-05）：走的是列表与单卡共用的 MEAL_ORDER_INCLUDE，所以每个视图都带得上
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      // 「谁做的这餐」（M10 / F10-02）：与"谁定的"并列下发，详情页把两件事分开说
      doneBy: row.doneBy,
      doneAt: row.doneAt?.toISOString() ?? null,
      // 能不能拿这一餐去「再点一次」（F3-06）：口径只有 canRepeatFrom 一份，前端不复刻
      canRepeat: canRepeatFrom(row.status, dateKey(row.mealDate), todayKey()),
      /*
        这一餐还收不收新菜（详情页的「再加一道」按它决定出不出现）。
        与备菜计划那一行的 `canAdd` 是**同一个判据的同一个值**（`canAddItem`）——
        详情页原来没有它，前端就只好自己看状态推，而这种"推出来的第二份规则"迟早与后端分叉。
      */
      canAdd: canAddItem(row.status),
      nextActions: nextActionsFor(role, row.status),
      submittedAt: row.createdAt.toISOString(),
    }
  }

  private async requireMember(userId: string): Promise<{ familyId: string; role: FamilyRole }> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) throw new NotFoundException('先加入家庭，才能和家里一起点菜')
    return { familyId: membership.familyId, role: membership.role as FamilyRole }
  }

  private async requireCapability(userId: string, capability: string): Promise<{ familyId: string; role: FamilyRole }> {
    const membership = await this.requireMember(userId)
    if (!can(membership.role, capability as never)) throw new ForbiddenException('这个操作需要更高的家庭角色')
    return membership
  }

  private async requireFamily(familyId: string) {
    const family = await this.prisma.family.findUnique({ where: { id: familyId } })
    if (!family) throw new NotFoundException('家庭不存在')
    return family
  }

  /** 取已有的一餐，没有就建。并发下靠唯一约束（familyId+date+meal）挡重复 */
  private async ensureMealOrder(familyId: string, mealDate: Date, meal: MealSlot) {
    const where = { familyId_mealDate_meal: { familyId, mealDate, meal } }
    const existing = await this.prisma.mealOrder.findUnique({ where })
    if (existing) return existing
    try {
      return await this.prisma.mealOrder.create({ data: { familyId, mealDate, meal } })
    } catch (error) {
      // 两个人同时点同一餐会同时走到这里：唯一约束让其中一个失败，重查即可
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.mealOrder.findUnique({ where })
        if (row) return row
      }
      throw error
    }
  }
}

/** 撤掉最后一份菜后卡片已被删除，返回一张空卡让前端能正常替换缓存 */
function emptyCard(mealDate: Date, meal: MealSlot): MealCardView {
  return {
    mealKey: mealKeyOf(mealDate, meal),
    date: dateKey(mealDate),
    meal,
    mealLabel: MEAL_LABEL[meal],
    status: 'PENDING',
    statusLabel: STATUS_LABEL.PENDING,
    orderers: [],
    ordererCount: 0,
    dishCount: 0,
    dishes: [],
    items: [],
    mineCount: 0,
    dinerCount: null,
    // 卡都空了，留痕自然也没有（撤回最后一份菜会把整餐删掉，见 removeItem）
    confirmedBy: null,
    confirmedAt: null,
    doneBy: null,
    doneAt: null,
    photoCount: 0,
    // 空卡没内容可照抄，不给这个入口
    canRepeat: false,
    // 空卡就是"还没人点"（PENDING），当然收新菜
    canAdd: true,
    nextActions: [],
    submittedAt: new Date().toISOString(),
  }
}
