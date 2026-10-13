import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { FamilyRole } from '../family/family.roles'
import { FridgeService } from '../fridge/fridge.service'
import { visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import {
  AI_ACTION_FRIDGE_CREATE,
  AI_ACTION_FRIDGE_REMOVE,
  AI_ACTION_FRIDGE_UPDATE,
  describeFridgeItem,
  planUndo,
  removedItemKey,
  undoLabel,
  type FridgeSnapshot,
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

    /*
     * "它现在是什么样"要看撤销的是哪种动作：撤「增」「改」问的是**那条还在不在**
     * （按 id 查，删掉了就是查不到 → planUndo 说"这条已经不在了"）；
     * 撤「删」问的是**它回来了没有**——这时按 id 查毫无意义（那个 id 必然查不到，
     * 因为就是被删掉的那条），得按唯一约束的键（同名同区）查。见 removedItemKey 的说明。
     */
    const current = action.kind === AI_ACTION_FRIDGE_REMOVE
      ? await this.byNameAndZone(action.familyId, action.undoData)
      : await this.currentSnapshot(action.targetId)
    const { plan, verdict } = planUndo(
      { id: action.id, kind: action.kind, undoData: action.undoData, undoneAt: action.undoneAt, targetId: action.targetId },
      current,
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
    /*
     * 撤"删除"：照原样重建。走 `fridge.add` 而不是 `prisma.create`——
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

/** 把内部错误翻成给模型看的人话（模型会把它转述给用户，所以不能是堆栈） */
function humanError(error: unknown): string {
  if (error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) {
    const response = error.getResponse() as { message?: string }
    return response.message ?? error.message
  }
  return '没记成'
}
