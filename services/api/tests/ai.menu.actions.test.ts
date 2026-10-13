import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_ACTION_COMBO_CREATE,
  AI_ACTION_COMBO_REMOVE,
  AI_ACTION_COMBO_UPDATE,
  AI_ACTION_MEAL_DINERS,
  AI_ACTION_MEAL_STATUS,
  AI_ACTION_MENU_ADD,
  AI_ACTION_MENU_REMOVE,
  actionKindLabel,
  menuUndoTarget,
  planUndo,
  undoLabel,
  type AiActionRecord,
  type UndoContext,
} from '../src/modules/ai/ai-action.rules'
import {
  MENU_ADD_MAX,
  comboText,
  menuText,
  readComboDraft,
  readDiners,
  readMealStatus,
  readMealTarget,
  readMenuAdds,
} from '../src/modules/ai/ai.tools'

/**
 * 菜单、餐次与组合的"能不能撤"（用户 2026-10-13：「软件的 CRUD ai 都可以操作」）。
 *
 * 与冰箱那块（ai.actions.test.ts）同一个套路，但这里多了两件菜单特有的危险：
 *
 * ① **那一餐已经定局**：撤菜会把"已经安排好的菜单"偷偷改掉——`orders.removeItem`
 *    本身就禁止（只有待确认阶段能撤），撤销必须判得一样严，不能成为绕过它的后门；
 * ② **撤别人的菜**：AI 是替"让 AI 干这事的人"写的，删家里别人点的那道既越权也容易删错。
 *
 * 另外单独钉两类"结果已达成"的幂等分支（用户自己又点回来了 / 自己又建了同名组合），
 * 它们要的是"什么都不做 + 说清楚"，而不是再动手一次。
 */

function record(over: Partial<AiActionRecord> = {}): AiActionRecord {
  return { id: 'a1', kind: AI_ACTION_MENU_ADD, undoData: { itemId: 'i1' }, undoneAt: null, targetId: 'i1', ...over }
}

/** 一张"点单条目"的现状（撤"加菜"要看它） */
function menuItem(over: Partial<{ mealStatus: string; ownedByActor: boolean }> = {}): UndoContext {
  return { entity: 'menuItem', item: { id: 'i1', mealStatus: 'PENDING', ownedByActor: true, ...over } }
}

// ---------- 撤「加菜」----------

test('撤「加菜」：待确认 + 自己点的 → 删掉那条', () => {
  const { plan, verdict } = planUndo(record(), menuItem())
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'removeMenuItem', itemId: 'i1' })
})

test('撤「加菜」：那条已经不在了 → 说清"已经从菜单里去掉了"，不再动手', () => {
  const { plan, verdict } = planUndo(record(), { entity: 'menuItem', item: null })
  assert.equal(verdict.type, 'already')
  assert.equal(plan, undefined)
  assert.match((verdict as { message: string }).message, /已经从菜单里/)
})

test('撤「加菜」：那一餐已经安排好了 → 拒绝（撤销不能绕过"只有待确认能撤菜"）', () => {
  const { plan, verdict } = planUndo(record(), menuItem({ mealStatus: 'PLANNED' }))
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  // 话要给出下一步（去点单页取消这一餐），不能只说"不行"
  assert.match((verdict as { reason: string }).reason, /取消/)
})

test('撤「加菜」：那一餐已做好（终态）→ 也拒绝，且不提议"取消这餐"那种做不到的事', () => {
  const { plan, verdict } = planUndo(record(), menuItem({ mealStatus: 'DONE' }))
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
})

test('撤「加菜」：那道菜是家里别人点的 → 拒绝（不能替别人撤）', () => {
  const { plan, verdict } = planUndo(record(), menuItem({ ownedByActor: false }))
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /别人点的/)
})

// ---------- 撤「撤菜」----------

const removedDish = {
  item: { recipeId: 'r9', recipeName: '番茄炒蛋', note: '少放辣', mealDate: '2026-10-13', meal: 'DINNER' as const },
}

