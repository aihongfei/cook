import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { MealSlot, OrderStatus, Prisma } from '@prisma/client'
import type { FamilyRole } from '../family/family.roles'
import { CombosService } from '../combos/combos.service'
import { FavoritesService } from '../favorites/favorites.service'
import { FridgeService } from '../fridge/fridge.service'
import { OrdersService } from '../orders/orders.service'
import { RecipeWriteService } from '../recipes/recipe-write.service'
import { STATUS_LABEL, dateKey, dateOnly, parseMealKey, visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import { describeWhen, todayKey, allowedDates } from './ai.tools'
import {
  AI_ACTION_COMBO_CREATE,
  AI_ACTION_COMBO_REMOVE,
  AI_ACTION_COMBO_UPDATE,
  AI_ACTION_FAVORITE_OFF,
  AI_ACTION_FAVORITE_ON,
  AI_ACTION_FRIDGE_CREATE,
  AI_ACTION_FRIDGE_REMOVE,
  AI_ACTION_FRIDGE_UPDATE,
  AI_ACTION_MEAL_DINERS,
  AI_ACTION_MEAL_STATUS,
  AI_ACTION_MENU_ADD,
  AI_ACTION_MENU_REMOVE,
  AI_ACTION_RECIPE_CREATE,
  AI_ACTION_RECIPE_REMOVE,
  AI_ACTION_RECIPE_UPDATE,
  describeFridgeItem,
  menuUndoTarget,
  planUndo,
  removedItemKey,
  undoLabel,
  type ComboState,
  type FridgeSnapshot,
  type MenuOrderSnapshot,
  type RecipeSnapshot,
  type UndoContext,
  type UndoPlan,
} from './ai-action.rules'
import type { FridgeDraft } from './ai.tools'

/**
 * AI 助手**真的写库**的那一半（F16-10 / D-052 的 A 档）。
 *
 * 三件事刻意：
 *
 * ① **走的是用户自己那套冰箱服务**（`FridgeService`），不是另写一份写库逻辑。
 *    这样"AI 记的食材"与"用户手记的"在数据、校验、权限上没有半点区别——
 *    D-026 决定二当初就是为这个（不搞第二套权限口径），A 档沿用同一条线。
 *    典型证据：重复录入同样会撞上"已经记了一条"的 409，AI 也得照实告诉用户。
 *
 * ② **每笔写库都留一条 AiAction**：撤销要有据可查（见 ai-action.rules 的说明）。
 *    记录与写库**不放在同一个事务里**——这一点是刻意的：事务回滚掉写库却留下记录
 *    （或反过来）都更糟；这里选择"先写库、成功了再记"，记录失败只是撤不了，
 *    而用户的数据是对的。反过来（先记录后写库）失败的话，用户会看到一张"已记录但
 *    什么也没发生"的回执卡，那是在骗人。
 *
 * ③ **回执卡的内容在这里拼好**（`summary`）：前端不自己拼——它拼不出"改之前是什么"，
 *    而撤销按钮上那句话要让人明白撤的是什么。
 */
@Injectable()
export class AiActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fridge: FridgeService,
    // 菜谱与收藏**都走用户自己那套服务**（与冰箱同一个规矩）：
    // "只能改自家上传的"那道边界只写在 recipe.rules 里，AI 自动继承
    private readonly recipes: RecipeWriteService,
    private readonly favorites: FavoritesService,
    // 菜单与组合同样走用户自己那套（"这一餐收不收新菜""只有自己点的能撤""canEditCombo"）
    private readonly orders: OrdersService,
    private readonly combos: CombosService,
  ) {}

  /** AI 往冰箱里记东西。返回给模型看的短句（成功与失败都要说人话） */
  async addFridgeItems(userId: string, drafts: FridgeDraft[]): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId)
    const done: AiReceipt[] = []
    const failed: string[] = []

    for (const draft of drafts) {
      try {
        // 与手写同一条路：valid 校验、同名同区 409 都在里边
        await this.fridge.add(userId, {
          name: draft.name,
          amount: draft.amount,
          zone: draft.zone,
          expiresOn: draft.expiresOn,
          note: draft.note,
        })
        // 拿真实那条（id 与归一之后的值），撤销要用
        const item = await this.prisma.fridgeItem.findFirst({
          where: { familyId, name: draft.name },
          orderBy: { createdAt: 'desc' },
        })
        if (!item) continue
        const summary = describeFridgeItem({ name: item.name, amount: item.amount, zone: item.zone })
        const action = await this.prisma.aiAction.create({
          data: {
            familyId,
            actorId: userId,
            kind: AI_ACTION_FRIDGE_CREATE,
            summary,
            undoData: { itemId: item.id },
            targetId: item.id,
          },
        })
        done.push({ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: item.id })
      } catch (error) {
        // 一样失败不该带走整批："买了鸡蛋牛奶"里牛奶已经记过，鸡蛋仍该进去
        failed.push(`${draft.name}：${humanError(error)}`)
      }
    }

    const lines = [
      done.length ? `已记下：${done.map((item) => item.summary).join('、')}` : '',
      failed.length ? `没记成：${failed.join('；')}` : '',
    ].filter(Boolean)
    return { summary: lines.join('\n') || '（没有要记的东西）', actions: done }
  }

  /** AI 改冰箱里的一条。改动前先把原值记下来，撤销才有得回退 */
  async updateFridgeItem(userId: string, itemId: string, patch: Partial<FridgeDraft>): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId)
    const before = await this.prisma.fridgeItem.findUnique({ where: { id: itemId } })
    if (!before || before.familyId !== familyId) {
      return { summary: `没找到这条（id: ${itemId}），请先调 read_fridge 拿准确 id`, actions: [] }
    }

    await this.fridge.update(userId, itemId, {
      name: patch.name,
      amount: patch.amount,
      zone: patch.zone,
      expiresOn: patch.expiresOn,
      note: patch.note,
    })
    const after = await this.prisma.fridgeItem.findUnique({ where: { id: itemId } })
    if (!after) return { summary: '改完之后这条不见了，请重试', actions: [] }

    /*
     * `before`/`after` 只记**模型这次动过的字段**（`patch` 里有 key 的那些）。
     * 全字段都记的话，"用户改过数量"会被误判成"与 AI 写下时不一致"——
     * 撤销本来该允许的（AI 只动了保质期，数量是用户自己后来改的），
     * 却因为快照里带着数量而拒绝。
     */
    const fields = Object.keys(patch).filter((key) => key !== 'itemId') as (keyof FridgeDraft)[]
    // 返回类型得写死成 `string | null`：`Record<string, unknown>` 喂不进 Prisma 的 JSON 列
    // （InputJsonValue 不接受 unknown），而这里每个字段本来就只可能是这两种。
    const pick = (row: typeof before): Record<string, string | null> => {
      const out: Record<string, string | null> = {}
      for (const field of fields) {
        if (field === 'expiresOn') out[field] = row.expiresOn ? row.expiresOn.toISOString().slice(0, 10) : null
        else out[field] = row[field as 'name' | 'amount' | 'zone' | 'note'] ?? null
      }
      return out
    }
    const summary = describeFridgeItem({ name: after.name, amount: after.amount, zone: after.zone })
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_FRIDGE_UPDATE,
        summary,
        undoData: { itemId, before: pick(before), after: pick(after) },
        targetId: itemId,
      },
    })
    return {
      summary: `已改：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: itemId }],
    }
  }

  /** AI 把冰箱里的一条拿掉。原样记下来，撤销就是照原样重建 */
  async removeFridgeItem(userId: string, itemId: string): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId)
    const item = await this.prisma.fridgeItem.findUnique({ where: { id: itemId } })
    if (!item || item.familyId !== familyId) {
      return { summary: `没找到这条（id: ${itemId}），请先调 read_fridge 拿准确 id`, actions: [] }
    }

    await this.fridge.remove(userId, itemId)
    const summary = describeFridgeItem({ name: item.name, amount: item.amount, zone: item.zone })
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_FRIDGE_REMOVE,
        summary,
        undoData: {
          item: {
            name: item.name,
            amount: item.amount,
            zone: item.zone,
            expiresOn: item.expiresOn ? item.expiresOn.toISOString().slice(0, 10) : null,
            note: item.note,
          },
        },
        targetId: item.id,
      },
    })
    return {
      summary: `已拿掉：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: itemId }],
    }
  }

  /**
   * 撤销一笔。**在服务端核对**（用户 2026-10-13 拍板加表就是为了这个）：
   * 用户改过、那条已经不在了、已经撤过一次，三种情况都要判，且都要给一句人话。
   */
  async undo(userId: string, actionId: string): Promise<{ message: string; undone: boolean }> {
    const action = await this.prisma.aiAction.findUnique({ where: { id: actionId } })
    if (!action) throw new NotFoundException('这笔记录不在了')
    // 只有让 AI 干这事的人能撤（家里别人不能替你撤）
    if (action.actorId !== userId) throw new ForbiddenException('这笔不是你让 AI 做的，撤不了')

    const { plan, verdict } = planUndo(
      { id: action.id, kind: action.kind, undoData: action.undoData, undoneAt: action.undoneAt, targetId: action.targetId },
      await this.undoContext(action),
    )
    if (verdict.type === 'refused') throw new ConflictException(verdict.reason)
    if (verdict.type === 'already') {
      // 结果已经达成：**照样标记已撤**——否则用户会一直看到那个还能点的按钮
      await this.prisma.aiAction.update({ where: { id: action.id }, data: { undoneAt: new Date() } })
      return { message: verdict.message, undone: false }
    }

    await this.runPlan(userId, plan as UndoPlan)
    await this.prisma.aiAction.update({ where: { id: action.id }, data: { undoneAt: new Date() } })
    return { message: `已撤销：${action.summary}`, undone: true }
  }

  /**
   * 撤销要看的那份"现状"——**按动作种类分别查**（这是撤销判定最容易搞错的一处）。
   *
   * 两种极端都必须分清：
   * - 撤「增」「改」问的是**那条还在不在**：按 id 查，查不到就是"已经不在了"；
   * - 撤「删」（冰箱那条）问的是**它回来了没有**：按 id 查毫无意义（那个 id 就是被删掉的那条、
   *   必然查不到），得按唯一约束的键（同名同区）查。见 `removedItemKey` 的说明。
   * - 撤「删菜谱」又不同：菜谱有稳定 id，"它还在不在"就按 id 查（重建过就是还在）；
   * - 收藏压根没有"那条在不在"的问题，只需要当前**收没收藏**。
   */
  private async undoContext(action: {
    kind: string
    familyId: string
    targetId: string | null
    undoData: unknown
    actorId: string
  }): Promise<UndoContext> {
    if (action.kind.startsWith('favorite.')) {
      const recipeId = favoriteRecipeId(action.undoData)
      if (!recipeId) return { entity: 'favorite', favorited: false }
      const row = await this.prisma.favorite.findUnique({
        where: { userId_recipeId: { userId: action.actorId, recipeId } },
        select: { id: true },
      })
      return { entity: 'favorite', favorited: row !== null }
    }
    if (action.kind.startsWith('recipe.')) {
      // 撤「删菜谱」与其他的查法一样（都是按 id），差别在 planUndo 怎么解释它
      const row = action.targetId
        ? await this.prisma.recipe.findUnique({ where: { id: action.targetId } })
        : null
      return { entity: 'recipe', recipe: row ? recipeSnapshot(row) : null }
    }
    if (action.kind === AI_ACTION_FRIDGE_REMOVE) {
      return { entity: 'fridge', item: await this.byNameAndZone(action.familyId, action.undoData) }
    }
    if (action.kind === AI_ACTION_MENU_ADD) {
      /*
       * 撤"加菜"要看那条还在不在**以及那一餐还能不能动**：
       * 那一餐安排定了、或那条是别人点的，planUndo 都会拒——判据在纯函数里，
       * 这里只负责把现状查准（`ownedByActor` 说的就是"能不能撤"）。
       */
      const row = action.targetId
        ? await this.prisma.orderItem.findUnique({ where: { id: action.targetId }, include: { mealOrder: true } })
        : null
      return {
        entity: 'menuItem',
        item: row
          ? { id: row.id, mealStatus: row.mealOrder.status, ownedByActor: row.userId === action.actorId }
          : null,
      }
    }
    if (action.kind === AI_ACTION_MENU_REMOVE || action.kind === AI_ACTION_MEAL_DINERS) {
      return { entity: 'menuOrder', order: await this.menuOrderSnapshot(action.familyId, action.undoData) }
    }
    if (action.kind.startsWith('combo.')) {
      const row = action.targetId
        ? await this.prisma.combo.findUnique({
          where: { id: action.targetId },
          include: { items: { orderBy: { position: 'asc' }, select: { recipeId: true } } },
        })
        : null
      return {
        entity: 'combo',
        combo: row
          ? { id: row.id, name: row.name, note: row.note, recipeIds: row.items.map((item) => item.recipeId) }
          : null,
      }
    }
    return { entity: 'fridge', item: await this.currentSnapshot(action.targetId) }
  }

  /**
   * 撤「菜单」相关那几笔时要看的那一餐现在长什么样。
   *
   * 三件事一次查清（它们在 `planUndo` 里各是一条判据）：**这道菜在不在**、
   * **这一餐什么状态**、**那一天还在点菜窗口里吗**。分三次查会把"同一时刻的现状"
   * 拆成三个瞬间——并发下可能互相矛盾，一次查出来才说得通。
   */
  private async menuOrderSnapshot(familyId: string, undoData: unknown): Promise<MenuOrderSnapshot> {
    const target = menuUndoTarget(undoData)
    if (!target) return { hasDish: false, status: null, inWindow: false, dinerCount: null, exists: false }
    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate: dateOnly(target.mealDate), meal: target.meal } },
      include: { items: true },
    })
    const hasDish = row
      ? row.items.some((item) => (target.dish.recipeId
        ? item.recipeId === target.dish.recipeId
        : item.recipeName === target.dish.recipeName))
      : false
    return {
      hasDish,
      status: row?.status ?? null,
      // 窗口按"今天起 ORDER_DAY_SPAN 天"算，与 orders.rules 的 parseMealDate 同源
      inWindow: allowedDates(todayKey()).includes(target.mealDate),
      dinerCount: row?.dinerCount ?? null,
      exists: row !== null,
    }
  }

  /** 这个家现有的组合 id（新建之后要靠它找出"刚建的是哪一个"——组合没有稳定的业务键） */
  private async comboIds(familyId: string): Promise<string[]> {
    const rows = await this.prisma.combo.findMany({ where: { familyId }, select: { id: true } })
    return rows.map((row) => row.id)
  }

  /** 一个组合现在的样子（撤销要拿它核对用户有没有改过） */
  private async comboState(comboId: string): Promise<ComboState | null> {
    const row = await this.prisma.combo.findUnique({
      where: { id: comboId },
      include: { items: { orderBy: { position: 'asc' }, select: { recipeId: true } } },
    })
    if (!row) return null
    return { name: row.name, note: row.note, recipeIds: row.items.map((item) => item.recipeId) }
  }

  /*
   * ---------- 自建菜谱三件（F1-11 / F1-12）----------
   *
   * 与冰箱三件形状一致（真的写库 + 记一条可撤的记录），但**不吞错误**：
   * 冰箱那边"一批里一条失败不带走整批"是为了一次记好几样；菜谱每次只写一道，
   * 失败就该原样抛出去（模型据此如实告诉用户），而不是返回一个"没记成"让它自己猜。
   */

  /** AI 新建一道自建菜谱 */
  async createRecipe(userId: string, raw: unknown): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能往「我家的菜谱」里存')
    const created = await this.recipes.create(userId, raw)
    const summary = `菜谱「${created.name}」`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_RECIPE_CREATE,
        summary,
        // 撤"新建"要删掉它，只需 id；但也记一份当时的样子——撤销时用它判"用户有没有自己改过"
        undoData: {
          recipeId: created.id,
          after: recipeComparable(created),
        } as unknown as Prisma.InputJsonValue,
        targetId: created.id,
      },
    })
    return {
      summary: `已存进「我家的菜谱」：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: created.id }],
    }
  }

  /** AI 改一道自建菜谱（只改模型真的传了的字段） */
  async updateRecipe(userId: string, recipeId: string, patch: Record<string, unknown>): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能改自家菜谱')
    const before = await this.prisma.recipe.findUnique({ where: { id: recipeId } })
    if (!before || before.familyId !== familyId) {
      return { summary: `没找到这道自家菜谱（id: ${recipeId}），请先调 read_recipes 拿准确 id`, actions: [] }
    }

    const updated = await this.recipes.update(userId, recipeId, patch)
    const summary = `菜谱「${updated.name}」`

    /*
     * `before`/`after` **只记模型这次动过的字段**（与冰箱那条同一个理由，见那里的说明）：
     * 全字段都记的话，"用户改过备注"会被误判成"与 AI 写下时不一致"而拒绝撤销——
     * 而那次撤销本来该允许（AI 只改了做法，备注是用户自己改的）。
     */
    const fields = Object.keys(patch)
    const pick = (recipe: typeof before) => recipeFields(recipe, fields)
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_RECIPE_UPDATE,
        summary,
        undoData: { recipeId, before: pick(before), after: pick(updated as never) } as unknown as Prisma.InputJsonValue,
        targetId: recipeId,
      },
    })
    return {
      summary: `已改：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: recipeId }],
    }
  }

  /** AI 删一道自建菜谱。**整行都记下来**（重建时少一个字段就少一样东西） */
  async removeRecipe(userId: string, recipeId: string): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能删自家菜谱')
    const row = await this.prisma.recipe.findUnique({ where: { id: recipeId } })
    if (!row || row.familyId !== familyId) {
      return { summary: `没找到这道自家菜谱（id: ${recipeId}），请先调 read_recipes 拿准确 id`, actions: [] }
    }
    await this.recipes.remove(userId, recipeId)
    const summary = `菜谱「${row.name}」`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_RECIPE_REMOVE,
        // 回执上要让人一眼看出"删的是什么"，所以带菜名（冰箱那条是"名字 · 数量 · 区"）
        summary,
        undoData: {
          recipe: {
            id: row.id,
            name: row.name,
            category: row.category,
            cuisine: row.cuisine,
            tags: row.tags as string[],
            aliases: row.aliases as string[],
            ingredients: row.ingredients as unknown as { name: string; amount: string }[],
            steps: row.steps as string[],
            notes: row.notes as string[],
            calories: row.calories,
            // 重建后仍归这个家/这个人：不带上就会变成一条"全局菜谱"（谁都改不了、别人也看得见）
            familyId: row.familyId,
            createdById: row.createdById,
            searchText: row.searchText,
          },
        } as unknown as Prisma.InputJsonValue,
        targetId: recipeId,
      },
    })
    return {
      summary: `已删：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: recipeId }],
    }
  }

  /*
   * ---------- 收藏（F1-09）----------
   * 收藏是**一个人的开关**，只影响自己，所以与冰箱同档（直接改 + 可撤）。
   */

  /** AI 收藏/取消收藏一道菜。返回**动作之后的状态**，让模型能如实回话 */
  async toggleFavorite(userId: string, recipeId: string): Promise<{ summary: string; actions: AiReceipt[]; favorited: boolean }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能收藏')
    /*
     * 先查当前状态：`toggle` 是"反一下"，而撤销要知道"反之前是什么"。
     * 查完再 toggle 之间理论上可能被用户自己点一下（双端并发），那种情况下
     * 记录里的 `wasFavorited` 会是旧值——撤销时 `planUndo` 会用"当前状态 == 目标状态"
     * 那条分支判成 `already`，不会把他的操作反掉（这是可接受的：收藏本来就是个开关）。
     */
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_recipeId: { userId, recipeId } },
      select: { id: true },
    })
    const wasFavorited = existing !== null
    const result = await this.favorites.toggle(userId, recipeId)
    const recipe = await this.prisma.recipe.findUnique({ where: { id: recipeId }, select: { name: true } })
    const name = recipe?.name ?? '这道菜'
    const summary = result.favorited ? `收藏「${name}」` : `取消收藏「${name}」`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: result.favorited ? AI_ACTION_FAVORITE_ON : AI_ACTION_FAVORITE_OFF,
        summary,
        undoData: { recipeId, wasFavorited } as unknown as Prisma.InputJsonValue,
        targetId: recipeId,
      },
    })
    return {
      summary: result.favorited ? `已收藏：${name}` : `已取消收藏：${name}`,
      favorited: result.favorited,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: recipeId }],
    }
  }

  /*
   * ---------- 菜单、餐次与组合（用户 2026-10-13：「软件的 CRUD ai 都可以操作」）----------
   *
   * 与冰箱/菜谱同档（A 档）：真的写库、每笔留一条可撤的记录、走**用户自己那套服务**
   * （`OrdersService` / `CombosService`）——那两道门（"这一餐收不收新菜"、"只有自己点的能撤"、
   * 组合的 `canEditCombo`）都在那些服务里，AI 不该绕开，也不该复制一份。
   */

  /**
   * 往菜单里加菜（一次最多 `MENU_ADD_MAX` 道）。
   *
   * 逐道写而不是整批一个事务：与"记冰箱"同一个取舍——**一种失败不该带走整批**
   * （"加上番茄炒蛋和米饭"里米饭那道菜谱已经删了，番茄炒蛋仍该进去）。
   * 每道成功就单独记一条动作，回执卡上一行一个「撤」。
   */
  async addMenuItems(
    userId: string,
    input: { mealDate: string; meal: MealSlot; items: { recipeId?: string; dishName?: string; note?: string }[] },
  ): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能往菜单里加菜')
    const done: AiReceipt[] = []
    const failed: string[] = []

    for (const item of input.items) {
      try {
        const card = await this.orders.addItem(userId, {
          recipeId: item.recipeId,
          dishName: item.dishName,
          mealDate: input.mealDate,
          meal: input.meal,
          note: item.note,
        })
        /*
         * 拿刚插进去那一条的 id：**从返回的卡里按"最后一条"找**不行（同一道菜可能被点两次），
         * 所以按"这一餐 + 这个人 + 刚写下去"查最新一条。自由菜品与菜谱同名时会被合并成一行
         * （`resolveItem`），显示名以卡上的为准。
         */
        const wanted = item.recipeId ?? item.dishName ?? ''
        const mealRow = await this.prisma.mealOrder.findUnique({
          where: { familyId_mealDate_meal: { familyId, mealDate: dateOnly(input.mealDate), meal: input.meal } },
        })
        const row = mealRow
          ? await this.prisma.orderItem.findFirst({
            where: { mealOrderId: mealRow.id, userId },
            orderBy: { createdAt: 'desc' },
          })
          : null
        if (!row || !mealRow) {
          // 写库成功但拿不到那条（理论上不会发生）：如实说"加好了但撤不了"，
          // 而不是记一条指向错误 id 的动作——那会让「撤」去删别人的菜
          failed.push(`${wanted}：加进去了，但那一条没对上，撤不了`)
          continue
        }
        const name = card.dishes.find((dish) => dish.recipeId === item.recipeId)?.name ?? row.recipeName
        const summary = `${describeWhen(input.mealDate, todayKey(), input.meal)}：${name}`
        const action = await this.prisma.aiAction.create({
          data: {
            familyId,
            actorId: userId,
            kind: AI_ACTION_MENU_ADD,
            summary,
            undoData: { itemId: row.id } as unknown as Prisma.InputJsonValue,
            targetId: row.id,
          },
        })
        done.push({ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: row.id })
      } catch (error) {
        failed.push(`${item.recipeId ?? item.dishName ?? '（没名字的菜）'}：${humanError(error)}`)
      }
    }

    const lines = [
      done.length ? `已加进菜单：${done.map((item) => item.summary).join('、')}` : '',
      failed.length ? `没加成：${failed.join('；')}` : '',
    ].filter(Boolean)
    return { summary: lines.join('\n') || '（没有要加的菜）', actions: done }
  }

  /** 从菜单里撤一道菜（原样记下来，撤销就是照原样点回去） */
  async removeMenuItem(userId: string, itemId: string): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能改菜单')
    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId }, include: { mealOrder: true } })
    if (!item || item.mealOrder.familyId !== familyId) {
      return { summary: `没找到这道点单（itemId: ${itemId}），请先调 read_menu 拿准确 id`, actions: [] }
    }

    await this.orders.removeItem(userId, itemId)
    const summary = `${describeWhen(dateKey(item.mealOrder.mealDate), todayKey(), item.mealOrder.meal)}：${item.recipeName}`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_MENU_REMOVE,
        summary,
        undoData: {
          item: {
            recipeId: item.recipeId,
            recipeName: item.recipeName,
            note: item.note,
            mealDate: dateKey(item.mealOrder.mealDate),
            meal: item.mealOrder.meal,
          },
        } as unknown as Prisma.InputJsonValue,
        targetId: item.id,
      },
    })
    return {
      summary: `已从菜单里撤掉：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: itemId }],
    }
  }

  /** 改某一餐的就餐人数（原值记下来，撤销就是写回去） */
  async setDiners(userId: string, mealKey: string, count: number | null): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能改就餐人数')
    const { mealDate, meal } = parseMealKey(mealKey)
    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
    })
    if (!row) return { summary: '这一餐还没有人点菜，先把菜点上再定人数', actions: [] }

    const before = row.dinerCount
    await this.orders.setDiners(userId, mealKey, count)
    const when = describeWhen(dateKey(mealDate), todayKey(), meal)
    const summary = count === null ? `${when}：清除就餐人数` : `${when}：${count} 人吃`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_MEAL_DINERS,
        summary,
        undoData: { mealKey, before, after: count } as unknown as Prisma.InputJsonValue,
        targetId: row.id,
      },
    })
    return {
      summary: `已设定：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: row.id }],
    }
  }

  /**
   * 整餐状态流转。**这一笔没有可撤的记录**——状态机是单向的
   * （见 `ALLOWED_TRANSITIONS`：不跳级、不回退，DONE/CANCELED 是终态），
   * "撤回到上一个状态"在数据上不成立，回执卡上也就没有「撤」。
   *
   * 仍然记一条 AiAction：这是**谁在什么时候把这一餐定下来的**的留痕，
   * 用户回头问"这餐怎么突然成了已安排"时有据可查（与冰箱那几笔同一个表）。
   */
  async setMealStatus(
    userId: string,
    mealKey: string,
    status: OrderStatus,
  ): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能改菜单状态')
    const { mealDate, meal } = parseMealKey(mealKey)
    const row = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
    })
    if (!row) return { summary: '这一餐还没有人点菜，没有状态可改', actions: [] }

    const from = row.status
    await this.orders.updateStatus(userId, mealKey, status)
    const when = describeWhen(dateKey(mealDate), todayKey(), meal)
    const summary = `${when}：${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_MEAL_STATUS,
        summary,
        undoData: { mealKey, from, to: status } as unknown as Prisma.InputJsonValue,
        targetId: row.id,
      },
    })
    return {
      summary: `已改：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: row.id }],
    }
  }

  /**
   * 再点一次：把某一餐整桌照抄到另一天某一餐。
   *
   * 逐道记一条可撤的动作：撤销"再点一次"在用户眼里是"把照抄过来的那几道撤掉"，
   * 而整批记成一条的话，撤一下会把用户原来就在目标那一餐的菜也牵连进来。
   * `orders.repeat` 已经保证了"已有的菜跳过"，所以这里记下的每条都是**这次真加进去的**。
   */
  async repeatMeal(
    userId: string,
    input: { mealKey: string; mealDate: string; meal: MealSlot },
  ): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能照抄菜单')
    const { mealDate: sourceDate, meal: sourceMeal } = parseMealKey(input.mealKey)

    // 先看目标那一餐现在有哪些菜：照抄之后新出现的那几条就是"这次加进去的"
    const targetBefore = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate: dateOnly(input.mealDate), meal: input.meal } },
      include: { items: { select: { recipeName: true } } },
    })
    const had = new Set((targetBefore?.items ?? []).map((item) => item.recipeName))

    const result = await this.orders.repeat(userId, input.mealKey, { mealDate: input.mealDate, meal: input.meal })
    const when = describeWhen(input.mealDate, todayKey(), input.meal)

    if (result.added.length === 0) {
      return { summary: result.message ?? '这一餐里这桌菜都有了', actions: [] }
    }

    const actions: AiReceipt[] = []
    for (const name of result.added) {
      if (had.has(name)) continue
      const row = await this.prisma.orderItem.findFirst({
        where: {
          userId,
          recipeName: name,
          mealOrder: { familyId, mealDate: dateOnly(input.mealDate), meal: input.meal },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!row) continue
      const summary = `${when}：${name}`
      const action = await this.prisma.aiAction.create({
        data: {
          familyId,
          actorId: userId,
          kind: AI_ACTION_MENU_ADD,
          summary,
          undoData: { itemId: row.id } as unknown as Prisma.InputJsonValue,
          targetId: row.id,
        },
      })
      actions.push({ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: row.id })
    }
    const line = result.added.map((name) => `${when}：${name}`).join('、')
    const skipped = result.skipped.length ? `（${result.skipped.join('、')} 本来就有，跳过了）` : ''
    return { summary: `已照 ${sourceMeal === 'LUNCH' ? '午' : '晚'}餐点了一遍：${line}${skipped}`, actions }
  }

  /** 新建一个常用组合 */
  async createCombo(
    userId: string,
    input: { name?: unknown; note?: unknown; recipeIds?: unknown },
  ): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能存常用组合')
    const before = new Set(await this.comboIds(familyId))
    await this.combos.create(userId, input)
    const created = (await this.comboIds(familyId)).find((id) => !before.has(id))
    if (!created) return { summary: '组合建好了，但没对上那一个，撤不了', actions: [] }

    const state = await this.comboState(created)
    const summary = `组合「${state?.name ?? '新组合'}」`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_COMBO_CREATE,
        summary,
        undoData: { comboId: created, after: state } as unknown as Prisma.InputJsonValue,
        targetId: created,
      },
    })
    return {
      summary: `已存：${summary}（${state?.recipeIds.length ?? 0} 道菜）`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: created }],
    }
  }

  /** 改一个组合（名字/说明/整组换菜） */
  async updateCombo(
    userId: string,
    comboId: string,
    input: { name?: unknown; note?: unknown; recipeIds?: unknown },
  ): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能改常用组合')
    const before = await this.comboState(comboId)
    if (!before) return { summary: `没找到这个组合（comboId: ${comboId}），请先调 read_combos 拿准确 id`, actions: [] }

    await this.combos.update(userId, comboId, input)
    const after = await this.comboState(comboId)
    if (!after) return { summary: '改完之后这个组合不见了，请重试', actions: [] }

    /*
     * 只记**模型这次真的动过的那几项**（与冰箱/菜谱同一条：全字段都记的话，
     * "用户后来自己改了说明"会被误判成"与 AI 写下时不一致"而拒绝撤销，
     * 而那次撤销本来该允许——AI 只换了菜）。`input` 里 `undefined` = 没提，
     * 与 `CombosService.update` 的判断口径一致。
     */
    const touched = (state: ComboState | typeof after): Partial<ComboState> => {
      const out: Partial<ComboState> = {}
      if (input.name !== undefined) out.name = state.name
      if (input.note !== undefined) out.note = state.note
      if (input.recipeIds !== undefined) out.recipeIds = state.recipeIds
      return out
    }
    const summary = `组合「${after.name}」`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_COMBO_UPDATE,
        summary,
        undoData: { comboId, before: touched(before), after: touched(after) } as unknown as Prisma.InputJsonValue,
        targetId: comboId,
      },
    })
    return {
      summary: `已改：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: comboId }],
    }
  }

  /** 删一个常用组合。**整组都记下来**（重建时少一道菜就是少一道） */
  async removeCombo(userId: string, comboId: string): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能删常用组合')
    const row = await this.prisma.combo.findUnique({
      where: { id: comboId },
      include: { items: { orderBy: { position: 'asc' }, select: { recipeId: true } } },
    })
    if (!row || row.familyId !== familyId) {
      return { summary: `没找到这个组合（comboId: ${comboId}），请先调 read_combos 拿准确 id`, actions: [] }
    }

    await this.combos.remove(userId, comboId)
    const summary = `组合「${row.name}」`
    const action = await this.prisma.aiAction.create({
      data: {
        familyId,
        actorId: userId,
        kind: AI_ACTION_COMBO_REMOVE,
        summary,
        undoData: {
          combo: {
            id: row.id,
            name: row.name,
            note: row.note,
            createdById: row.createdById,
            familyId: row.familyId,
            recipeIds: row.items.map((item) => item.recipeId),
          },
        } as unknown as Prisma.InputJsonValue,
        targetId: comboId,
      },
    })
    return {
      summary: `已删：${summary}`,
      actions: [{ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: comboId }],
    }
  }

  /**
   * 一键把组合加进某一餐。
   *
   * 记的是**每一道**（与"再点一次"同一个理由）：撤销要能把这一次加进去的那几道逐条撤掉，
   * 而整组记成一条的话，撤一下会连用户原本在那一餐的菜一起动。
   */
  async addComboToMeal(
    userId: string,
    comboId: string,
    input: { mealDate: string; meal: MealSlot },
  ): Promise<{ summary: string; actions: AiReceipt[] }> {
    const { familyId } = await this.requireMember(userId, '先加入家庭，才能用常用组合')
    const targetBefore = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate: dateOnly(input.mealDate), meal: input.meal } },
      include: { items: { select: { recipeName: true } } },
    })
    const had = new Set((targetBefore?.items ?? []).map((item) => item.recipeName))

    const result = await this.combos.addToMeal(userId, comboId, { mealDate: input.mealDate, meal: input.meal })
    const when = describeWhen(input.mealDate, todayKey(), input.meal)
    if (result.added.length === 0) {
      return { summary: result.message ?? '这一餐里这组菜都有了', actions: [] }
    }

    const actions: AiReceipt[] = []
    for (const name of result.added) {
      if (had.has(name)) continue
      const row = await this.prisma.orderItem.findFirst({
        where: {
          userId,
          recipeName: name,
          mealOrder: { familyId, mealDate: dateOnly(input.mealDate), meal: input.meal },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!row) continue
      const summary = `${when}：${name}`
      const action = await this.prisma.aiAction.create({
        data: {
          familyId,
          actorId: userId,
          kind: AI_ACTION_MENU_ADD,
          summary,
          undoData: { itemId: row.id } as unknown as Prisma.InputJsonValue,
          targetId: row.id,
        },
      })
      actions.push({ id: action.id, kind: action.kind, summary, label: undoLabel(action.kind), target: row.id })
    }
    const line = result.added.map((name) => `${when}：${name}`).join('、')
    const skipped = result.skipped.length ? `（${result.skipped.join('、')} 本来就有，跳过了）` : ''
    return { summary: `已把这一组加进去：${line}${skipped}`, actions }
  }

  /** 会话里那些还没撤的回执（前端重连/切页回来后仍能显示「撤」） */
  async recent(userId: string, limit = 10): Promise<AiReceipt[]> {
    const rows = await this.prisma.aiAction.findMany({
      where: { actorId: userId, undoneAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      label: undoLabel(row.kind),
      target: row.targetId ?? '',
    }))
  }

  // ---------- 内部 ----------

  private async runPlan(userId: string, plan: UndoPlan) {
    if (plan.op === 'delete') {
      await this.fridge.remove(userId, plan.itemId)
      return
    }
    if (plan.op === 'update') {
      await this.fridge.update(userId, plan.itemId, plan.item)
      return
    }
    if (plan.op === 'deleteRecipe') {
      await this.recipes.remove(userId, plan.recipeId)
      return
    }
    if (plan.op === 'updateRecipe') {
      await this.recipes.update(userId, plan.recipeId, plan.patch)
      return
    }
    if (plan.op === 'restoreRecipe') {
      await this.recipes.restore(plan.recipe)
      return
    }
    if (plan.op === 'setFavorite') {
      /*
       * 收藏的撤销走 `favorites.toggle`（用户自己那套），但**先核对当前状态**：
       * toggle 是"反一下"，而撤销要的是"设成某个状态"。已经等于目标状态时不能调 toggle
       * （那会把用户的操作反掉）；planUndo 已经用 `already` 挡掉了那种情况，
       * 所以走到这里时状态必然与目标相反，反一下正好。
       */
      await this.favorites.toggle(userId, plan.recipeId)
      return
    }
    if (plan.op === 'removeMenuItem') {
      // 撤菜走用户自己那条（"只能撤自己点的、待确认阶段的"两道门都在那里，撤销不该绕开）
      await this.orders.removeItem(userId, plan.itemId)
      return
    }
    if (plan.op === 'restoreMenuItem') {
      /*
       * 放回去走 `orders.addItem`：那一餐可能已经被删光了
       * （用户撤掉最后一道菜时整餐会消失，见 `removeItem`），它会按需重建；
       * 而"日期在窗口内""这一餐收不收新菜"这些判定也只有那一条路上有。
       */
      await this.orders.addItem(userId, {
        recipeId: plan.item.recipeId ?? undefined,
        dishName: plan.item.recipeId ? undefined : plan.item.recipeName,
        mealDate: plan.item.mealDate,
        meal: plan.item.meal,
        note: plan.item.note ?? undefined,
      })
      return
    }
    if (plan.op === 'setDiners') {
      await this.orders.setDiners(userId, plan.mealKey, plan.count)
      return
    }
    if (plan.op === 'deleteCombo') {
      await this.combos.remove(userId, plan.comboId)
      return
    }
    if (plan.op === 'updateCombo') {
      await this.combos.update(userId, plan.comboId, {
        name: plan.patch.name,
        // `note` 是可空字段：撤销时没记说明就传 `null`（清掉）——这与"原来就是 null"等价
        note: plan.patch.note ?? null,
        recipeIds: plan.patch.recipeIds,
      })
      return
    }
    if (plan.op === 'restoreCombo') {
      await this.combos.restore(plan.combo)
      return
    }
    /*
     * 撤"删除"（冰箱）：照原样重建。走 `fridge.add` 而不是 `prisma.create`——
     * 唯一约束（同名同区只一条）与各种校验都在那条路上，绕过它就可能插进一条
     * 与现有记录冲突的、或者校验不通过的数据。
     */
    await this.fridge.add(userId, {
      name: plan.item.name,
      amount: plan.item.amount,
      zone: plan.item.zone,
      expiresOn: plan.item.expiresOn,
      note: plan.item.note,
    })
  }

  /** 这条现在长什么样（撤销要拿它核对）。`null` = 已经不在了 */
  private async currentSnapshot(itemId: string | null): Promise<FridgeSnapshot | null> {
    if (!itemId) return null
    const row = await this.prisma.fridgeItem.findUnique({ where: { id: itemId } })
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      amount: row.amount,
      zone: row.zone,
      expiresOn: row.expiresOn ? row.expiresOn.toISOString().slice(0, 10) : null,
      note: row.note,
    }
  }

  /**
   * 撤「删除」专用的现状查询：**按同名同区**找那条在不在（见 `removedItemKey` 的说明）。
   * 用 `findFirst` 而不是 `findUnique`：这里要的是"按业务键查一条"，唯一约束保证至多一条。
   */
  private async byNameAndZone(familyId: string, undoData: unknown): Promise<FridgeSnapshot | null> {
    const key = removedItemKey(undoData)
    if (!key) return null
    const row = await this.prisma.fridgeItem.findFirst({
      where: { familyId, name: key.name, zone: key.zone },
    })
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      amount: row.amount,
      zone: row.zone,
      expiresOn: row.expiresOn ? row.expiresOn.toISOString().slice(0, 10) : null,
      note: row.note,
    }
  }

  /**
   * 取当前用户的家庭归属。
   *
   * `hint` 是可定制的那句拒绝话术：冰箱/菜谱/收藏各自该说自己的事
   * （"才能记冰箱里的东西"套到收藏上很怪）。默认值保留原来的冰箱口径。
   */
  private async requireMember(userId: string, hint = '先加入家庭，才能记冰箱里的东西') {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: true },
    })
    if (!membership) throw new NotFoundException(hint)
    return {
      familyId: membership.familyId,
      role: membership.role as FamilyRole,
      shared: membership.family.shared,
    }
  }
}

