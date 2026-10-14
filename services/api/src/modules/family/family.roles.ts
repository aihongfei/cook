import { randomBytes } from 'node:crypto'

/**
 * 家庭角色与能力表（D-021）。
 *
 * **能力只在这里定义一份**，随家庭接口下发给前端（`myCapabilities`），前端不硬编码 —— 改权限不用改前端。
 * 用户明确选了「纯角色制」：能力完全由角色决定，**不做按人覆盖**，所以这里是 角色 → 能力 的固定映射。
 *
 * 命名用 `域.动作`，M3（点菜）/M4（菜单）落地时直接复用同一批 key，不另起一套。
 */

export const CAPABILITIES = {
  /** 点菜（F3-01） */
  ORDER_CREATE: 'order.create',
  /** 改菜单（F4-01） */
  MENU_MANAGE: 'menu.manage',
  /** 确认做好（F3-02） */
  MENU_CONFIRM: 'menu.confirm',
  /** 管成员：改角色、移出成员（F2-05） */
  MEMBER_MANAGE: 'member.manage',
  /** 重置邀请码（F2-06） */
  INVITE_RESET: 'invite.reset',
  /** 改家庭名与共享开关（F2-07） */
  FAMILY_EDIT: 'family.edit',
} as const

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES]

export type FamilyRole = 'OWNER' | 'COOK' | 'EATER'

export const ROLE_CAPABILITIES: Record<FamilyRole, Capability[]> = {
  OWNER: [
    CAPABILITIES.ORDER_CREATE,
    CAPABILITIES.MENU_MANAGE,
    CAPABILITIES.MENU_CONFIRM,
    CAPABILITIES.MEMBER_MANAGE,
    CAPABILITIES.INVITE_RESET,
    CAPABILITIES.FAMILY_EDIT,
  ],
  COOK: [CAPABILITIES.ORDER_CREATE, CAPABILITIES.MENU_MANAGE, CAPABILITIES.MENU_CONFIRM],
  /**
   * 吃货：点菜 + **把某道菜标成做好了**（2026-10-15 用户明确要求，见 D-075）。
   *
   * 「谁掌勺」这件事在这个应用里是**家里轮流做饭**，而不是"只有掌勺人角色能操作"：
   * 用户的原话是「家庭任何人都可以点击做好，但是要记录是谁点的，谁点的就是谁掌勺的」。
   * **"谁点的"一直都有记录**（`OrderItem.userId`），所以这次只是把这一步的门打开。
   *
   * 只放开了这一个 key：`MENU_CONFIRM` 在全仓库**只有一个消费点**（`TRANSITION_CAPABILITY.DONE`，
   * 见 `orders.rules`），所以给 EATER 加它**不会连带放开**"选好了""开始做""取消这餐"——
   * 那三个走 `MENU_MANAGE`，吃货仍然没有。
   *
   * ⚠️ 共享开关关掉时，"人人可点"只对**参与这一餐的人**成立：家人看不到自己没参与的餐，
   * 也就点不了那餐的「做好了」。这是现有可见性口径的必然结果（D-024 定的"宁可少说"），
   * 不是这次的疏漏。
   */
  EATER: [CAPABILITIES.ORDER_CREATE, CAPABILITIES.MENU_CONFIRM],
}

export const ROLE_LABELS: Record<FamilyRole, string> = {
  OWNER: '掌勺人',
  COOK: '帮厨',
  EATER: '吃货',
}

export const FAMILY_ROLES: FamilyRole[] = ['OWNER', 'COOK', 'EATER']

/** 家庭成员上限：家庭应用没有大群场景，10 人足够，也避免邀请码被拿去拉群 */
export const FAMILY_MEMBER_LIMIT = 10

export function capabilitiesOf(role: FamilyRole): Capability[] {
  return ROLE_CAPABILITIES[role] ?? []
}

export function can(role: FamilyRole, capability: Capability): boolean {
  return capabilitiesOf(role).includes(capability)
}

export function isFamilyRole(value: unknown): value is FamilyRole {
  return typeof value === 'string' && (FAMILY_ROLES as string[]).includes(value)
}

/**
 * 邀请码字符集：去掉 I/O/0/1 这些看起来会认错的字符（口头念给对方时最容易出错），剩 32 个。
 * 6 位 → 32^6 ≈ 10.7 亿种，配合加入接口限流，猜码不现实。
 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 6

export function generateInviteCode(): string {
  // 用 crypto 的随机字节，不用 Math.random：邀请码是"进入家庭"的唯一凭据
  const bytes = randomBytes(INVITE_CODE_LENGTH)
  let code = ''
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length]
  }
  return code
}

/** 用户输入可能带空格与小写（手抄/口述场景），统一成大写再比对 */
export function normalizeInviteCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase()
}
