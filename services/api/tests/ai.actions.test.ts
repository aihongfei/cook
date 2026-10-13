import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_ACTION_FRIDGE_CREATE,
  AI_ACTION_FRIDGE_REMOVE,
  AI_ACTION_FRIDGE_UPDATE,
  describeFridgeItem,
  planUndo,
  removedItemKey,
  undoLabel,
  type AiActionRecord,
  type FridgeSnapshot,
} from '../src/modules/ai/ai-action.rules'
import {
  FRIDGE_ADD_MAX,
  fridgeText,
  readAddItems,
  readRemoveItem,
  readUpdateItem,
} from '../src/modules/ai/ai.tools'

/**
 * AI 助手"对话里办事"的纯逻辑（F16-10 / D-052 / D-053）。
 *
 * 这块的难点**不在"怎么撤"，而在"什么时候不能撤"**——A 档允许 AI 直接写库，
 * 那撤销就得判得了三种意外：用户自己改过、那条已经不在了、已经撤过一次。
 * 三种判错的后果都是**悄悄弄坏用户的数据**（或静默覆盖他刚做的改动），
 * 所以这里逐条钉住，且每条都断言"给的是一句人话"（界面直接显示它）。
 */

function action(over: Partial<AiActionRecord> = {}): AiActionRecord {
  return {
    id: 'a1',
    kind: AI_ACTION_FRIDGE_CREATE,
    undoData: { itemId: 'i1' },
    undoneAt: null,
    targetId: 'i1',
    ...over,
  }
}

function snapshot(over: Partial<FridgeSnapshot> = {}): FridgeSnapshot {
  return { id: 'i1', name: '鸡蛋', amount: '一盒', zone: '冷藏', expiresOn: null, note: null, ...over }
}

test('撤销"新建"：那条还在 → 删掉它', () => {
  const { plan, verdict } = planUndo(action(), snapshot())
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'delete', itemId: 'i1' })
})

test('撤销"新建"但那**已经不在了**：不算失败，如实说"这条已经不在了"', () => {
  const { plan, verdict } = planUndo(action(), null)
  assert.equal(plan, undefined)
  assert.equal(verdict.type, 'already')
  assert.match(verdict.type === 'already' ? verdict.message : '', /不在了/)
})

test('撤销"改"：值没被人动过 → 改回原值；只回退**动过的那些字段**', () => {
  const record = action({
    kind: AI_ACTION_FRIDGE_UPDATE,
    undoData: { itemId: 'i1', before: { amount: '半盒' }, after: { amount: '一盒' } },
  })
  const { plan, verdict } = planUndo(record, snapshot({ amount: '一盒' }))
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'update', itemId: 'i1', item: { amount: '半盒' } })
})

test('撤销"改"但**用户自己又改过**：拒绝，并说清"会把你的改动也盖掉"', () => {
  const record = action({
    kind: AI_ACTION_FRIDGE_UPDATE,
    undoData: { itemId: 'i1', before: { amount: '半盒' }, after: { amount: '一盒' } },
  })
  // AI 写的是一盒，用户改成了两盒 → 撤回"半盒"会把他的"两盒"吃掉
  const { plan, verdict } = planUndo(record, snapshot({ amount: '两盒' }))
  assert.equal(plan, undefined)
  assert.equal(verdict.type, 'refused')
  assert.match(verdict.type === 'refused' ? verdict.reason : '', /你自己改过/)
})

test('还是撤销"改"：**没被 AI 动过的字段**用户怎么改都不影响撤销', () => {
  /*
   * 这条守的是"只记动过的字段"这个设计（见 ai-action.service 的说明）。
   * AI 只改了保质期，用户后来把数量从"一盒"改成"两盒"——撤销照样该允许：
   * 把他的"两盒"一并回退才叫弄坏数据。
   */
  const record = action({
    kind: AI_ACTION_FRIDGE_UPDATE,
    undoData: {
      itemId: 'i1',
      before: { expiresOn: '2026-10-20' },
      after: { expiresOn: '2026-10-25' },
    },
  })
  const { plan, verdict } = planUndo(record, snapshot({ amount: '两盒', expiresOn: '2026-10-25' }))
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, { op: 'update', itemId: 'i1', item: { expiresOn: '2026-10-20' } })
})