/** 撤"撤菜"要看的是**那一餐**的现状（不是那条 itemId——它已经不存在了） */
function menuOrder(over: Partial<{ hasDish: boolean; status: string | null; inWindow: boolean; dinerCount: number | null; exists: boolean }> = {}): UndoContext {
  return {
    entity: 'menuOrder',
    order: { hasDish: false, status: 'PENDING', inWindow: true, dinerCount: null, exists: true, ...over },
  }
}

test('撤「撤菜」：那一餐还能加 → 照原样点回去（含备注与原菜谱 id）', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_REMOVE, undoData: removedDish }),
    menuOrder(),
  )
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'restoreMenuItem', item: removedDish.item })
})

test('撤「撤菜」：用户自己又点回来了 → 说"已经在菜单里了"，不再加一遍（否则卡上会多一行）', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_REMOVE, undoData: removedDish }),
    menuOrder({ hasDish: true }),
  )
  assert.equal(verdict.type, 'already')
  assert.equal(plan, undefined)
  assert.match((verdict as { message: string }).message, /番茄炒蛋/)
})

test('撤「撤菜」：那一餐已经安排好了 → 拒绝（能加回去就等于偷偷改了定局的菜单）', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_REMOVE, undoData: removedDish }),
    menuOrder({ status: 'COOKING' }),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
})

test('撤「撤菜」：那一天已经出了点菜窗口 → 拒绝，并说清是窗口的问题', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_REMOVE, undoData: removedDish }),
    menuOrder({ inWindow: false }),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /窗口/)
})

test('撤「撤菜」：那一餐已经不存在（撤掉最后一道菜时整餐被删）→ 照样能加回去', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_REMOVE, undoData: removedDish }),
    menuOrder({ status: null, exists: false }),
  )
  // 那一餐没了正是"该重建"的时候：`orders.addItem` 会按需建出来
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'restoreMenuItem', item: removedDish.item })
})

// ---------- 撤「改人数」----------

const diners = { mealKey: '2026-10-13-DINNER', before: 2, after: 4 }

test('撤「改人数」：当前值还是 AI 写下的那个 → 写回原值', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MEAL_DINERS, undoData: diners }),
    menuOrder({ dinerCount: 4 }),
  )
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'setDiners', mealKey: '2026-10-13-DINNER', count: 2 })
})

test('撤「改人数」：用户自己又改过（现在是 6）→ 拒绝，不许把他的手改盖掉', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MEAL_DINERS, undoData: diners }),
    menuOrder({ dinerCount: 6 }),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /你自己改过/)
})

test('撤「改人数」：那一餐已经不在了 → 说清"那一餐已经不在了"', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MEAL_DINERS, undoData: diners }),
    menuOrder({ exists: false }),
  )
  assert.equal(verdict.type, 'already')
  assert.equal(plan, undefined)
})

test('撤「改人数」：原本没定（before=null），撤销就是清除', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MEAL_DINERS, undoData: { ...diners, before: null } }),
    menuOrder({ dinerCount: 4 }),
  )
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'setDiners', mealKey: '2026-10-13-DINNER', count: null })
})

// ---------- 状态流转：没有撤销，但要说人话 ----------

test('状态流转没有撤销，但拒绝的话是"往前走，回不去"而不是"不支持撤销"', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MEAL_STATUS, undoData: { mealKey: '2026-10-13-DINNER', from: 'PENDING', to: 'PLANNED' } }),
    menuOrder(),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /回不去/)
})

test('状态流转的回执卡**不给撤销按钮**（label 是空串，前端据此不画那颗按钮）', () => {
  assert.equal(undoLabel(AI_ACTION_MEAL_STATUS), '')
  // 其余新动作都有明确说法——空串是"不可撤"的专用信号，不能误用到别处
  assert.equal(undoLabel(AI_ACTION_MENU_ADD), '撤掉')
  assert.equal(undoLabel(AI_ACTION_MENU_REMOVE), '放回去')
  assert.equal(undoLabel(AI_ACTION_MEAL_DINERS), '改回去')
  assert.equal(undoLabel(AI_ACTION_COMBO_CREATE), '撤掉')
  assert.equal(undoLabel(AI_ACTION_COMBO_UPDATE), '改回去')
  assert.equal(undoLabel(AI_ACTION_COMBO_REMOVE), '放回去')
})

