import { BadRequestException } from '@nestjs/common'

/**
 * 常用组合的纯规则（M4 / F4-04）。口径见 D-029。
 *
 * 与其他 `*.rules.ts` 同一套路：**不碰数据库的判定都放这里**，
 * 单测直接验（名字长度、去重、上限、"整组加入"要跳过哪些），不用起 MySQL。
 */

/** 组合名上限 24 字：够写「工作日的快手三菜一汤」，再长在卡片上就折行了 */
export const COMBO_NAME_MAX = 24
/** 说明一行 60 字，与打卡备注同一个量级 */
export const COMBO_NOTE_MAX = 60
/**
 * 一组最多 12 道。上限不是为了省资源，而是**这个概念的语义**：
 * 一顿饭要不要做十二道菜另说，但"一键加进去"的组，超过这个数就不像"常做的组合"了。
 */
export const COMBO_ITEMS_MAX = 12

export function parseComboName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('组合名要写成文字')
  const name = raw.trim()
  if (!name) throw new BadRequestException('组合名不能为空')
  if (name.length > COMBO_NAME_MAX) throw new BadRequestException(`组合名最多 ${COMBO_NAME_MAX} 个字`)
  return name
}

export function parseComboNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new BadRequestException('说明只能是一段文字')
  const note = raw.trim()
  if (!note) return null
  if (note.length > COMBO_NOTE_MAX) throw new BadRequestException(`说明最多 ${COMBO_NOTE_MAX} 个字`)
  return note
}

/**
 * 组里的菜 id 列表：去重（保序）、上限、非空。
 *
 * **去重在这里做**（而不是靠库的唯一约束报错）：同一个组合里重复同一道菜是明显的误操作，
 * 用户看到的应该是"重复的自动去掉"，而不是一句 `Unique constraint failed`。
 * 保序：组合的顺序就是用户点选的顺序，卡片上照着显示。
 */
export function parseRecipeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequestException('菜要写成一个列表')
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('菜 id 要写成文字')
    const id = item.trim()
    if (!id || ids.includes(id)) continue
    ids.push(id)
    if (ids.length > COMBO_ITEMS_MAX) throw new BadRequestException(`一组最多 ${COMBO_ITEMS_MAX} 道菜`)
  }
  if (ids.length === 0) throw new BadRequestException('一组至少要有 1 道菜')
  return ids
}

export interface AddOutcome {
  /** 要加进去的 */
  toAdd: string[]
  /** 那一餐里本来就有的（跳过，不叠加份数） */
  skipped: string[]
}

/**
 * 一键加入时挑出"要加的"与"本来就有的"。
 *
 * **已有的跳过、不叠加份数**：组合的语义是"这一组菜出现在这一餐"，
 * 而不是"再点一遍"——叠上去的结果是同一道菜在两行、份数 ×2，用户点一下"一键加入"
 * 却得到了两道菜的量（还可能被掌勺人当成两个人想吃）。跳过之后，
 * 同一个组合点两次也不会变样（幂等），这一点由服务层返回的 `skipped` 告诉用户。
 */
export function planAdd(existing: string[], wanted: string[]): AddOutcome {
  const has = new Set(existing)
  const toAdd: string[] = []
  const skipped: string[] = []
  for (const id of wanted) {
    if (has.has(id)) skipped.push(id)
    else toAdd.push(id)
  }
  return { toAdd, skipped }
}

/**
 * 谁能改 / 删这个组合：**组它的人自己**，或**掌勺人/帮厨**（`menu.manage`）。
 *
 * 组合是全家人共用的，但"别人辛苦组的菜单被人一键删了"这种事不该发生；
 * 掌勺人/帮厨要打理家里的菜单，给他们留了口子（与改菜单同一批人）。
 * 只看不控：任何成员都能用任何组合一键加入——那本来就是个方便。
 */
export function canEditCombo(createdById: string, viewerId: string, mayManageMenu: boolean): boolean {
  return createdById === viewerId || mayManageMenu
}
