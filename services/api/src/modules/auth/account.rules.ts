/**
 * 账号与密码的入参口径（F2-01）。
 *
 * 放在这里而不是只写在 DTO 装饰器里，是为了**单测能直接验证规则**，
 * 也让前端提示文案与后端校验共用一套口径（前端只做提示，判定以后端为准）。
 */

export const ACCOUNT_MIN = 3
export const ACCOUNT_MAX = 32
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 64
export const NICKNAME_MAX = 16

/** 账号：允许字母/数字/下划线/点/横线/@（这样邮箱和手机号都能直接当账号，无需短信验证） */
const ACCOUNT_PATTERN = /^[A-Za-z0-9_.@-]+$/

export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase()
}

export function validateAccount(account: string): string | null {
  const value = normalizeAccount(account)
  if (value.length < ACCOUNT_MIN || value.length > ACCOUNT_MAX) {
    return `账号长度需为 ${ACCOUNT_MIN}–${ACCOUNT_MAX} 个字符`
  }
  if (!ACCOUNT_PATTERN.test(value)) return '账号只能包含字母、数字与 _ . - @'
  return null
}

/**
 * 密码：长度 8–64，且必须同时含字母与数字。
 * 只做"最基本的强度要求"，不做复杂度堆砌——家庭应用里过严的规则只会让人写便签贴在冰箱上。
 * 上限 64 是防止超长输入拖慢哈希（scrypt 对长输入本身不慢，但没必要放开）。
 */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `密码长度需为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`
  }
  if (!/[A-Za-z]/.test(password)) return '密码需要包含字母'
  if (!/[0-9]/.test(password)) return '密码需要包含数字'
  return null
}

export function validateNickname(nickname: string): string | null {
  const value = nickname.trim()
  if (!value) return '昵称不能为空'
  if ([...value].length > NICKNAME_MAX) return `昵称最多 ${NICKNAME_MAX} 个字符`
  return null
}

/** 头像用 emoji（与手绘风一致，也免去上传与审核）；只接受白名单里的这几个 */
export const ALLOWED_AVATARS = ['🐰', '🍳', '🐱', '🐻', '🐼', '🦊', '🌸', '🥕'] as const

export function validateAvatar(avatar: string): string | null {
  return (ALLOWED_AVATARS as readonly string[]).includes(avatar) ? null : '头像不在可选范围内'
}
