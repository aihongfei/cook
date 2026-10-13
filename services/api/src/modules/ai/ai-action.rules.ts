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

import type { MealSlot } from '@prisma/client'

/** 一条 AI 动作的种类。v1 只有冰箱三件（A 档），将来收藏/口味按同一形状加 */
export const AI_ACTION_FRIDGE_CREATE = 'fridge.create'
export const AI_ACTION_FRIDGE_UPDATE = 'fridge.update'
export const AI_ACTION_FRIDGE_REMOVE = 'fridge.remove'
/** 自建菜谱与收藏（F1-11/F1-12/F1-09）。**只对自建菜谱生效**，公共菜谱写不进去 */
export const AI_ACTION_RECIPE_CREATE = 'recipe.create'
export const AI_ACTION_RECIPE_UPDATE = 'recipe.update'
export const AI_ACTION_RECIPE_REMOVE = 'recipe.remove'
export const AI_ACTION_FAVORITE_ON = 'favorite.add'
export const AI_ACTION_FAVORITE_OFF = 'favorite.remove'
/**
 * 菜单四件与组合三件（用户 2026-10-13：「软件的 CRUD ai 都可以操作」）。
 *
 * 与冰箱/菜谱同档（A 档：直接写 + 回执）：菜单是**自家这一餐**的事，
 * 与"记一条冰箱食材"同层，而且都能撤回原样。
 */
export const AI_ACTION_MENU_ADD = 'menu.add'
export const AI_ACTION_MENU_REMOVE = 'menu.remove'
export const AI_ACTION_MEAL_DINERS = 'meal.diners'
/**
 * 整餐状态流转。**这个是唯一不可撤的一种**，原因是状态机本身单向
 * （见 `orders.rules` 的 ALLOWED_TRANSITIONS：DONE/CANCELED 是终态，不跳级、不回退）——
 * 不是"懒得做撤销"，而是"回到上一版菜单"在数据上已经不成立。
 * 所以回执上没有「撤」按钮（`undoLabel` 回空串），用户看到的是"这一步做了就定了"。
 */
export const AI_ACTION_MEAL_STATUS = 'meal.status'
export const AI_ACTION_COMBO_CREATE = 'combo.create'
export const AI_ACTION_COMBO_UPDATE = 'combo.update'
export const AI_ACTION_COMBO_REMOVE = 'combo.remove'

export type AiActionKind =
  | typeof AI_ACTION_FRIDGE_CREATE
  | typeof AI_ACTION_FRIDGE_UPDATE
  | typeof AI_ACTION_FRIDGE_REMOVE
  | typeof AI_ACTION_RECIPE_CREATE
  | typeof AI_ACTION_RECIPE_UPDATE
  | typeof AI_ACTION_RECIPE_REMOVE
  | typeof AI_ACTION_FAVORITE_ON
  | typeof AI_ACTION_FAVORITE_OFF
  | typeof AI_ACTION_MENU_ADD
  | typeof AI_ACTION_MENU_REMOVE
  | typeof AI_ACTION_MEAL_DINERS
  | typeof AI_ACTION_MEAL_STATUS
  | typeof AI_ACTION_COMBO_CREATE
  | typeof AI_ACTION_COMBO_UPDATE
  | typeof AI_ACTION_COMBO_REMOVE

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

export type UndoData =
  | FridgeCreateUndo
  | FridgeUpdateUndo
  | FridgeRemoveUndo
  | RecipeCreateUndo
  | RecipeUpdateUndo
  | RecipeRemoveUndo
  | FavoriteUndo
  | MenuAddUndo
  | MenuRemoveUndo
  | DinersUndo
  | MealStatusUndo
  | ComboCreateUndo
  | ComboUpdateUndo
  | ComboRemoveUndo