test('回执抬头的行当：菜单与餐次都算「菜单」，组合算「组合」', () => {
  assert.equal(actionKindLabel(AI_ACTION_MENU_ADD), '菜单')
  assert.equal(actionKindLabel(AI_ACTION_MEAL_DINERS), '菜单')
  assert.equal(actionKindLabel(AI_ACTION_MEAL_STATUS), '菜单')
  assert.equal(actionKindLabel(AI_ACTION_COMBO_UPDATE), '组合')
})

// ---------- 组合 ----------

const comboState: { name: string; note: string | null; recipeIds: string[] } = { name: '快手三菜', note: null, recipeIds: ['r1', 'r2'] }

function combo(over: Partial<typeof comboState> = {}): UndoContext {
  return { entity: 'combo', combo: { id: 'c1', ...comboState, ...over } }
}

test('撤「新建组合」：没被动过 → 删掉它', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_CREATE, undoData: { comboId: 'c1', after: comboState } }),
    combo(),
  )
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'deleteCombo', comboId: 'c1' })
})

test('撤「新建组合」：用户后来自己改了它 → 拒绝（删掉会把他的改动一起删）', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_CREATE, undoData: { comboId: 'c1', after: comboState } }),
    // 用户加了一道菜
    combo({ recipeIds: ['r1', 'r2', 'r3'] }),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /你自己改过/)
})

test('撤「新建组合」：改名也算改过（组合名是用户看得见的东西）', () => {
  const { verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_CREATE, undoData: { comboId: 'c1', after: comboState } }),
    combo({ name: '工作日晚饭' }),
  )
  assert.equal(verdict.type, 'refused')
})

test('撤「新建组合」：组合已经不在了 → 说清"已经不在了"，不报错', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_CREATE, undoData: { comboId: 'c1', after: comboState } }),
    { entity: 'combo', combo: null },
  )
  assert.equal(verdict.type, 'already')
  assert.equal(plan, undefined)
})

test('撤「改组合」：这次动了三项，就把三项都写回去', () => {
  const before = { name: '快手三菜', note: null, recipeIds: ['r1'] }
  const after = { name: '快手三菜（改）', note: null, recipeIds: ['r1', 'r2'] }
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_UPDATE, undoData: { comboId: 'c1', before, after } }),
    // 现状与 `after` 一致 = 用户没在中间动过 → 可以撤
    combo({ name: '快手三菜（改）', recipeIds: ['r1', 'r2'] }),
  )
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'updateCombo', comboId: 'c1', patch: before })
})

test('撤「改组合」：只记 AI 动过的项——用户后来改了说明，撤销改菜那一步仍然允许', () => {
  const before = { recipeIds: ['r1'] }
  // AI 只动了菜，所以 `before`/`after` 里**只有 recipeIds 这一项**（见 ComboUpdateUndo 的说明）
  const after = { recipeIds: ['r1', 'r2'] }
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_UPDATE, undoData: { comboId: 'c1', before, after } }),
    combo({ recipeIds: ['r1', 'r2'], note: '用户自己写的说明' }),
  )
  /*
   * 这条钉住"只比动过的那几项"：AI 只换了菜，说明是用户后来自己补的——
   * 那份说明**不该**把这次撤销挡掉（挡掉的话用户会觉得"我只是写了个说明，怎么就不能撤了"）。
   */
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'updateCombo', comboId: 'c1', patch: { recipeIds: ['r1'] } })
})

test('撤「删组合」：按原样重建（带 id 与组里的菜）', () => {
  const stored = { id: 'c1', name: '快手三菜', note: null, createdById: 'u1', familyId: 'f1', recipeIds: ['r1', 'r2'] }
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_REMOVE, undoData: { combo: stored }, targetId: 'c1' }),
    { entity: 'combo', combo: null },
  )
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'restoreCombo', combo: stored })
})