/** 一张回执卡（前端直接照着画） */
export interface AiReceipt {
  /** AiAction 的 id——「撤」就是拿它去调撤销接口 */
  id: string
  kind: string
  /** 写给用户看的一句（"鸡蛋 · 一盒 · 冷藏"） */
  summary: string
  /** 撤销按钮上的字（"撤掉"/"改回去"/"放回去"） */
  label: string
  target: string
}

/**
 * 把内部错误翻成给模型看的人话（模型会把它转述给用户，所以不能是堆栈）。
 *
 * 导出是给 `ai.service` 执行工具用的：那边抛出的校验/权限错误（"公共菜谱改不了"
 * "这个名字你自己已经有一道了"）必须原话回到模型手里，否则模型收到一句
 * "Internal server error" 只会自己编个理由解释给用户听。
 */
export function humanError(error: unknown): string {
  if (error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) {
    const response = error.getResponse() as { message?: string }
    return response.message ?? error.message
  }
  return '没记成'
}

/**
 * 撤销判定要"比对"的那些字段（从库里的行取出来）。
 *
 * 为什么只取这几个而不整行：撤销的判据是"用户有没有改过 AI 写下的内容"，
 * 而 `imageKey`/`source` 这些**用户改不了**（没有对应界面）、也不该影响判定——
 * 带进来只会让将来加一个系统字段时把撤销搞坏。
 */