/** 撤「新建菜谱」= 把那条删掉 */
export interface RecipeCreateUndo {
  recipeId: string
  /**
   * AI 写下时那道菜的样子（用于核对"用户有没有在中间自己改过"）。
   *
   * 收窄成 `Omit<RecipeSnapshot, 'id'>` 的形状（不需要 id，撤销删的是 `recipeId` 那条）：
   * 之前这里只写了 `recipeId`，而 service 实际还存了 `after`——类型没说出真相，
   * 于是读取端把整份 `undoData` 当成快照去比，`recipeId` 在快照里找不到，
   * **每一次撤"新建菜谱"都被误判成"用户改过"而拒绝**（只有真机验证才暴露出来）。
   */
  after: Record<string, unknown>
}
/**
 * 撤「改菜谱」= 把动过的字段写回原值。
 *
 * 与冰箱那条同一个讲究：**只记 AI 动过的字段**。全字段都记的话，
 * "用户后来自己改了备注"会被误判成"与 AI 写下时不一致"而拒绝撤销——
 * 而那次撤销本来是该允许的（AI 只改了做法，备注是用户自己改的）。
 */
export interface RecipeUpdateUndo {
  recipeId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}
/** 撤「删菜谱」= 按原样重建。**整行都要**（菜谱字段多，少一个就少一样东西） */
export interface RecipeRemoveUndo {
  recipe: {
    id: string
    name: string
    category: string
    cuisine: string
    tags: string[]
    aliases: string[]
    ingredients: { name: string; amount: string }[]
    steps: string[]
    notes: string[]
    calories: number | null
    familyId: string | null
    createdById: string | null
    searchText: string
    /*
     * 配图（F1-12 的"给自己家的菜配张图"）。**必须一起带走**——否则用户传了照片的菜
     * 被 AI 删掉再撤回来，照片就没了（那是他自己拍/挑的，重建不出来）。
     * 可选是因为这四列在"从没配过图"的菜上都是空的，老记录里也没有这几个键。
     */
    image?: string | null
    imageKey?: string | null
    imageHash?: string | null
    imageStoredAt?: string | null
  }
}
/** 撤「收藏」= 反过来（收了就取消，取消了就再收上） */
export interface FavoriteUndo {
  recipeId: string
  /** 这次动作之前是"已收藏"还是"未收藏"——撤销就是回到这个状态 */
  wasFavorited: boolean
}

// ---------- 菜单（点菜）与组合 ----------

/** 撤「往某一餐里加了一道菜」= 把那一条点单删掉 */
export interface MenuAddUndo {
  itemId: string
}
/**
 * 撤「从菜单里撤了一道菜」= 照原样再加回去。
 *
 * 记的东西比"加"那边多，原因很实在：点单条目**落地时就散了**
 * （`orders.addItem` 把菜谱解析成"菜名 + 图片"的快照存进条目里，recipeId 可以为空，
 * 见 `resolveItem`），而撤销要重建的是**那条点单**，所以得把当时解析出来的这份快照
 * 原样存下来，不能拿 recipeId 反推。`mealDate`/`meal` 也必须在：
 * 撤掉最后一道菜时整餐会被删掉（`removeItem` 的行为），撤销时那一餐可能已经不存在了。
 */
export interface MenuRemoveUndo {
  item: {
    recipeId: string | null
    recipeName: string
    note: string | null
    mealDate: string
    meal: MealSlot
  }
}

/** 撤「改就餐人数」= 写回原来的人数（`null` = 原来就没定） */
export interface DinersUndo {
  mealKey: string
  before: number | null
  /** AI 写下去的值——用来核对"用户有没有在中间自己改过" */
  after: number | null
}

/** 状态流转的留痕。**没有撤销计划**（见 `AI_ACTION_MEAL_STATUS` 的说明） */
export interface MealStatusUndo {
  mealKey: string
  from: string
  to: string
}

/** 一个组合"长什么样"（撤销要拿它核对用户有没有改过） */
export interface ComboState {
  name: string
  note: string | null
  recipeIds: string[]
}