test('撤「删组合」：它还在（撤销只跑到一半）→ 说"还在，没被删"', () => {
  const stored = { id: 'c1', name: '快手三菜', note: null, createdById: 'u1', familyId: 'f1', recipeIds: ['r1', 'r2'] }
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_COMBO_REMOVE, undoData: { combo: stored }, targetId: 'c1' }),
    combo(),
  )
  assert.equal(verdict.type, 'already')
  assert.equal(plan, undefined)
  assert.match((verdict as { message: string }).message, /快手三菜/)
})

test('已经撤过的那笔：一律拒绝（再撤会去动别的记录）', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_ADD, undoneAt: new Date() }),
    menuItem(),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /已经撤过/)
})

test('undoData 形状读不懂 → 拒绝，且明确说"格式不认识"（绝不按错误理解去删东西）', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_REMOVE, undoData: { 乱: '写' } }),
    menuOrder(),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
  assert.match((verdict as { reason: string }).reason, /格式不认识/)
})

test('上下文类型不匹配（把菜单的现状喂给菜谱动作）→ 拒绝，不做任何推断', () => {
  const { plan, verdict } = planUndo(
    record({ kind: AI_ACTION_MENU_ADD, undoData: { itemId: 'i1' } }),
    combo(),
  )
  assert.equal(verdict.type, 'refused')
  assert.equal(plan, undefined)
})

// ---------- menuUndoTarget：撤"菜单"这类动作要查哪一餐 ----------

test('menuUndoTarget 认「撤菜」那份数据（哪一天哪一餐哪道菜）', () => {
  assert.deepEqual(menuUndoTarget(removedDish), {
    mealDate: '2026-10-13',
    meal: 'DINNER',
    dish: { recipeId: 'r9', recipeName: '番茄炒蛋' },
  })
})

test('menuUndoTarget 认「改人数」那份数据（只有 mealKey，没有具体的菜）', () => {
  const target = menuUndoTarget({ mealKey: '2026-10-13-LUNCH', before: 2, after: 4 })
  assert.ok(target)
  assert.equal(target.mealDate, '2026-10-13')
  assert.equal(target.meal, 'LUNCH')
})

test('menuUndoTarget 读不懂就给 null（调用方按"查不到现状"处理，不猜）', () => {
  assert.equal(menuUndoTarget(null), null)
  assert.equal(menuUndoTarget({ itemId: 'i1' }), null)          // 撤"加菜"那笔要靠 targetId，不在这里
  assert.equal(menuUndoTarget({ mealKey: '晚上' }), null)       // mealKey 形状不对
  assert.equal(menuUndoTarget({ item: { recipeName: '' } }), null)
  assert.equal(menuUndoTarget({ item: { recipeName: '番茄炒蛋', mealDate: '10/13', meal: 'DINNER' } }), null)
})

// ---------- 工具参数解析 ----------

test('readMenuAdds：日期收敛到点菜窗口，餐次缺省按晚餐', () => {
  const parsed = readMenuAdds(JSON.stringify({ items: [{ recipeId: 'r1' }] }), '2026-10-13')
  assert.equal(parsed.mealDate, '2026-10-13')
  assert.equal(parsed.meal, 'DINNER')
  assert.deepEqual(parsed.items, [{ recipeId: 'r1' }])
})

test('readMenuAdds：既没 recipeId 也没 dishName 的条目丢掉并告诉模型（不静默）', () => {
  const parsed = readMenuAdds(
    JSON.stringify({ mealDate: '2026-10-13', meal: 'LUNCH', items: [{ note: '随便' }, { dishName: '糖醋排骨' }] }),
    '2026-10-13',
  )
  assert.equal(parsed.items.length, 1)
  assert.deepEqual(parsed.items[0], { dishName: '糖醋排骨' })
  assert.match(parsed.rejected.join(''), /recipeId|dishName/)
})

test('readMenuAdds：超过上限的部分被截断并提示分批（不让模型一口气倒出二十道）', () => {
  const items = Array.from({ length: MENU_ADD_MAX + 3 }, (_, index) => ({ dishName: `菜${index}` }))
  const parsed = readMenuAdds(JSON.stringify({ items }), '2026-10-13')
  assert.equal(parsed.items.length, MENU_ADD_MAX)
  assert.match(parsed.rejected.join(''), /上限/)
})