test('撤销"删除"：照原样重建（它不在**正是该撤的时候**）', () => {
  const record = action({
    kind: AI_ACTION_FRIDGE_REMOVE,
    undoData: { item: { name: '鸡蛋', amount: '一盒', zone: '冷藏', expiresOn: '2026-10-20', note: '给奶奶' } },
  })
  const { plan, verdict } = planUndo(record, null)
  assert.equal(verdict.type, 'ok')
  assert.deepEqual(plan, {
    op: 'restore',
    itemId: 'i1',
    item: { name: '鸡蛋', amount: '一盒', zone: '冷藏', expiresOn: '2026-10-20', note: '给奶奶' },
  })
})

test('撤销"删除"但那条**又回来了**：不动它（硬重建会撞上"同名同区只一条"）', () => {
  const record = action({
    kind: AI_ACTION_FRIDGE_REMOVE,
    undoData: { item: { name: '鸡蛋', amount: '一盒', zone: '冷藏', expiresOn: null, note: null } },
  })
  const { plan, verdict } = planUndo(record, snapshot())
  assert.equal(plan, undefined)
  assert.equal(verdict.type, 'already')
  assert.match(verdict.type === 'already' ? verdict.message : '', /还在/)
})

/**
 * 撤「删除」时"它回来了没有"该按什么查——**同名同区，不是那条被删掉的 id**。
 *
 * 这条是 HTTP 验收逮出来的：上面那条纯函数测试（直接喂 snapshot）一直是绿的，
 * 因为规则本身没写错，错的是**服务端喂给它的现状**——按 `targetId` 去查一条已经
 * 被删掉的行，永远查不到，于是"用户又记回来了"那个分支在实际运行中根本走不到，
 * 撤销照着重建走、撞上唯一约束，用户看到的是「已经记了一条，直接改它就行」。
 * 所以这里钉的是**查询的键从哪来**：它必须来自 undoData 里的名字与格子。
 */
test('撤「删除」要按同名同区去查现状：键从 undoData 里取，取不到就返回 null', () => {
  assert.deepEqual(
    removedItemKey({ item: { name: '牛奶', amount: '两盒', zone: '冷藏', expiresOn: null, note: null } }),
    { name: '牛奶', zone: '冷藏' },
  )
  // 形状读不懂（缺 item、item 不是对象、名字或格子不是字符串）→ null，
  // 调用方按"查不到"处理，planUndo 还会再拦一次，绝不猜一个键去查
  for (const broken of [null, {}, { item: null }, { item: '牛奶' }, { item: { name: '牛奶' } }, { item: { name: 42, zone: '冷藏' } }]) {
    assert.equal(removedItemKey(broken), null, `${JSON.stringify(broken)} 应该读不懂`)
  }
})

test('已经撤过一次：拒绝（再撤一次会去动一条不该动的记录）', () => {
  const { plan, verdict } = planUndo(action({ undoneAt: new Date('2026-10-13T10:00:00Z') }), snapshot())
  assert.equal(plan, undefined)
  assert.equal(verdict.type, 'refused')
  assert.match(verdict.type === 'refused' ? verdict.reason : '', /已经撤过/)
})

test('**读不懂的记录一律拒绝**，不按猜测去删用户的数据', () => {
  const cases: unknown[] = [
    null,
    'not-an-object',
    [],
    { wrongField: 1 },
    { itemId: null },
  ]
  for (const undoData of cases) {
    const { plan, verdict } = planUndo(action({ undoData }), snapshot())
    assert.equal(plan, undefined, `形状 ${JSON.stringify(undoData)} 不该给出计划`)
    assert.equal(verdict.type, 'refused')
    assert.match(verdict.type === 'refused' ? verdict.reason : '', /格式不认识/)
  }
})

test('不认识的 kind 同样拒绝（将来加了新档、旧版本代码读到它时不能乱动）', () => {
  const { plan, verdict } = planUndo(action({ kind: 'fridge.something-new' }), snapshot())
  assert.equal(plan, undefined)
  assert.equal(verdict.type, 'refused')
})

test('撤销按钮上的字要说清撤的是什么（不是抽象的"撤销"）', () => {
  assert.equal(undoLabel(AI_ACTION_FRIDGE_CREATE), '撤掉')
  assert.equal(undoLabel(AI_ACTION_FRIDGE_UPDATE), '改回去')
  assert.equal(undoLabel(AI_ACTION_FRIDGE_REMOVE), '放回去')
  assert.equal(undoLabel('whatever'), '撤销')
})