/** 撤「新建组合」= 删掉它（删之前同样要核对用户没改过，见 `comboTouched`） */
export interface ComboCreateUndo {
  comboId: string
  /** 建好之后的样子（整份都记：新建本来就是把整个组合写下去） */
  after: ComboState
}
/**
 * 撤「改组合」= 只把**动过的那几项**写回原值。
 *
 * 与冰箱/菜谱同一条讲究（见 `FridgeUpdateUndo` 的说明）：只记 AI 动过的字段。
 * 全字段都记的话，"用户后来自己补了句说明"会被误判成"与 AI 写下时不一致"而拒绝撤销——
 * 而那次撤销本来该允许（AI 只换了菜，说明是用户自己写的）。
 */
export interface ComboUpdateUndo {
  comboId: string
  before: Partial<ComboState>
  after: Partial<ComboState>
}
/** 撤「删组合」= 按原样重建（**带 id 与组里的菜**，少一样就少一道菜） */
export interface ComboRemoveUndo {
  combo: {
    id: string
    name: string
    note: string | null
    createdById: string
    /**
     * 这个组合原属哪个家。**必须带上**：重建时若去查"调用者现在属于哪个家"，
     * 用户换了家庭之后撤销就会把一个旧家的组合搬进新家（同菜谱 `restore` 那条说明）。
     */
    familyId: string
    recipeIds: string[]
  }
}

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

/** 一条自建菜谱的现状（撤销要拿它核对）。只放"比对"用得上的字段 */
export interface RecipeSnapshot {
  id: string
  name: string
  category: string
  cuisine: string
  tags: string[]
  aliases: string[]
  ingredients: { name: string; amount: string }[]
  steps: string[]
  notes: string[]
  calories: number | null
}

/**
 * 一条点单条目的现状（撤"加了一道菜"要拿它核对）。
 *
 * `mealStatus` 与 `ownedByActor` 是两个**能不能撤**的判据，而不只是信息：
 * 那一餐已经安排好了就不能再动菜单（撤了等于偷偷改定局）；这条菜要是被别人动过
 * （其实点单条目没有"被改"的操作，只有"被删"与"整餐流转"），也不该照着旧理解去删。
 */
export interface MenuItemSnapshot {
  id: string
  mealStatus: string
  ownedByActor: boolean
}

/** 撤「从菜单里撤了一道菜」时，那一餐现在的样子（`null` = 那一餐已经不存在了） */
export interface MenuOrderSnapshot {
  /** 那一餐里现在有没有同一道菜（按 recipeId 或同名判）——有就说明用户自己又点回来了 */
  hasDish: boolean
  /** 那一餐现在的状态（`null` = 还没成卡，等于可以加回去） */
  status: string | null
  /** 那一天还在能点菜的窗口里吗——过了窗口 `orders.addItem` 会拒，撤销也就做不成 */
  inWindow: boolean
  /**
   * 那一餐现在设定的就餐人数（`null` = 没定）。
   * 撤「改人数」要用它核对用户有没有在中间自己改过——与冰箱那条同一个判据。
   */
  dinerCount: number | null
  /** 那一餐还存在吗（撤人数时要区分"餐没了"与"人数没设过"） */
  exists: boolean
}

/** 一个组合的现状（撤销要拿它核对） */
export interface ComboSnapshot {
  id: string
  name: string
  note: string | null
  recipeIds: string[]
}

/**
 * 撤销时的"现状"。**按动作指向的实体分类**（F1-12 与"全应用 CRUD"之后不止冰箱了）。
 *
 * 为什么不做成一个宽接口（所有字段可选）：那样"撤回菜谱时拿到了冰箱的快照"
 * 会变成一个编译期发现不了的错误，而它的后果是**按错误的理解去改用户的数据**。
 * 判别式联合让每种 kind 只能配它自己那种上下文，配错就是编译不过。
 */