test('readMenuAdds：参数不是 JSON → 空结果 + 一句能转述的原因', () => {
  const parsed = readMenuAdds('{不是 json', '2026-10-13')
  assert.deepEqual(parsed.items, [])
  assert.equal(parsed.rejected.length, 1)
})

test('readMealTarget：组合加菜用（comboId 借 mealKey 字段传），日期收敛窗口', () => {
  const parsed = readMealTarget(JSON.stringify({ mealKey: 'c1', mealDate: '2026-10-15', meal: 'DINNER' }), '2026-10-13')
  assert.deepEqual(parsed, { mealKey: 'c1', mealDate: '2026-10-15', meal: 'DINNER' })
  // 餐次非法 → 整块 null（不猜一个"最像的"餐次）
  assert.equal(readMealTarget(JSON.stringify({ mealKey: 'c1', meal: 'BRUNCH' }), '2026-10-13'), null)
})

test('readDiners：0 / null / 空串都当"清除人数"，与 parseDinerCount 同口径', () => {
  assert.deepEqual(readDiners(JSON.stringify({ mealKey: 'k', count: 4 })), { mealKey: 'k', count: 4 })
  assert.deepEqual(readDiners(JSON.stringify({ mealKey: 'k', count: 0 })), { mealKey: 'k', count: null })
  assert.deepEqual(readDiners(JSON.stringify({ mealKey: 'k' })), { mealKey: 'k', count: null })
  assert.equal(readDiners(JSON.stringify({ count: 4 })), null)
})

test('readMealStatus：只认枚举里的五个状态，别的一概不猜', () => {
  assert.deepEqual(readMealStatus(JSON.stringify({ mealKey: 'k', status: 'done' })), { mealKey: 'k', status: 'DONE' })
  assert.equal(readMealStatus(JSON.stringify({ mealKey: 'k', status: '搞定' })), null)
  assert.equal(readMealStatus(JSON.stringify({ status: 'DONE' })), null)
})

test('readComboDraft：字段原样交给组合服务（业务校验只有一处），非对象给 null', () => {
  assert.deepEqual(
    readComboDraft(JSON.stringify({ name: ' A ', recipeIds: ['r1'] })),
    { name: ' A ', note: undefined, recipeIds: ['r1'] },
  )
  assert.equal(readComboDraft('[]'), null)
  assert.equal(readComboDraft('{'), null)
})

// ---------- 给模型看的紧凑文本 ----------

test('menuText 每道菜都带 itemId 与"是不是我点的"（撤菜靠这两样）', () => {
  const text = menuText([{
    mealKey: '2026-10-13-DINNER',
    date: '2026-10-13',
    meal: 'DINNER',
    statusLabel: '待确认',
    dinerCount: 4,
    dishes: [
      { itemId: 'i1', name: '番茄炒蛋', who: '小满', mine: true, note: '少放辣' },
      { itemId: 'i2', name: '米饭', who: '爸爸', mine: false, note: null },
    ],
  }])
  assert.match(text, /itemId: i1/)
  assert.match(text, /我点的/)
  assert.match(text, /爸爸点的/)
  assert.match(text, /4 人/)
  assert.match(text, /备注：少放辣/)
})

test('menuText 空菜单与空范围都给一句人话（模型据此如实回答，而不是编一个安排）', () => {
  assert.match(menuText([]), /还没有安排/)
  assert.match(menuText([{
    mealKey: '2026-10-13-DINNER', date: '2026-10-13', meal: 'DINNER',
    statusLabel: '待确认', dinerCount: null, dishes: [],
  }]), /还没点菜/)
})

test('comboText 每组带 comboId 与每道菜的 id（改组合、加进菜单都要这两样）', () => {
  const text = comboText([{ id: 'c1', name: '快手三菜', note: '工作日的晚上', dishes: [{ recipeId: 'r1', name: '番茄炒蛋' }] }])
  assert.match(text, /comboId: c1/)
  assert.match(text, /番茄炒蛋\[r1\]/)
  assert.match(text, /工作日的晚上/)
  assert.match(comboText([]), /还没有/)
})
