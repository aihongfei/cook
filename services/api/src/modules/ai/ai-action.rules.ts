/**
 * AI 助手**写库动作的反向动作**（F16-10 / D-052，用户 2026-10-13 拍板"加表"）。
 *
 * 这一条的需求本身很简单——"AI 帮我记了冰箱，我点一下能撤回去"。难的在于**判断能不能撤**，
 * 而这件事只能在服务端做（把旧值随回执卡发到前端、让前端自己拼一个反向请求，等于让客户端
 * 决定服务端写什么，且三种意外一个都判不了）：
 *
 * ① **那条已经被用户自己改过**：AI 记了"一盒"，用户改成"半盒"之后点「撤」，
 *    撤回的是"删掉那条"——他的改动也跟着没了。所以撤销前要**核对当前值与 AI 写下时是否一致**，
 *    不一致就拒绝，并说清"你先改过它了"（让它自己决定要不要删）。
 * ② **那条已经被删了**：撤销"新建"时要删的那条已经不在了。这时**不算失败**——
 *    结果正是用户想要的（那条不在了），但要如实说"它已经不在了"，而不是假装撤成功。
 * ③ **已经撤过一次**：同一笔不能撤两次，否则第二次会去删一条**别的**记录（id 已被复用或对不上）。
 *
 * 这个文件**不碰数据库也不碰网络**：undo 计划（`planUndo`）与校验（`verifyUndo`）都是纯函数，
 * 可以直接单测，不用起 MySQL。写库那半在 ai-action.service。
 */

/** 一条 AI 动作的种类。v1 只有冰箱三件（A 档），将来收藏/口味按同一形状加 */
export const AI_ACTION_FRIDGE_CREATE = 'fridge.create'
export const AI_ACTION_FRIDGE_UPDATE = 'fridge.update'
export const AI_ACTION_FRIDGE_REMOVE = 'fridge.remove'

export type AiActionKind =
  | typeof AI_ACTION_FRIDGE_CREATE
  | typeof AI_ACTION_FRIDGE_UPDATE
  | typeof AI_ACTION_FRIDGE_REMOVE

/**
 * 存进 `undoData` 的形状（按 kind 区分）。
 *
 * 刻意**不存整行快照**：撤销需要的信息在写的那一刻就已经知道了，把"怎么回去"记成动作本身，
 * 就不必在库里留一份用户数据的影子副本（冰箱里有什么是很私人的事）。
 */
export interface FridgeCreateUndo {
  itemId: string
}
export interface FridgeUpdateUndo {
  itemId: string
  /** 改之前的值（只记动过的那些字段，没动的不记） */
  before: { name?: string; amount?: string | null; zone?: string; expiresOn?: string | null; note?: string | null }
  /** AI 写之后的值——用来核对"用户有没有在中间自己改过" */
  after: { name?: string; amount?: string | null; zone?: string; expiresOn?: string | null; note?: string | null }
}
export interface FridgeRemoveUndo {
  /** 被删掉的那条原来的样子（撤 = 照原样再建一条） */
  item: {
    name: string
    amount: string | null
    zone: string
    expiresOn: string | null
    note: string | null
  }
}

export type UndoData = FridgeCreateUndo | FridgeUpdateUndo | FridgeRemoveUndo

/**
 * 撤销时数据库里那条的现状（由调用方查好传进来）。`null` = 已经不在了。
 *
 * 字段与 `fridge.rules` 的视图对齐（`expiresOn` 用 `YYYY-MM-DD` 字符串，不用 Date：
 * 纯函数里比较日期字符串比比较 Date 对象少一层时区陷阱）。
 */
export interface FridgeSnapshot {
  id: string
  name: string
  amount: string | null
  zone: string
  expiresOn: string | null
  note: string | null
}

/** 撤销的判定结果。三态**都带一句人话**——界面上要原样显示给用户 */
export type UndoVerdict =
  /** 照计划执行 */
  | { type: 'ok' }
  /** 撤不了：说明为什么（如"这条你先自己改过"） */
  | { type: 'refused'; reason: string }
  /** 没什么可撤的，但结果已经是用户要的（如"那条已经不在了"） */
  | { type: 'already'; message: string }

/** 一笔 AI 动作在库里的样子（service 查出来交进来） */
export interface AiActionRecord {
  id: string
  kind: string
  undoData: unknown
  undoneAt: Date | null
  targetId: string | null
}

/** 撤销要执行的动作（service 按它去写库） */
export type UndoPlan =
  | { op: 'delete'; itemId: string }
  | { op: 'restore'; itemId: string; item: FridgeRemoveUndo['item'] }
  | { op: 'update'; itemId: string; item: FridgeUpdateUndo['before'] }

