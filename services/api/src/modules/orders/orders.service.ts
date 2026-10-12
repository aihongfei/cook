import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { MealSlot, OrderStatus, Prisma } from '@prisma/client'
import { CAPABILITIES, FamilyRole, can } from '../family/family.roles'
import { publicImageUrl } from '../media/media.storage'
import { PrismaService } from '../recipes/prisma.service'
import {
  MEAL_LABEL, MEAL_SLOTS, ORDER_STATUSES, STATUS_LABEL, TRANSITION_CAPABILITY,
  aggregateItems, canAddItem, dateKey, isAllowedTransition, mealKeyOf, nextActionsFor, parseMealDate,
  parseMealKey, parseNote, parseSlot, parseStatus, photoVisibleTo, revivedStatus, visibleToMember, dayOptions, type AggregateItem,
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
  /** 这一餐的成品照张数（F9-08）。按视图范围算：看不到的照片不计入（见 cardFromRow 说明） */
  photoCount: number
  nextActions: { status: OrderStatus; label: string; needsConfirm: boolean }[]
  submittedAt: string
}

type MealOrderRow = Prisma.MealOrderGetPayload<{ include: typeof MEAL_ORDER_INCLUDE }>

/** 卡片组装要用的关联（列表与单卡共用，避免两处 include 漂移） */
const MEAL_ORDER_INCLUDE = {
  items: { include: { user: true }, orderBy: { createdAt: 'asc' } },
  checkIns: { select: { userId: true } },
} satisfies Prisma.MealOrderInclude

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 点菜（`order.create`，人人可点）。
   * 同一餐已有就复用；**已安排之后不能再加菜**（要加先取消这餐，D-022）。
   */
  async addItem(
    userId: string,
    input: { recipeId?: string; mealDate?: string; meal?: string; note?: string },
  ): Promise<MealCardView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.ORDER_CREATE)

    const slot = parseSlot(input.meal)
    const mealDate = parseMealDate(input.mealDate)
    const note = parseNote(input.note)

    if (typeof input.recipeId !== 'string' || !input.recipeId.trim()) throw new BadRequestException('缺少菜谱')
    const recipe = await this.prisma.recipe.findUnique({ where: { id: input.recipeId.trim() } })
    if (!recipe) throw new NotFoundException('这道菜不在菜谱库里')

    const mealOrder = await this.ensureMealOrder(familyId, mealDate, slot)
    if (!canAddItem(mealOrder.status)) {
      // 已做好是终态、连取消都不行，别给出"先取消"这种做不到的建议
      throw new ConflictException(
        mealOrder.status === 'DONE'
          ? '这餐已经做好了，换个餐次再点吧'
          : `这餐已经「${STATUS_LABEL[mealOrder.status]}」了，想加菜先取消这餐`,
      )
    }

    // 被取消过的餐：加菜时顺带复活成「待确认」（见 orders.rules 的 canAddItem）
    if (mealOrder.status !== revivedStatus(mealOrder.status)) {
      await this.prisma.mealOrder.update({ where: { id: mealOrder.id }, data: { status: revivedStatus(mealOrder.status) } })
    }

    await this.prisma.orderItem.create({
      data: {
        mealOrderId: mealOrder.id,
        userId,
        recipeId: recipe.id,
        recipeName: recipe.name,
        // 冗余存一份自托管地址：菜谱日后被删/换图，历史点单卡仍显示得出来
        recipeImage: publicImageUrl(recipe.imageKey, recipe.image),
        note,
      },
    })
    return this.card(mealOrder.id, userId)
  }

  /**
   * 撤回自己点的一份菜：该餐还得在「待确认」、且这条确实是我点的。
   * （取消整餐要走 updateStatus，需要 menu.manage。）
   */
  async removeItem(userId: string, itemId: string): Promise<MealCardView> {
    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId }, include: { mealOrder: true } })
    if (!item) throw new NotFoundException('这条点单不存在了')

    const { familyId } = await this.requireMember(userId)
    if (item.mealOrder.familyId !== familyId) throw new NotFoundException('这条点单不存在了')
    if (item.userId !== userId) throw new ForbiddenException('只能撤回自己点的菜')
    if (item.mealOrder.status !== 'PENDING') {
      throw new ConflictException(`这餐已经「${STATUS_LABEL[item.mealOrder.status]}」了，不能再撤回`)
    }

    await this.prisma.orderItem.delete({ where: { id: itemId } })

    // 撤掉最后一份菜后这张卡就空了，顺手删掉——免得列表里留一个"0 道菜"的餐次
    const remaining = await this.prisma.orderItem.count({ where: { mealOrderId: item.mealOrderId } })
    if (remaining > 0) return this.card(item.mealOrderId, userId)

    await this.prisma.mealOrder.delete({ where: { id: item.mealOrderId } })
    return emptyCard(item.mealOrder.mealDate, item.mealOrder.meal)
  }

  /** 整餐状态流转（F3-02）：按目标状态要对应能力，且必须走状态机允许的一步 */
  async updateStatus(userId: string, mealKey: string, next: unknown): Promise<MealCardView> {
    const target = parseStatus(next)
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

    await this.prisma.mealOrder.update({ where: { id: mealOrder.id }, data: { status: target } })
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
  ): Promise<{ cards: MealCardView[]; counts: Record<string, number>; scope: 'family' | 'mine' }> {
    const { familyId, role } = await this.requireMember(userId)
    const family = await this.requireFamily(familyId)

    const status = options.status && options.status !== 'ALL' ? parseStatus(options.status) : undefined
    const mineOnly = options.family === false
    const scope = visibleToMember(family.shared, role)

    // 共享关闭时吃货只能看自己参与的餐次；掌勺人/帮厨要干活，仍看全量
    const scoped: Prisma.MealOrderWhereInput =
      scope === 'mine' ? { familyId, items: { some: { userId } } } : { familyId }

    // 一次取**不带状态筛选**的全部餐次：卡片按状态筛，但计数徽标必须给出每个状态的数量，
    // 否则点了「待确认」之后，其它状态的徽标会全变成 0，用户就没法切回去了。
    const rows = await this.prisma.mealOrder.findMany({
      where: scoped,
      include: MEAL_ORDER_INCLUDE,
      orderBy: [{ mealDate: 'desc' }, { meal: 'desc' }],
      take: 60,
    })

    const allCards = rows
      .map(row => this.cardFromRow(row, userId, role, family.shared))
      .filter(card => (mineOnly ? card.mineCount > 0 : true))

    const counts: Record<string, number> = { ALL: allCards.length }
    for (const statusKey of ORDER_STATUSES) {
      counts[statusKey] = allCards.filter(card => card.status === statusKey).length
    }

    const cards = status ? allCards.filter(card => card.status === status) : allCards
    return { cards, counts, scope: mineOnly ? 'mine' : 'family' }
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

  /** 点单口径（免登录可读，与 /family/options 同理）：前端不硬编码餐次、状态与可选日期 */
  options() {
    return {
      meals: MEAL_SLOTS.map(value => ({ value, label: MEAL_LABEL[value] })),
      statuses: ORDER_STATUSES.map(value => ({ value, label: STATUS_LABEL[value] })),
      dayOptions: dayOptions(),
    }
  }

  // ---------- 内部 ----------

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
    photoCount: 0,
    nextActions: [],
    submittedAt: new Date().toISOString(),
  }
}