test('回执卡那句话：有数量与区就都带上，没有就不留空档', () => {
  assert.equal(describeFridgeItem({ name: '鸡蛋', amount: '一盒', zone: '冷藏' }), '鸡蛋 · 一盒 · 冷藏')
  assert.equal(describeFridgeItem({ name: '盐', amount: null, zone: '常温' }), '盐 · 常温')
  assert.equal(describeFridgeItem({ name: '剩饭' }), '剩饭')
})

test('add_fridge_items：一次收多样（"买了鸡蛋牛奶"不该拆成两次调用）', () => {
  const { drafts, rejected } = readAddItems(JSON.stringify({
    items: [
      { name: '鸡蛋', amount: '一盒', zone: '冷藏' },
      { name: '牛奶', amount: '两盒', zone: '冷藏', expiresOn: '2026-10-20' },
    ],
  }))
  assert.equal(rejected.length, 0)
  assert.deepEqual(drafts, [
    { name: '鸡蛋', amount: '一盒', zone: '冷藏' },
    { name: '牛奶', amount: '两盒', zone: '冷藏', expiresOn: '2026-10-20' },
  ])
})

test('add_fridge_items：超上限的截掉并**告诉模型分批**（静默丢它会继续说"都记好了"）', () => {
  const items = Array.from({ length: FRIDGE_ADD_MAX + 3 }, (_, index) => ({ name: `食材${index}` }))
  const { drafts, rejected } = readAddItems(JSON.stringify({ items }))
  assert.equal(drafts.length, FRIDGE_ADD_MAX)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0], /分下一批/)
})

test('add_fridge_items：**保质期不猜**——格式不对就当没写，但名字必须真的在', () => {
  const { drafts, rejected } = readAddItems(JSON.stringify({
    items: [
      { name: '鸡蛋', expiresOn: '2026-13-45' },
      { name: '  ' },
      { name: '牛奶', expiresOn: '2026-10-20' },
    ],
  }))
  assert.deepEqual(drafts[0], { name: '鸡蛋' })
  assert.deepEqual(drafts[1], { name: '牛奶', expiresOn: '2026-10-20' })
  assert.equal(rejected.length, 1)
})

test('add_fridge_items：参数不是 JSON 或没有 items → 说清怎么重试，不抛异常', () => {
  for (const raw of ['not json', '{}', '{"items": "nope"}']) {
    const { drafts, rejected } = readAddItems(raw)
    assert.equal(drafts.length, 0)
    assert.equal(rejected.length, 1)
  }
})

test('update_fridge_item：**只带模型真的传了的字段**（没传的保持原样）', () => {
  const parsed = readUpdateItem(JSON.stringify({ itemId: 'i1', amount: '半盒' }))
  assert.deepEqual(parsed, { itemId: 'i1', patch: { amount: '半盒' } })
})

test('update_fridge_item：name 传空串等于没传（不是"把名字改成空"）', () => {
  const parsed = readUpdateItem(JSON.stringify({ itemId: 'i1', name: '   ', note: '开口了' }))
  assert.deepEqual(parsed, { itemId: 'i1', patch: { note: '开口了' } })
})

test('update/remove：缺 id 或参数坏了 → null（调用方回一句"先读一遍冰箱"）', () => {
  assert.equal(readUpdateItem('nope'), null)
  assert.equal(readUpdateItem('{}'), null)
  assert.equal(readUpdateItem('{"itemId":""}'), null)
  assert.equal(readRemoveItem('nope'), null)
  assert.equal(readRemoveItem('{}'), null)
  assert.equal(readRemoveItem('{"itemId":"i9"}'), 'i9')
})

test('给模型看的冰箱现状：空就说空，有就带 id（它要拿 id 去改/删）', () => {
  assert.equal(fridgeText([]), '（冰箱是空的）')
  const text = fridgeText([
    { id: 'i1', name: '鸡蛋', amount: '一盒', zone: '冷藏', expiryLabel: '今天到期' },
    { id: 'i2', name: '盐', amount: null, zone: '常温', expiryLabel: null },
  ])
  assert.match(text, /鸡蛋 · 一盒 · 冷藏 · 今天到期（id: i1）/)
  // 没写的字段不留空档（"盐 · null · 常温"会读起来像坏数据）
  assert.match(text, /盐 · 常温（id: i2）/)
  assert.doesNotMatch(text, /null/)
})
