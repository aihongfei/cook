import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../recipes/prisma.service'
import {
  CAPABILITIES, FAMILY_MEMBER_LIMIT, FamilyRole, ROLE_LABELS, can, capabilitiesOf,
  generateInviteCode, isFamilyRole, normalizeInviteCode,
} from './family.roles'

export interface FamilyMemberView {
  userId: string
  nickname: string
  avatar: string
  role: FamilyRole
  joinedAt: string
  /** 是不是"我"——前端用它把"自己"标出来，不用去比对 id */
  isMe: boolean
}

export interface FamilyView {
  id: string
  name: string
  shared: boolean
  inviteCode: string
  createdAt: string
  memberCount: number
  memberLimit: number
  myRole: FamilyRole
  /** 我能做什么：由角色推导，能力表只在后端定义（D-021） */
  myCapabilities: string[]
  members: FamilyMemberView[]
}

@Injectable()
export class FamilyService {
  constructor(
    private readonly prisma: PrismaService,
    /** 「家庭有变化」要告诉家里人（用户 2026-10-16） */
    private readonly notifications: NotificationsService,
  ) {}

  /** 我当前的家庭；没加入返回 null（前端据此显示"创建/加入"） */
  async mine(userId: string): Promise<FamilyView | null> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) return null
    return this.view(membership.familyId, userId)
  }

  /**
   * 创建家庭并把自己设为掌勺人。
   * 一个账号同时只属于一个家庭（DB 唯一约束），所以已在家庭里的人要先退出。
   */
  async create(userId: string, rawName?: string): Promise<FamilyView> {
    await this.ensureNotInFamily(userId)

    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('账号不存在')

    const name = (rawName ?? '').trim() || `${user.nickname}的家`
    if (name.length > 32) throw new BadRequestException('家庭名最多 32 个字')

    const family = await this.prisma.family.create({
      data: { name, inviteCode: await this.uniqueInviteCode() },
    })
    await this.prisma.familyMember.create({ data: { familyId: family.id, userId, role: 'OWNER' } })
    return this.view(family.id, userId)
  }

  /** 凭六位邀请码加入家庭 */
  async join(userId: string, rawCode: string): Promise<FamilyView> {
    await this.ensureNotInFamily(userId)

    const code = normalizeInviteCode(rawCode ?? '')
    // 邀请码不存在与已满员返回不同的话术是安全的（码本身不是秘密凭证，且加入接口有限流），
    // 但"码不对"这句话不区分大小写/空格输入错误之外的原因，避免成为探测工具。
    const family = code ? await this.prisma.family.findUnique({ where: { inviteCode: code } }) : null
    if (!family) throw new NotFoundException('邀请码不对，跟家里人再核对一下')

    const memberCount = await this.prisma.familyMember.count({ where: { familyId: family.id } })
    if (memberCount >= FAMILY_MEMBER_LIMIT) {
      throw new ConflictException(`这个家庭已经有 ${FAMILY_MEMBER_LIMIT} 位成员了`)
    }

    await this.prisma.familyMember.create({ data: { familyId: family.id, userId, role: 'EATER' } })

    /*
     * 「家庭有变化」：有人来了（用户 2026-10-16）。
     *
     * 写在**入册之后**：`recordChange` 是按"现在这个家里除我之外的人"扇出的——
     * 早一步调，新成员还没进这一家人，就一个收件人都算不出来（`members` 为空直接返回）。
     *
     * 幂等键带**加入之后的人数**（`memberCount + 1`）：同一个人反复退出再加入时，
     * 每次的家里人数一般不同，于是各提醒一次；而他新加入的那一刻，
     * 这个人数正好是他看到的那句"现在家里有 N 口人"里的 N。
     */
    const sizeAfter = memberCount + 1
    await this.notifications.recordChange(family.id, {
      kind: 'family',
      action: '加入了家庭',
      body: `现在家里有 ${sizeAfter} 口人`,
      to: '/family',
      mealKey: null,
      tag: '新成员',
      scope: `join:${family.id}:${userId}:${sizeAfter}`,
    }, userId)

    return this.view(family.id, userId)
  }

  /** 改家庭名与共享开关（F2-07）——需要 family.edit */
  async update(userId: string, input: { name?: string; shared?: boolean }): Promise<FamilyView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.FAMILY_EDIT)

    const data: { name?: string; shared?: boolean } = {}
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new BadRequestException('家庭名不能为空')
      if (name.length > 32) throw new BadRequestException('家庭名最多 32 个字')
      data.name = name
    }
    if (input.shared !== undefined) data.shared = input.shared
    if (Object.keys(data).length === 0) throw new BadRequestException('没有要修改的内容')

    await this.prisma.family.update({ where: { id: familyId }, data })

    /*
     * 「家庭有变化」：改了名字 / 动了共享开关（用户 2026-10-16）。
     *
     * **一句话把两件事都说清楚**（都改了就说两句）：这两件事都只有一个"现在值"，
     * 分开两条提醒的话，"改了名"与"关了共享"会各占一行，而它们常常是一次设置里改的。
     * 键里带改完之后的字段值（与冰箱那条同一个取舍）：重复提交不刷两条，
     * 代价是"改回原名"不重复提醒——那一句说的是"它现在叫 X"，已经告诉过家里人了。
     */
    const changed: string[] = []
    if (data.name !== undefined) changed.push(`把家庭名改成了「${data.name}」`)
    if (data.shared !== undefined) changed.push(data.shared ? '打开了家庭共享' : '关掉了家庭共享')
    await this.notifications.recordChange(familyId, {
      kind: 'family',
      action: changed.join('，还'),
      body: data.shared === false ? '关掉之后，家里人互相看不见没参与的内容' : null,
      to: '/family',
      mealKey: null,
      tag: '设置',
      scope: `edit:${familyId}:${data.name ?? ''}:${data.shared ?? ''}`,
    }, userId)

    return this.view(familyId, userId)
  }

  /** 重置邀请码（F2-06）——旧码立即失效 */
  async resetInviteCode(userId: string): Promise<FamilyView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.INVITE_RESET)
    const inviteCode = await this.uniqueInviteCode()
    await this.prisma.family.update({ where: { id: familyId }, data: { inviteCode } })

    /*
     * 「家庭有变化」：换了邀请码（用户 2026-10-16）。
     *
     * 为什么值得说一句：家里人手里那张纸条上的码**当场作废**了——他转发给亲戚、
     * 或者想再拉一个人时才会发现"码不对"，而那时他多半会以为是应用坏了。
     * 提醒里**不写新码**：那是"谁能进这个家"的凭据，不该躺进通知正文
     * （通知会在锁屏上显示），要看的人去家庭页看。
     *
     * 幂等键里带**新码的摘要**（不是新码本身）：每一次重置都换了码、都该提醒一次，
     * 而"新码"恰好能区分每一次重置；取摘要是因为这条 id 会随列表发给客户端
     * （`item.id`），**没必要把进家的凭据放进一个到处传的字段里**——
     * 那个码不是秘密中的秘密（家里人都看得到），但也不该出现在锁屏推送的载荷里。
     * 用摘要而不是时间戳：同一个请求重放两次不会刷出两条（见冰箱那条同样的取舍）。
     */
    const codeDigest = createHash('sha256').update(inviteCode).digest('hex').slice(0, 8)
    await this.notifications.recordChange(familyId, {
      kind: 'family',
      action: '换了家里的邀请码',
      body: '原来那个码已经失效了，新的在家庭页里',
      to: '/family',
      mealKey: null,
      tag: '邀请码',
      scope: `invite:${familyId}:${codeDigest}`,
    }, userId)

    return this.view(familyId, userId)
  }

  /**
   * 改成员角色（F2-05）。
   * 掌勺人只有一个：把某人设为掌勺人 = **转让**，原掌勺人自动降为帮厨。
   */
  async updateMemberRole(userId: string, targetUserId: string, nextRole: unknown): Promise<FamilyView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.MEMBER_MANAGE)
    if (!isFamilyRole(nextRole)) throw new BadRequestException('角色只能是掌勺人/帮厨/吃货')

    const target = await this.requireMember(familyId, targetUserId)
    if (target.role === nextRole) return this.view(familyId, userId)

    await this.prisma.$transaction(async (tx) => {
      if (nextRole === 'OWNER') {
        // 转让：先把原掌勺人降为帮厨，再升他——保证任何时刻的掌勺人都只有一个
        await tx.familyMember.updateMany({ where: { familyId, role: 'OWNER' }, data: { role: 'COOK' } })
      }
      await tx.familyMember.update({ where: { userId: targetUserId }, data: { role: nextRole } })
    })

    /*
     * 「家庭有变化」：角色动了（用户 2026-10-16）。
     *
     * **做成一件事（"某某现在是掌勺人"）而不是一句流水账**：这一条要通知的是全家，
     * 而"谁动手改的"不重要——重要的是**现在谁是什么角色**（他打开应用要能看到
     * 自己现在能不能改菜单了）。
     *
     * 转让掌勺人时原文一句就够：原掌勺人被降为帮厨是同一件事的另一面
     * （"现在这位是掌勺人了"已经说清了），不为它再发一条——同一动作发两条，
     * 用户看到的是两行说了同一件事的通知。
     *
     * 键带目标用户与最终角色：同一个人被拨到某个角色只提醒一次
     * （拨回去又拨回来不重复，见 `update` 里同一取舍）。
     */
    const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { nickname: true } })
    await this.notifications.recordChange(familyId, {
      kind: 'family',
      action: `把${targetUser?.nickname ?? '家里人'}改成了「${ROLE_LABELS[nextRole]}」`,
      body: nextRole === 'OWNER' ? '现在这一位是掌勺人了' : null,
      to: '/family',
      mealKey: null,
      tag: '角色',
      scope: `role:${targetUserId}:${nextRole}`,
    }, userId)

    return this.view(familyId, userId)
  }

  /** 移出成员（F2-05）——不能移出自己，掌勺人要退出请走 leave */
  async removeMember(userId: string, targetUserId: string): Promise<FamilyView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.MEMBER_MANAGE)
    if (targetUserId === userId) throw new BadRequestException('不能移出自己，请使用“退出家庭”')

    await this.requireMember(familyId, targetUserId)

    /*
     * 名字与通知的对象都要**在删除之前**取：删完就查不到了。
     * 这跟"删一餐记录要把信息带回去"是同一件事（`orders.deleteMeal`）——
     * 任何"删掉之后还想说清它是谁"的地方都得先取。
     */
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { nickname: true } })
    await this.prisma.familyMember.delete({ where: { userId: targetUserId } })

    // 「家庭有变化」：有人被移出（用户 2026-10-16）。
    // 键带被移出者的 id：同一个人被移出两次（加回来又移出）不会重复——一次就够，
    // 而被移出这件事本身他早已知道（是家里有人动手的）。
    await this.notifications.recordChange(familyId, {
      kind: 'family',
      action: `把${target?.nickname ?? '一位家人'}移出了家庭`,
      body: null,
      to: '/family',
      mealKey: null,
      tag: '成员',
      scope: `remove:${targetUserId}`,
    }, userId)

    return this.view(familyId, userId)
  }

  /**
   * 退出家庭。
   * - 普通成员：直接退出。
   * - 掌勺人：还有别人时**不能退**（否则家庭会没有管理员），要先转让；只剩自己时=解散家庭。
   */
  async leave(userId: string): Promise<{ left: true; disbanded: boolean }> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) throw new NotFoundException('你还不在任何家庭里')

    const memberCount = await this.prisma.familyMember.count({ where: { familyId: membership.familyId } })
    if (membership.role === 'OWNER' && memberCount > 1) {
      throw new ConflictException('家里还有别人，先把掌勺人转让给一位成员再退出')
    }

    if (membership.role === 'OWNER') {
      // 只剩自己 → 解散（成员行随家庭级联删除）
      await this.prisma.family.delete({ where: { id: membership.familyId } })
      /*
       * 解散**不发提醒**：家里只剩他自己，`recordChange` 算出来的收件人是空的。
       * 与其特意去调一次、让它在里面空转，不如在这里写清楚为什么没有——
       * 这条分支上"没有通知"是正确结果，不是漏了。
       */
      return { left: true, disbanded: true }
    }

    await this.prisma.familyMember.delete({ where: { userId } })

    /*
     * 「家庭有变化」：有人退出了（用户 2026-10-16）。
     *
     * 在**删除之后**调：`recordChange` 是按"现在这个家里除我之外的人"扇出的，
     * 而他已经不在了——于是收件人天然就是"剩下的人"。不必自己去排掉退出者。
     * 名字此时仍查得到（用户的账号还在，只是不在这个家里了）。
     *
     * 键带 userId + 离开时的成员数：退出再加入再退出时，第一次与第三次的成员数
     * 恰好可能相同（他自己都不算），所以这里用 `left:<familyId>:<userId>:<count>`——
     * 与 `join` 那条同样的形状（那边同理）。极端情况下（反复退入且人数巧合相同）
     * 会少一条提醒，可以接受：**"谁又退出了"重复提醒的价值本来就低**。
     */
    const remaining = await this.prisma.familyMember.count({ where: { familyId: membership.familyId } })
    await this.notifications.recordChange(membership.familyId, {
      kind: 'family',
      action: '退出了家庭',
      body: `现在家里还有 ${remaining} 口人`,
      to: '/family',
      mealKey: null,
      tag: '成员',
      scope: `left:${membership.familyId}:${userId}:${remaining}`,
    }, userId)

    return { left: true, disbanded: false }
  }

  /** 组装对外视图：成员列表 + 我的角色与能力 */
  private async view(familyId: string, viewerId: string): Promise<FamilyView> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: { members: { include: { user: true }, orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }] } },
    })
    if (!family) throw new NotFoundException('家庭不存在')

    const myMembership = family.members.find(m => m.userId === viewerId)
    if (!myMembership) throw new ForbiddenException('你不在这个家庭里')

    const roleOrder: Record<FamilyRole, number> = { OWNER: 0, COOK: 1, EATER: 2 }
    const members: FamilyMemberView[] = family.members
      .map(m => ({
        userId: m.userId,
        nickname: m.user.nickname,
        avatar: m.user.avatar,
        role: m.role as FamilyRole,
        joinedAt: m.joinedAt.toISOString(),
        isMe: m.userId === viewerId,
      }))
      .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.joinedAt.localeCompare(b.joinedAt))

    return {
      id: family.id,
      name: family.name,
      shared: family.shared,
      inviteCode: family.inviteCode,
      createdAt: family.createdAt.toISOString(),
      memberCount: members.length,
      memberLimit: FAMILY_MEMBER_LIMIT,
      myRole: myMembership.role as FamilyRole,
      myCapabilities: capabilitiesOf(myMembership.role as FamilyRole),
      members,
    }
  }

  private async ensureNotInFamily(userId: string): Promise<void> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (membership) throw new ConflictException('你已经有家庭了，想换家庭请先退出原来的')
  }

  private async requireMember(familyId: string, userId: string) {
    const member = await this.prisma.familyMember.findFirst({ where: { familyId, userId } })
    if (!member) throw new NotFoundException('这位成员不在你的家庭里')
    return member
  }

  /** 取"我"的成员身份并校验能力，拿不到就 403 */
  private async requireCapability(userId: string, capability: string) {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) throw new NotFoundException('你还不在任何家庭里')
    const role = membership.role as FamilyRole
    if (!can(role, capability as never)) {
      throw new ForbiddenException('这个操作需要更高的家庭角色')
    }
    return { familyId: membership.familyId, role }
  }

  /** 邀请码随机生成，撞了就重试（32^6 的空间里撞车概率极低，但仍要处理） */
  private async uniqueInviteCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateInviteCode()
      const existing = await this.prisma.family.findUnique({ where: { inviteCode: code } })
      if (!existing) return code
    }
    throw new ConflictException('邀请码生成失败，请重试')
  }
}