/**
 * 这一步的判断顺序是刻意的，**先判"能不能撤"再判"该撤什么"**：
 *
 * 1. **已经撤过**：直接拒绝（再撤一次会去动一条不该动的记录）；
 * 2. **形状不认识**：拒绝——不给"猜一个最像的"的机会。`undoData` 是 JSON 列，
 *    历史数据、手工改库、将来降级回滚都可能塞进一个本版本读不懂的值，
 *    这时候**宁可拒绝**也不能按错误的理解去删用户的数据；
 * 3. **当前值与 AI 写下时不一致**：拒绝，并指出"你先改过它了"（见文件头 ①）；
 * 4. **那条已经不在了**：`delete` 与 `update` 这两种"以删/改某条为前提"的撤销，
 *    结果已经达成 → `already`（见文件头 ②）；`restore`（撤"删除"那笔）不一样：
 *    "回到它还在的样子"本来就是要重建，它不在**正是该撤的时候**。
 */
export function planUndo(record: AiActionRecord, current: FridgeSnapshot | null): { plan?: UndoPlan; verdict: UndoVerdict } {
  if (record.undoneAt) return { verdict: { type: 'refused', reason: '这一笔已经撤过了' } }

  if (record.kind === AI_ACTION_FRIDGE_CREATE) {
    const undo = readUndo<FridgeCreateUndo>(record.undoData, ['itemId'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (!current) return { verdict: { type: 'already', message: '这条已经不在了' } }
    return { plan: { op: 'delete', itemId: undo.itemId }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_FRIDGE_UPDATE) {
    const undo = readUndo<FridgeUpdateUndo>(record.undoData, ['itemId', 'before', 'after'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (!current) return { verdict: { type: 'already', message: '这条已经不在了' } }
    // 用户自己在这之后改过它：撤回 before 会把他的改动一并盖掉，不能悄悄做
    const moved = Object.keys(undo.after).filter((field) => {
      const key = field as keyof typeof undo.after
      return current[key as keyof FridgeSnapshot] !== undo.after[key]
    })
    if (moved.length > 0) {
      return {
        verdict: { type: 'refused', reason: '这条你自己改过了，撤回会把你的改动也盖掉——直接改它吧' },
      }
    }
    return { plan: { op: 'update', itemId: undo.itemId, item: undo.before }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_FRIDGE_REMOVE) {
    const undo = readUndo<FridgeRemoveUndo>(record.undoData, ['item'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    /*
     * 撤"删除" = 把它重建回来。它还在（用户自己又记了一条回来）就不动——
     * 硬重建会撞上"同名同区只留一条"的唯一约束，用户拿到的是一个看不懂的错误。
     */
    if (current) return { verdict: { type: 'already', message: `「${current.name}」还在，没被删` } }
    return { plan: { op: 'restore', itemId: record.targetId ?? '', item: undo.item }, verdict: { type: 'ok' } }
  }

  return { verdict: { type: 'refused', reason: '这笔操作不支持撤销' } }
}

/**
 * 把 JSON 列读成期望的形状。**只认形状，不认"意思"**：
 * 缺字段、类型不对就当读不懂（返回 null），由调用方翻成一句拒绝的话。
 *
 * 为什么不在这里做 `as` 强转：那个 JSON 是从库里读回来的，可能是任何东西；
 * 按错误理解去删用户的数据，比干脆说"撤不了"糟得多。
 */
function readUndo<T>(raw: unknown, required: string[]): T | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  for (const key of required) {
    if (!(key in record) || record[key] === null || record[key] === undefined) return null
  }
  return record as T
}

/**
 * 撤「删除」时，怎么在库里找"它回来了吗"——**按同名同区，不能按 id**。
 *
 * 这正是第一版没验出来的那个错：撤销删掉的那条时，服务端按 `targetId`（被删的那条 id）
 * 去查现状，那个 id 在库里**必然查不到**——这恰恰是"它被删掉了"的证据，于是
 * `planUndo` 里那条"用户自己又记回来了"的分支永远走不到，撤销照着重建走，
 * 一头撞上 `(家庭, 区, 名)` 的唯一约束，用户看到的是记东西时才该出现的
 * 「已经记了一条，直接改它就行」。判据得和唯一约束一致：问的是名字与格子。
 *
 * 返回 null = 这条记录读不懂（shape 不对），调用方按"查不到"处理即可（planUndo 还会再拦一次）。
 */
export function removedItemKey(raw: unknown): { name: string; zone: string } | null {
  const undo = readUndo<FridgeRemoveUndo>(raw, ['item'])
  const item = undo?.item
  if (!item || typeof item.name !== 'string' || typeof item.zone !== 'string') return null
  return { name: item.name, zone: item.zone }
}

/** 回执卡上那句话（"鸡蛋 · 一盒 · 冷藏"）。写的那一刻就拼好，库里存下来 */
export function describeFridgeItem(item: { name: string; amount?: string | null; zone?: string }): string {
  return [item.name, item.amount ?? null, item.zone ?? null].filter(Boolean).join(' · ')
}

/** 撤销按钮上的字（"撤掉这笔"太抽象，用户想知道撤的是什么） */
export function undoLabel(kind: string): string {
  if (kind === AI_ACTION_FRIDGE_CREATE) return '撤掉'
  if (kind === AI_ACTION_FRIDGE_UPDATE) return '改回去'
  if (kind === AI_ACTION_FRIDGE_REMOVE) return '放回去'
  return '撤销'
}
