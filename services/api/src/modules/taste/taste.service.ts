import { Injectable } from '@nestjs/common'
import { Prisma, type TasteProfile as TasteRow } from '@prisma/client'
import { PrismaService } from '../recipes/prisma.service'
import {
  isFilled,
  missingProfiles,
  parseTasteProfile,
  type TasteProfile,
  type TasteProfileView,
} from './taste.rules'

/**
 * 口味与健康档案（M8 / F8-01、F8-02）。
 *
 * **自己只能改自己的**：档案是本人的（"我对花生过敏"这件事不是家里别人能替你改的），
 * 所以这里没有"掌勺人代改"那条路。全家那份是**只读**的聚合，给推荐与提醒用。
 */
@Injectable()
export class TasteService {
  constructor(private readonly prisma: PrismaService) {}

  /** 我自己的档案（没有就是空白档案，不建行——"没说过"不该在库里留一条空记录） */
  async mine(userId: string): Promise<TasteProfileView | null> {
    const row = await this.prisma.tasteProfile.findUnique({ where: { userId } })
    if (!row) return null
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true, avatar: true } })
    return toView(userId, user?.nickname ?? '我', user?.avatar ?? '🐰', row)
  }

  /**
   * 全家的档案（含**没写的那些人**）。
   *
   * 为什么要把没写的也带上：界面上要明说"还有 N 人没写"（taste.rules 文件头 ③）。
   * 只回填过的那几条，用户看到的是"全家都护上了"——而实际上可能只有他自己填了，
   * 家里对花生过敏的那位根本没写，于是推荐照常推花生。**这种"看着安全其实没保护"
   * 比没有这个功能更危险。**
   */
  async family(userId: string): Promise<{
    me: TasteProfileView | null
    members: TasteProfileView[]
    /** 还没写档案的成员昵称（界面照直说） */
    missing: string[]
    /** 这家人人都在用的档案（判据用）：只含**填过**的那些 */
    active: { userId: string; nickname: string; profile: TasteProfile }[]
  }> {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: { include: { members: { include: { user: true } } } } },
    })
    if (!membership) {
      const me = await this.mine(userId)
      return {
        me,
        members: me ? [me] : [],
        missing: me && isFilled(me) ? [] : ['我'],
        active: me && isFilled(me) ? [{ userId, nickname: me.nickname, profile: toProfile(me) }] : [],
      }
    }

    const memberIds = membership.family.members.map((member) => member.userId)
    const rows = await this.prisma.tasteProfile.findMany({ where: { userId: { in: memberIds } } })
    const byUser = new Map(rows.map((row) => [row.userId, row]))

    const members: TasteProfileView[] = membership.family.members.map((member) => {
      const row = byUser.get(member.userId)
      return row
        ? toView(member.userId, member.user.nickname, member.user.avatar, row)
        : emptyView(member.userId, member.user.nickname, member.user.avatar)
    })

    // 排序让"我"在最前（设置页一进来先看到自己）
    members.sort((a, b) => (a.userId === userId ? -1 : b.userId === userId ? 1 : a.nickname.localeCompare(b.nickname)))

    return {
      me: members.find((item) => item.userId === userId) ?? null,
      members,
      missing: missingProfiles(members.map((item) => ({ userId: item.userId, nickname: item.nickname, profile: item.filled ? toProfile(item) : null }))),
      active: members
        .filter((item) => item.filled)
        .map((item) => ({ userId: item.userId, nickname: item.nickname, profile: toProfile(item) })),
    }
  }

  /**
   * 改我自己的档案（部分更新：`undefined` 的字段不动）。
   *
   * 用 upsert 而不是"先查再建"：第一次填档案时那两个请求之间可能并发
   * （用户在设置页连点两下），而 `userId` 是唯一键——让数据库来保证只有一条。
   */
  async update(userId: string, raw: unknown): Promise<TasteProfileView> {
    const patch = parseTasteProfile(raw)
    const data: Prisma.TasteProfileUncheckedCreateInput = {
      userId,
      spicyLevel: patch.spicyLevel ?? null,
      flavors: (patch.flavors ?? []) as Prisma.InputJsonValue,
      diet: patch.diet ?? null,
      allergies: (patch.allergies ?? []) as Prisma.InputJsonValue,
      dislikes: (patch.dislikes ?? []) as Prisma.InputJsonValue,
      note: patch.note ?? null,
    }
    // 只把**这次给了的**字段写进去，其余沿用库里的值（部分更新的实质）
    const updateData: Prisma.TasteProfileUpdateInput = {}
    if (patch.spicyLevel !== undefined) updateData.spicyLevel = patch.spicyLevel
    if (patch.flavors !== undefined) updateData.flavors = patch.flavors as Prisma.InputJsonValue
    if (patch.diet !== undefined) updateData.diet = patch.diet
    if (patch.allergies !== undefined) updateData.allergies = patch.allergies as Prisma.InputJsonValue
    if (patch.dislikes !== undefined) updateData.dislikes = patch.dislikes as Prisma.InputJsonValue
    if (patch.note !== undefined) updateData.note = patch.note

    const row = await this.prisma.tasteProfile.upsert({
      where: { userId },
      create: data,
      update: updateData,
    })
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true, avatar: true } })
    return toView(userId, user?.nickname ?? '我', user?.avatar ?? '🐰', row)
  }
}

/** 库里的行 → 界面形状（Json 列要按数组读，脏数据一律当空数组而不是崩掉） */
function toView(userId: string, nickname: string, avatar: string, row: TasteRow): TasteProfileView {
  const profile: TasteProfile = {
    spicyLevel: row.spicyLevel,
    flavors: readTags(row.flavors),
    diet: (row.diet as TasteProfile['diet']) ?? null,
    allergies: readTags(row.allergies),
    dislikes: readTags(row.dislikes),
    note: row.note,
  }
  return {
    userId,
    nickname,
    avatar,
    ...profile,
    filled: isFilled(profile),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 还没写过档案的人（前端画"他还没写"那一行） */
function emptyView(userId: string, nickname: string, avatar: string): TasteProfileView {
  return {
    userId,
    nickname,
    avatar,
    spicyLevel: null,
    flavors: [],
    diet: null,
    allergies: [],
    dislikes: [],
    note: null,
    filled: false,
    updatedAt: null,
  }
}

/** 界面形状 → 判据形状（判据只认那六个字段） */
function toProfile(view: TasteProfileView): TasteProfile {
  return {
    spicyLevel: view.spicyLevel,
    flavors: view.flavors,
    diet: view.diet,
    allergies: view.allergies,
    dislikes: view.dislikes,
    note: view.note,
  }
}

function readTags(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}
