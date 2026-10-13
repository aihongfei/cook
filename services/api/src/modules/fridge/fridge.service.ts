import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { FamilyRole } from '../family/family.roles'
import { visibleToMember } from '../orders/orders.rules'
import { PrismaService } from '../recipes/prisma.service'
import {
  FRIDGE_ZONES,
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
  constructor(private readonly prisma: PrismaService) {}

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
    return {
      scope,
      zones,
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

    await this.prisma.fridgeItem.create({
      data: { familyId, addedById: userId, name, amount, zone, expiresOn, note },
    })
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
    return this.board(userId)
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
