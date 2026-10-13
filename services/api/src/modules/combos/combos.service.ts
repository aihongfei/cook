import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { MealSlot } from '@prisma/client'
import { CAPABILITIES, FamilyRole, can } from '../family/family.roles'
import { publicImageUrl } from '../media/media.storage'
import { OrdersService } from '../orders/orders.service'
import { parseMealDate, parseSlot, dateKey } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import {
  canEditCombo, parseComboName, parseComboNote, parseRecipeIds, planAdd,
} from './combos.rules'

/**
 * 常用组合（M4 / F4-04）：把常一起点的一组菜存成一个"套餐"，一键整组加进某一餐。
 * 口径见 D-029。
 *
 * 两条与"用起来不会有意外"直接相关的做法：
 * - **一键加入是原子的**：整组一起进，或者一条都不进。加到一半失败（某道菜被删了、
 *   那一餐已经安排好了）而界面只提示成功的话，用户会以为整组都进去了；
 * - **已有的菜跳过、不叠加份数**，并把跳过哪些告诉用户——同一个组合点两次不会变样。
 */
@Injectable()
export class CombosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  /** 组合列表：家庭内共用，任何成员都能看（与菜单、冰箱同一层可见性） */
  async list(userId: string) {
    const { familyId, role } = await this.requireMember(userId)
    const combos = await this.prisma.combo.findMany({
      where: { familyId },
      include: { items: { orderBy: { position: 'asc' }, include: { recipe: true } }, createdBy: true },
      orderBy: { createdAt: 'desc' },
    })

    return {
      combos: combos.map(combo => ({
        id: combo.id,
        name: combo.name,
        note: combo.note,
        createdBy: combo.createdBy.nickname,
        /** 只有组它的人与掌勺人/帮厨能改（前端据此决定按钮出不出现；后端仍会再校验一次） */
        canEdit: canEditCombo(combo.createdById, userId, can(role, CAPABILITIES.MENU_MANAGE)),
        dishes: combo.items.map(item => ({
          recipeId: item.recipeId,
          name: item.recipe.name,
          image: publicImageUrl(item.recipe.imageKey, item.recipe.image),
        })),
        dishCount: combo.items.length,
      })),
    }
  }

  /** 新建：从"把这一餐存下来"或从菜谱库里挑几道都走这里 */
  async create(
    userId: string,
    input: { name?: unknown; note?: unknown; recipeIds?: unknown },
  ) {
    const { familyId } = await this.requireMember(userId)
    const name = parseComboName(input?.name)
    const note = parseComboNote(input?.note)
    const recipeIds = parseRecipeIds(input?.recipeIds)
    await this.assertRecipesExist(recipeIds)

    // 同家重名：库层有唯一约束，这里先查一次，为的是给一句人话（不指望约束报错能读懂）
    const duplicated = await this.prisma.combo.findUnique({ where: { familyId_name: { familyId, name } } })
    if (duplicated) throw new ConflictException(`家里已经有一个叫「${name}」的组合了，换个名字吧`)

    await this.prisma.combo.create({
      data: {
        familyId,
        createdById: userId,
        name,
        note,
        items: { create: recipeIds.map((recipeId, position) => ({ recipeId, position })) },
      },
    })
    return this.list(userId)
  }

  /** 改组合：名字/说明，以及**整组替换**菜（前端把增删后的完整列表发回来） */
  async update(
    userId: string,
    comboId: string,
    input: { name?: unknown; note?: unknown; recipeIds?: unknown },
  ) {
    const { familyId, role } = await this.requireMember(userId)
    const combo = await this.prisma.combo.findUnique({ where: { id: comboId } })
    if (!combo || combo.familyId !== familyId) throw new NotFoundException('这个组合不存在了')
    if (!canEditCombo(combo.createdById, userId, can(role, CAPABILITIES.MENU_MANAGE))) {
      throw new ForbiddenException('这个组合不是你组的，让组它的人或掌勺人改')
    }

    const name = input?.name === undefined ? combo.name : parseComboName(input.name)
    const note = input?.note === undefined ? combo.note : parseComboNote(input.note)
    if (name !== combo.name) {
      const duplicated = await this.prisma.combo.findUnique({ where: { familyId_name: { familyId, name } } })
      if (duplicated) throw new ConflictException(`家里已经有一个叫「${name}」的组合了，换个名字吧`)
    }

    const recipeIds = input?.recipeIds === undefined ? null : parseRecipeIds(input.recipeIds)
    if (recipeIds) await this.assertRecipesExist(recipeIds)

    // 菜的增删在同一个事务里做：换到一半失败会留下一个"看起来对、其实少了两道"的组合
    await this.prisma.$transaction(async (tx) => {
      await tx.combo.update({ where: { id: comboId }, data: { name, note } })
      if (!recipeIds) return
      await tx.comboItem.deleteMany({ where: { comboId } })
      await tx.comboItem.createMany({
        data: recipeIds.map((recipeId, position) => ({ comboId, recipeId, position })),
      })
    })
    return this.list(userId)
  }

  async remove(userId: string, comboId: string) {
    const { familyId, role } = await this.requireMember(userId)
    const combo = await this.prisma.combo.findUnique({ where: { id: comboId } })
    if (!combo || combo.familyId !== familyId) throw new NotFoundException('这个组合不存在了')
    if (!canEditCombo(combo.createdById, userId, can(role, CAPABILITIES.MENU_MANAGE))) {
      throw new ForbiddenException('这个组合不是你组的，让组它的人或掌勺人删')
    }
    await this.prisma.combo.delete({ where: { id: comboId } })
    return this.list(userId)
  }

  /**
   * 照原样重建一个被删掉的组合（撤「AI 删了组合」那笔）。
   *
   * **直接走 prisma.create 而不是 `create()`**，且用 `combo.familyId` 而不是
   * "调用者现在属于哪个家"：撤销要还原的是**当时那一个**（包括 id、原属家庭、谁组的）。
   * 走 `create()` 会重新生成 id 并把 createdById 记成现在这个人——而那个字段决定
   * 谁能改它（`canEditCombo`），一次撤销不该悄悄换掉组合的主人；用户换了家庭时
   * 也不该把旧家的组合搬进新家（同菜谱 `restore` 那条说明）。
   *
   * **不做业务校验**（名字长度、菜 id 是否存在）：这一行本来就是从这个库里删出去的，
   * 形状库是认的。同家重名那个边界交给调用方——撞上唯一约束时它把库的话如实转给用户。
   */
  async restore(combo: {
    id: string
    name: string
    note: string | null
    createdById: string
    familyId: string
    recipeIds: string[]
  }) {
    return this.prisma.combo.create({
      data: {
        id: combo.id,
        familyId: combo.familyId,
        createdById: combo.createdById,
        name: combo.name,
        note: combo.note,
        items: { create: combo.recipeIds.map((recipeId, position) => ({ recipeId, position })) },
      },
    })
  }

  /**
   * 一键加入：把这一组菜整组加到某一天某一餐。
   *
   * 日期与餐次走与手点**同一套校验**（`parseMealDate` / `parseSlot`），
   * 所以"这一餐还能不能加菜"的判定也只有一份（`canAddItem`，在 OrdersService 里）。
   * 逐道调 `orders.addItem` 而不是另写一段写库逻辑：加了菜之后整餐的状态会回到「待确认」
   * 这类语义，两处各写一遍必然分叉。
   */
  async addToMeal(userId: string, comboId: string, input: { mealDate?: unknown; meal?: unknown }) {
    const { familyId, role } = await this.requireMember(userId)
    const combo = await this.prisma.combo.findUnique({
      where: { id: comboId },
      include: { items: { orderBy: { position: 'asc' }, include: { recipe: true } } },
    })
    if (!combo || combo.familyId !== familyId) throw new NotFoundException('这个组合不存在了')
    if (combo.items.length === 0) throw new ConflictException('这个组合里没有菜了，先给它添一道')

    const mealDate = parseMealDate(input?.mealDate)
    const meal = parseSlot(input?.meal) as MealSlot
    const wanted = combo.items.map(item => item.recipeId)

    // 这一餐里已经有的菜（谁点的都算）：跳过，不叠加份数（见 combos.rules 的 planAdd）
    const existingRow = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
      include: { items: true },
    })
    const existing = (existingRow?.items ?? []).map(item => item.recipeId).filter((id): id is string => Boolean(id))
    const { toAdd, skipped } = planAdd(existing, wanted)
    if (toAdd.length === 0) {
      return {
        added: [] as string[],
        skipped: skipped.map(id => this.nameOf(combo.items, id)),
        card: await this.orders.card(existingRow!.id, userId),
        message: '这一餐里这组菜都有了',
      }
    }

    // 先确保整组都能加（这一餐的状态）：一次判定，避免加到一半才发现"已做好了"
    await this.orders.assertMealAcceptsItems(userId, mealDate, meal)

    for (const recipeId of toAdd) {
      await this.orders.addItem(userId, { recipeId, mealDate: dateKey(mealDate), meal })
    }

    const finalRow = await this.prisma.mealOrder.findUnique({
      where: { familyId_mealDate_meal: { familyId, mealDate, meal } },
    })
    return {
      added: toAdd.map(id => this.nameOf(combo.items, id)),
      skipped: skipped.map(id => this.nameOf(combo.items, id)),
      card: finalRow ? await this.orders.card(finalRow.id, userId) : null,
      role: role as FamilyRole,
    }
  }

  // ---------- 内部 ----------

  private nameOf(items: { recipeId: string; recipe: { name: string } }[], recipeId: string): string {
    return items.find(item => item.recipeId === recipeId)?.recipe.name ?? recipeId
  }

  /** 组里的菜必须都真的存在：编造的 id 放进去，之后"一键加入"就永远失败在某一道上 */
  private async assertRecipesExist(recipeIds: string[]) {
    const found = await this.prisma.recipe.findMany({ where: { id: { in: recipeIds } }, select: { id: true } })
    const missing = recipeIds.filter(id => !found.some(row => row.id === id))
    if (missing.length > 0) throw new NotFoundException(`有 ${missing.length} 道菜不在菜谱库里`)
  }

  private async requireMember(userId: string): Promise<{ familyId: string; role: FamilyRole }> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) throw new NotFoundException('先加入家庭，才能和家里一起点菜')
    return { familyId: membership.familyId, role: membership.role as FamilyRole }
  }
}