export type UndoContext =
  | { entity: 'fridge'; item: FridgeSnapshot | null }
  | { entity: 'recipe'; recipe: RecipeSnapshot | null }
  /** 收藏只有两种状态，没有"那条不在了"的说法（菜谱被删时收藏记录跟着删，见 schema） */
  | { entity: 'favorite'; favorited: boolean }
  /** 菜单里那一条（撤"加菜"用）。`null` = 那条已经被撤掉了 */
  | { entity: 'menuItem'; item: MenuItemSnapshot | null }
  /** 那一餐（撤"撤菜"与改人数用）。**永远给得出**：那一餐不存在时它的字段就是"空餐" */
  | { entity: 'menuOrder'; order: MenuOrderSnapshot }
  /** 一个组合（`null` = 已经不在了） */
  | { entity: 'combo'; combo: ComboSnapshot | null }

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
  /** 删掉一条菜谱（撤"新建菜谱"） */
  | { op: 'deleteRecipe'; recipeId: string }
  /** 把菜谱的某几个字段写回原值（撤"改菜谱"） */
  | { op: 'updateRecipe'; recipeId: string; patch: Record<string, unknown> }
  /** 按原样重建一条菜谱（撤"删菜谱"）。**带 familyId/createdById**：重建后仍归这个家、这个人 */
  | { op: 'restoreRecipe'; recipe: RecipeRemoveUndo['recipe'] }
  /** 把收藏状态设成指定值（撤"收藏/取消收藏"） */
  | { op: 'setFavorite'; recipeId: string; favorited: boolean }
  /** 删掉一条点单（撤"往菜单里加了一道菜"） */
  | { op: 'removeMenuItem'; itemId: string }
  /** 把撤掉的那道菜照原样点回去（撤"从菜单里撤了一道菜"） */
  | { op: 'restoreMenuItem'; item: MenuRemoveUndo['item'] }
  /** 把就餐人数写回原值（撤"改人数"） */
  | { op: 'setDiners'; mealKey: string; count: number | null }
  /** 删掉一个组合（撤"新建组合"） */
  | { op: 'deleteCombo'; comboId: string }
  /** 把组合写回原样（撤"改组合"）。`patch` 只含 AI 动过的那几项 */
  | { op: 'updateCombo'; comboId: string; patch: Partial<ComboState> }
  /** 按原样重建一个组合（撤"删组合"）。**带 id 与组里的菜** */
  | { op: 'restoreCombo'; combo: ComboRemoveUndo['combo'] }

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
export function planUndo(record: AiActionRecord, context: UndoContext): { plan?: UndoPlan; verdict: UndoVerdict } {
  if (record.undoneAt) return { verdict: { type: 'refused', reason: '这一笔已经撤过了' } }

  // ---------- 冰箱三件 ----------

  if (record.kind === AI_ACTION_FRIDGE_CREATE) {
    const undo = readUndo<FridgeCreateUndo>(record.undoData, ['itemId'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'fridge') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (!context.item) return { verdict: { type: 'already', message: '这条已经不在了' } }
    return { plan: { op: 'delete', itemId: undo.itemId }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_FRIDGE_UPDATE) {
    const undo = readUndo<FridgeUpdateUndo>(record.undoData, ['itemId', 'before', 'after'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'fridge') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    const current = context.item
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
    if (context.entity !== 'fridge') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    /*
     * 撤"删除" = 把它重建回来。它还在（用户自己又记了一条回来）就不动——
     * 硬重建会撞上"同名同区只留一条"的唯一约束，用户拿到的是一个看不懂的错误。
     */
    if (context.item) return { verdict: { type: 'already', message: `「${context.item.name}」还在，没被删` } }
    return { plan: { op: 'restore', itemId: record.targetId ?? '', item: undo.item }, verdict: { type: 'ok' } }
  }

  // ---------- 自建菜谱三件 ----------

  if (record.kind === AI_ACTION_RECIPE_CREATE) {
    const undo = readUndo<RecipeCreateUndo>(record.undoData, ['recipeId'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'recipe') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (!context.recipe) return { verdict: { type: 'already', message: '这道已经不在了' } }
    /*
     * 用户后来自己改过这道（AI 存进去之后他又去编辑了）：撤掉它就把他改的内容一起删了。
     * 与冰箱"改"那条同一个道理——**不许悄悄毁掉用户自己动过的东西**，所以拦住并说清。
     * 这里比冰箱更需要这一层：菜谱里是几段做法与整张配料表，删掉重写成本远高于一条食材。
     *
     * 比的是 `undo.after`（AI 写下时那道菜的样子），**不是整份 undoData**——
     * 后者还带着 `recipeId` 这个键，拿它去比会在菜谱快照里找 `recipeId` 字段，
     * 找不到就判成"被改过"，于是**每一次撤"新建菜谱"都会被拒**（实测踩过）。
     * 形状定义与写法必须严丝合缝：`after` 在文档里就是"用来核对的那份快照"。
     */
    if (recipeTouched(undo.after, context.recipe)) {
      return { verdict: { type: 'refused', reason: '这道你自己改过了，撤掉会连你的改动一起删——不要的话直接删它吧' } }
    }
    return { plan: { op: 'deleteRecipe', recipeId: undo.recipeId }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_RECIPE_UPDATE) {
    const undo = readUndo<RecipeUpdateUndo>(record.undoData, ['recipeId', 'before', 'after'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'recipe') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    const current = context.recipe
    if (!current) return { verdict: { type: 'already', message: '这道已经不在了' } }
    // 只比 AI 动过的那些字段（用户改别的字段不该挡住这次撤销），同冰箱那条
    const moved = Object.keys(undo.after).filter((field) => (
      !sameValue((current as unknown as Record<string, unknown>)[field], undo.after[field])
    ))
    if (moved.length > 0) {
      return { verdict: { type: 'refused', reason: '这道你自己改过了，撤回会把你的改动也盖掉——直接改它吧' } }
    }
    return { plan: { op: 'updateRecipe', recipeId: undo.recipeId, patch: undo.before }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_RECIPE_REMOVE) {
    const undo = readUndo<RecipeRemoveUndo>(record.undoData, ['recipe'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'recipe') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    /*
     * 撤"删菜谱" = 按原样重建。
     *
     * 这里**与冰箱不同**：菜谱有稳定 id，所以"它还在不在"就按 id 查——
     * 在 = 用户自己又建了一道**同一个 id 的**（不可能），或者撤销动作只跑到一半
     * （重建成功但标记没写上）。两种都算"结果已经达成"，不再动它。
     *
     * 另外记着一个已知的边界：**同名冲突没法在这里判**（需要知道这个家里还有没有同名的菜，
     * 而这是库查询、不是纯函数能定的事）。硬重建撞上"你们家已经有一道…"时，
     * 由 service 把那句话如实转给用户——那种情况在真实使用里几乎不出现
     * （AI 删的那道同名菜要是又被用户建了一遍），但一旦出现必须是一句人话而不是 500。
     */
    if (context.recipe) return { verdict: { type: 'already', message: `「${context.recipe.name}」还在，没被删` } }
    return { plan: { op: 'restoreRecipe', recipe: undo.recipe }, verdict: { type: 'ok' } }
  }

  // ---------- 收藏（一个开关，两个方向）----------

  if (record.kind === AI_ACTION_FAVORITE_ON || record.kind === AI_ACTION_FAVORITE_OFF) {
    const undo = readUndo<FavoriteUndo>(record.undoData, ['recipeId', 'wasFavorited'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'favorite') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    /*
     * 撤收藏 = 回到动作之前的那个状态。**天然幂等**：
     * 用户已经自己取消过（或又收藏回来）时，当前状态就等于目标状态，什么都不用做——
     * 这时说"已经是你要的样子了"，而不是再造一次（再造一次会把他的操作反掉）。
     */
    if (context.favorited === undo.wasFavorited) {
      return { verdict: { type: 'already', message: undo.wasFavorited ? '已经是收藏着的了' : '已经取消收藏了' } }
    }
    return { plan: { op: 'setFavorite', recipeId: undo.recipeId, favorited: undo.wasFavorited }, verdict: { type: 'ok' } }
  }

  // ---------- 菜单（点菜）----------

  if (record.kind === AI_ACTION_MENU_ADD) {
    const undo = readUndo<MenuAddUndo>(record.undoData, ['itemId'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'menuItem') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    const item = context.item
    if (!item) return { verdict: { type: 'already', message: '这道菜已经从菜单里去掉了' } }
    /*
     * 那一餐**已经安排定了**（PLANNED/COOKING/DONE）时不能再从菜单里删菜——
     * 那正是 `orders.removeItem` 的规矩（只有待确认阶段能撤自己的菜），
     * 撤销不能绕开它：能绕的话，用户点一下「撤」就把一餐定局的菜单偷偷改了。
     */
    if (item.mealStatus !== 'PENDING') {
      return {
        verdict: {
          type: 'refused',
          reason: item.mealStatus === 'CANCELED'
            ? '这一餐已经取消了，这道菜还在里面就是历史记录，不动它'
            : '这一餐你们已经安排好了，撤菜得先把它取消——去点单页操作吧',
        },
      }
    }
    // 别人点的菜：AI 是替"让 AI 干这事的人"写的，删别人的那道既越权也容易删错
    if (!item.ownedByActor) return { verdict: { type: 'refused', reason: '这道菜是家里别人点的，撤不了' } }
    return { plan: { op: 'removeMenuItem', itemId: undo.itemId }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_MENU_REMOVE) {
    const undo = readUndo<MenuRemoveUndo>(record.undoData, ['item'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'menuOrder') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    const order = context.order
    // 用户自己又点回来了：结果已经是要的样子，不再加一遍（加一遍就成了两份，卡上会多一行）
    if (order.hasDish) return { verdict: { type: 'already', message: `「${undo.item.recipeName}」已经在菜单里了` } }
    /*
     * 加回去要过 `orders.addItem` 那两道门（"这一餐已经安排好了"与"日期在窗口内"），
     * 撤不动时提前说清——用户点「放回去」拿到的应该是一句解释，不是接口的 400。
     */
    if (order.status && order.status !== 'PENDING' && order.status !== 'CANCELED') {
      return {
        verdict: {
          type: 'refused',
          reason: `那一餐已经「${order.status === 'DONE' ? '做好' : '安排'}」了，加不回去`,
        },
      }
    }
    if (!order.inWindow) return { verdict: { type: 'refused', reason: '那一天已经过了点菜的窗口，加不回去了' } }
    return { plan: { op: 'restoreMenuItem', item: undo.item }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_MEAL_DINERS) {
    const undo = readUndo<DinersUndo>(record.undoData, ['mealKey'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'menuOrder') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    const order = context.order
    if (!order.exists) return { verdict: { type: 'already', message: '那一餐已经不在了' } }
    /*
     * 与冰箱"改"那条同一个判据：**用户自己在这之后改过它**就不许悄悄盖回去。
     * 人数是个单值，所以判据就是"现在这个数还是不是 AI 写下的那个"。
     */
    if ((order.dinerCount ?? null) !== (undo.after ?? null)) {
      return { verdict: { type: 'refused', reason: '人数你自己改过了，撤回会把你的改动盖掉——直接改它吧' } }
    }
    return { plan: { op: 'setDiners', mealKey: undo.mealKey, count: undo.before }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_MEAL_STATUS) {
    /*
     * 状态流转**没有撤销计划**，但也不能说"这笔操作不支持撤销"——那句话听起来像出了问题。
     * 用户点到的应该是回执卡上**本来就没有那个按钮**（`undoLabel` 回空串），
     * 所以这里的措辞是"这一步是往前走的，回不去"，并说清该怎么做（去点单页）。
     */
    return { verdict: { type: 'refused', reason: '状态是往前走的，回不去——要改就到点单页重新点这一餐' } }
  }

  // ---------- 常用组合 ----------

  if (record.kind === AI_ACTION_COMBO_CREATE) {
    const undo = readUndo<ComboCreateUndo>(record.undoData, ['comboId', 'after'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'combo') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (!context.combo) return { verdict: { type: 'already', message: '这个组合已经不在了' } }
    // 用户后来自己改过（改名/换菜）：撤掉它会把他的改动一起删——同菜谱那条
    if (comboTouched(undo.after, context.combo)) {
      return { verdict: { type: 'refused', reason: '这个组合你自己改过了，撤掉会连你的改动一起删——不要的话直接删它吧' } }
    }
    return { plan: { op: 'deleteCombo', comboId: undo.comboId }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_COMBO_UPDATE) {
    const undo = readUndo<ComboUpdateUndo>(record.undoData, ['comboId', 'before', 'after'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'combo') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (!context.combo) return { verdict: { type: 'already', message: '这个组合已经不在了' } }
    if (comboTouched(undo.after, context.combo)) {
      return { verdict: { type: 'refused', reason: '这个组合你自己改过了，撤回会把你的改动也盖掉——直接改它吧' } }
    }
    return { plan: { op: 'updateCombo', comboId: undo.comboId, patch: undo.before }, verdict: { type: 'ok' } }
  }

  if (record.kind === AI_ACTION_COMBO_REMOVE) {
    const undo = readUndo<ComboRemoveUndo>(record.undoData, ['combo'])
    if (!undo) return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    if (context.entity !== 'combo') return { verdict: { type: 'refused', reason: '这笔记录的格式不认识，撤不了' } }
    /*
     * 与菜谱同一条：组合有稳定 id，"它还在不在"按 id 查。
     * 在 = 用户自己又建了一个同 id 的（不可能），或者撤销只跑到一半。
     *
     * 已知边界：**同家重名没法在这里判**（要靠库查询）。硬重建撞上
     * "家里已经有一个叫…的组合了"时由 service 把那句话如实转给用户。
     */
    if (context.combo) return { verdict: { type: 'already', message: `「${context.combo.name}」还在，没被删` } }
    return { plan: { op: 'restoreCombo', combo: undo.combo }, verdict: { type: 'ok' } }
  }

  return { verdict: { type: 'refused', reason: '这笔操作不支持撤销' } }
}

/** 一个组合相对 AI 写下去的那一刻，有没有被动过（只看 `after` 里记着的那几项） */
function comboTouched(after: Partial<ComboState>, current: ComboSnapshot): boolean {
  const now = current as unknown as Record<string, unknown>
  return Object.keys(after).some((key) => !sameValue(now[key], (after as Record<string, unknown>)[key]))
}

/**
 * 这道菜谱相对 AI 写下去的那一刻，有没有被动过。
 *
 * 单独抽出来是因为"怎么算改过"在菜谱上比冰箱麻烦：字段里有数组与对象列表
 * （配料、步骤、标签），`!==` 比不了——两个内容相同的数组也是不同的引用。
 * 所以逐字段深比（`sameValue`）。判错的两个方向都是实打实的损失：
 * 判宽了会悄悄删掉用户改过的内容，判严了会让正确的撤销被拒。
 */
function recipeTouched(after: Record<string, unknown>, current: RecipeSnapshot): boolean {
  const fields = Object.keys(after)
  if (fields.length === 0) return false
  const now = current as unknown as Record<string, unknown>
  return fields.some((field) => !sameValue(now[field], after[field]))
}

/** 深比较（只为撤销判定服务：只需要"一样/不一样"，不需要排序无关的等价） */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...keys].every((key) => sameValue(left[key], right[key]))
  }
  // null/undefined 视为同一种"没有值"：JSON 列读回来时两者会混着出现
  return (a ?? null) === (b ?? null)
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

/**
 * 从"菜单类"动作的 `undoData` 里读出**要查哪一餐、哪道菜**。
 *
 * 两种 `undoData` 都认：撤「加菜」（`{itemId}`，那一餐与菜名得从库里查）与
 * 撤「撤菜」「改人数」（`{item:{mealDate,meal,…}}` / `{mealKey}`）。
 * 返回 `null` = 读不懂（调用方按"查不到现状"处理，`planUndo` 还会再拦一次）。
 *
 * 为什么放纯函数里而不是 service 内联：这层的形状判断与 `removedItemKey` 是同一类活，
 * 单测能直接钉住"撤菜那笔不按 itemId 查现状"这种坑（与冰箱那条一模一样的坑）。
 */
export function menuUndoTarget(raw: unknown): {
  mealDate: string
  meal: MealSlot
  dish: { recipeId: string | null; recipeName: string }
} | null {
  const record = raw as Record<string, unknown> | null
  if (!record || typeof record !== 'object') return null

  const mealKey = typeof record.mealKey === 'string' ? record.mealKey : ''
  const fromKey = /^(\d{4}-\d{2}-\d{2})-(LUNCH|DINNER)$/.exec(mealKey)
  if (fromKey) {
    // 改人数那笔：只有 mealKey，没有具体的菜
    return { mealDate: fromKey[1], meal: fromKey[2] as MealSlot, dish: { recipeId: null, recipeName: '' } }
  }

  const item = record.item as Record<string, unknown> | undefined
  if (!item) return null
  const mealDate = typeof item.mealDate === 'string' ? item.mealDate : ''
  const meal = item.meal
  const recipeName = typeof item.recipeName === 'string' ? item.recipeName : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) return null
  if (meal !== 'LUNCH' && meal !== 'DINNER') return null
  if (!recipeName) return null
  return {
    mealDate,
    meal,
    dish: {
      recipeId: typeof item.recipeId === 'string' ? item.recipeId : null,
      recipeName,
    },
  }
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
  // 菜谱三件与冰箱同一套说法（删掉 / 改回去 / 重新建回来）——用户眼里都是"把刚才那下反过来"
  if (kind === AI_ACTION_RECIPE_CREATE) return '撤掉'
  if (kind === AI_ACTION_RECIPE_UPDATE) return '改回去'
  if (kind === AI_ACTION_RECIPE_REMOVE) return '放回去'
  // 收藏是一个开关，两个方向的按钮说的是同一件事：把收藏状态按回去
  if (kind === AI_ACTION_FAVORITE_ON || kind === AI_ACTION_FAVORITE_OFF) return '收回去'
  // 菜单与组合沿用同一套（加菜撤掉、撤菜放回去、改组合/改人数改回去、删组合放回去）
  if (kind === AI_ACTION_MENU_ADD) return '撤掉'
  if (kind === AI_ACTION_MENU_REMOVE) return '放回去'
  if (kind === AI_ACTION_MEAL_DINERS) return '改回去'
  if (kind === AI_ACTION_COMBO_CREATE) return '撤掉'
  if (kind === AI_ACTION_COMBO_UPDATE) return '改回去'
  if (kind === AI_ACTION_COMBO_REMOVE) return '放回去'
  /*
   * 状态流转**回不去**（见 `AI_ACTION_MEAL_STATUS`）：回空串，回执卡上就不会长出
   * 一个点了也只会被拒的按钮。前端按 `label` 为空决定不画那颗按钮——
   * 比让前端按 kind 去判断好：加一种新的不可撤动作时这里改一处就够，
   * 前端不用知道那个 kind 叫什么。
   */
  if (kind === AI_ACTION_MEAL_STATUS) return ''
  return '撤销'
}

/**
 * 回执卡上那句"做了什么"的**动词**（回执文案由各 service 拼好，这里只补一句统一说法）。
 * 与 `undoLabel` 分开：那个是按钮上的字（"撤掉"），这个是回执抬头（"已经帮你办好了"）。
 */
export function actionKindLabel(kind: string): string {
  if (kind.startsWith('fridge.')) return '冰箱'
  if (kind.startsWith('recipe.')) return '菜谱'
  if (kind.startsWith('favorite.')) return '收藏'
  // 菜单与餐次都归"菜单"（用户眼里"今晚加了道菜"和"改成 4 个人吃"是同一件事的两面）
  if (kind.startsWith('menu.') || kind.startsWith('meal.')) return '菜单'
  if (kind.startsWith('combo.')) return '组合'
  return '数据'
}
