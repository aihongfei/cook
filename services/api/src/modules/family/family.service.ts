import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../recipes/prisma.service'
import {
  CAPABILITIES, FAMILY_MEMBER_LIMIT, FamilyRole, can, capabilitiesOf,
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
  constructor(private readonly prisma: PrismaService) {}

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
    return this.view(familyId, userId)
  }

  /** 重置邀请码（F2-06）——旧码立即失效 */
  async resetInviteCode(userId: string): Promise<FamilyView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.INVITE_RESET)
    await this.prisma.family.update({ where: { id: familyId }, data: { inviteCode: await this.uniqueInviteCode() } })
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
    return this.view(familyId, userId)
  }

  /** 移出成员（F2-05）——不能移出自己，掌勺人要退出请走 leave */
  async removeMember(userId: string, targetUserId: string): Promise<FamilyView> {
    const { familyId } = await this.requireCapability(userId, CAPABILITIES.MEMBER_MANAGE)
    if (targetUserId === userId) throw new BadRequestException('不能移出自己，请使用“退出家庭”')

    await this.requireMember(familyId, targetUserId)
    await this.prisma.familyMember.delete({ where: { userId: targetUserId } })
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
      return { left: true, disbanded: true }
    }

    await this.prisma.familyMember.delete({ where: { userId } })
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