function recipeComparable(recipe: {
  name: string; category: string; cuisine: string; tags: unknown; aliases: unknown
  ingredients: unknown; steps: unknown; notes: unknown; calories: number | null
}): Record<string, unknown> {
  return recipeFields(recipe, ['name', 'category', 'cuisine', 'tags', 'aliases', 'ingredients', 'steps', 'notes', 'calories'])
}

/** 按字段名取（`fields` 为空时给全部可比字段——用在"新建"那种要留全份快照的地方） */
function recipeFields(recipe: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const keys = fields.length > 0 ? fields : ['name', 'category', 'cuisine', 'tags', 'aliases', 'ingredients', 'steps', 'notes', 'calories']
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = recipe[key] ?? null
  return out
}

/** 一条菜谱的现状（撤销要拿它核对） */
function recipeSnapshot(row: {
  id: string; name: string; category: string; cuisine: string; tags: unknown; aliases: unknown
  ingredients: unknown; steps: unknown; notes: unknown; calories: number | null
}): RecipeSnapshot {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    cuisine: row.cuisine,
    tags: (row.tags ?? []) as string[],
    aliases: (row.aliases ?? []) as string[],
    ingredients: (row.ingredients ?? []) as { name: string; amount: string }[],
    steps: (row.steps ?? []) as string[],
    notes: (row.notes ?? []) as string[],
    calories: row.calories,
  }
}

/** 从收藏那笔的 undoData 里取 recipeId */
function favoriteRecipeId(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = (raw as { recipeId?: unknown }).recipeId
  return typeof value === 'string' && value ? value : null
}
