import assert from 'node:assert/strict'
import test from 'node:test'
import { fromPiToolCall, readPiFailure, toPiMessages, toPiTools, type WireLike } from '../src/modules/ai/ai.pi.rules'

// 迁移到 pi-ai 之后的**转换规则**（D-044）。不碰网络、不碰数据库。
//
// 这里盯的是"形状对不上"这一类 bug——它们的表现是"第一轮正常、第二轮就断"
// （历史上的那次事故就是这样：内部工具对象直接当协议对象发出去，被上游 400 拒）。
// 所以每条转换都验**双向**：我们的形状 → pi-ai、pi-ai → 我们的形状。

const IDENTITY = { provider: 'cook-gateway', model: 'some-model' }

test('工具声明：OpenAI 形状（function 包一层）→ pi-ai 形状（平铺）', () => {
  const tools = toPiTools([
    {
      type: 'function',
      function: {
        name: 'search_dishes',
        description: '搜菜谱库',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
  ])

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'search_dishes', '名字要提出来')
  assert.equal(tools[0].description, '搜菜谱库')
  // 参数字段名也要换：OpenAI 用 function.parameters，pi-ai 用顶层的 parameters
  assert.deepEqual(tools[0].parameters, {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
  })
})

test('工具声明：形状不对时报一句能看懂的错（不是 TypeError）', () => {
  // 必须**抛错**而不是产出一个 name=undefined 的工具（那种会让模型永远不调工具，
  // 而且现场看不出原因）。也不能让它冒成 `Cannot read properties of undefined`——
  // 那是"我少包了一层"这种最常见错误唯一的现场线索，得说清楚。
  assert.throws(
    () => toPiTools([{ name: 'x', description: 'y', parameters: {} } as never]),
    /不是 OpenAI 形状/,
  )
})

test('助手消息：工具的 arguments 是字符串 → 对象，其余字段齐备', () => {
  const wire: WireLike[] = [
    { role: 'user', content: '今晚吃啥' },
    {
      role: 'assistant',
      content: '我查查',
      tool_calls: [{ id: 'call_1', name: 'search_dishes', arguments: '{"query":"番茄"}' }],
    },
  ]

  const messages = toPiMessages(wire, IDENTITY)
  assert.equal(messages.length, 2)
  const assistant = messages[1] as {
    role: string; content: { type: string; text?: string; arguments?: unknown }[]
    usage?: unknown; stopReason?: string; provider?: string; model?: string
  }
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content[0].type, 'text')
  assert.equal(assistant.content[0].text, '我查查')
  assert.equal(assistant.content[1].type, 'toolCall')
  // 关键转换：字符串 → 对象（pi-ai 的协议形状）
  assert.deepEqual(assistant.content[1].arguments, { query: '番茄' })
  // 这些字段缺一个 pi-ai 就会炸（它按 AssistantMessage 处理历史）
  assert.ok(assistant.usage, 'usage 必须给（它参与上下文估算）')
  assert.equal(assistant.stopReason, 'toolUse')
  assert.equal(assistant.provider, IDENTITY.provider)
  assert.equal(assistant.model, IDENTITY.model)
})

test('助手消息：模型给了非法 JSON 参数时用空对象，不整轮崩掉', () => {
  const messages = toPiMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', name: 'search_dishes', arguments: '{"query":' }] },
  ], IDENTITY)
  const assistant = messages[1] as { content: { type: string; arguments?: unknown }[] }
  assert.deepEqual(assistant.content[0].arguments, {}, '半截 JSON 变成空对象，让模型下一轮自己纠正')
})

test('工具结果：从前面那条助手消息里按 id 找回 toolName（协议要求带它）', () => {
  const wire: WireLike[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', name: 'read_plan', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'call_9', content: '{"plan":"这周还没安排"}' },
  ]

  const messages = toPiMessages(wire, IDENTITY)
  const result = messages[2] as { role: string; toolCallId?: string; toolName?: string; content: { text: string }[] }
  assert.equal(result.role, 'toolResult', 'role=tool 要变成 pi-ai 的 toolResult')
  assert.equal(result.toolCallId, 'call_9')
  assert.equal(result.toolName, 'read_plan', '名字从助手消息里找回来——我们的 tool 消息本身没有这个字段')
  assert.equal(result.content[0].text, '{"plan":"这周还没安排"}')
})

test('工具结果：找不到对应的助手消息时给一个占位名（不能是 undefined）', () => {
  const messages = toPiMessages([
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'call_unknown', content: 'x' },
  ], IDENTITY)
  const result = messages[1] as { toolName?: string }
  assert.equal(typeof result.toolName, 'string', '必须是字符串：pi-ai/上游会读这个字段')
  assert.ok(result.toolName && result.toolName.length > 0)
})

test('system 消息由 systemPrompt 承载：历史里的 system 不进消息列表（避免重复）', () => {
  const messages = toPiMessages([
    { role: 'system', content: '你是厨房助手' },
    { role: 'user', content: 'hi' },
  ], IDENTITY)
  assert.equal(messages.length, 1, 'system 不该出现在这里')
  assert.equal((messages[0] as { role: string }).role, 'user')
})

test('工具调用（pi-ai → 我们）：arguments 对象变回原始 JSON 字符串', () => {
  const call = fromPiToolCall({
    type: 'toolCall',
    id: 'call_x',
    name: 'propose_menu_items',
    arguments: { items: [{ recipeId: 'r1', mealDate: '2026-10-13', meal: 'DINNER' }] },
  })
  assert.equal(call.id, 'call_x')
  assert.equal(call.name, 'propose_menu_items')
  assert.equal(typeof call.arguments, 'string', '下游（ai.tools 的 readProposals）按字符串解析')
  assert.deepEqual(JSON.parse(call.arguments), { items: [{ recipeId: 'r1', mealDate: '2026-10-13', meal: 'DINNER' }] })
})

test('失败分类：超时/中止 → timeout（走 504 话术）', () => {
  assert.deepEqual(readPiFailure({ stopReason: 'aborted', errorMessage: 'Request aborted' }, false), { kind: 'timeout' })
  // 我们自己 abort 的（isAborted=true）也算超时，即使上游没来得及标 aborted
  assert.deepEqual(readPiFailure({ stopReason: 'error', errorMessage: 'x' }, true), { kind: 'timeout' })
})

test('失败分类：HTTP 错误 → 状态码 + 详情（走原有 upstreamMessage 话术）', () => {
  const failure = readPiFailure({ stopReason: 'error', errorMessage: '401: {"message":"bad key"}' }, false)
  assert.deepEqual(failure, { kind: 'http', status: 401, detail: '{"message":"bad key"}' })

  const rate = readPiFailure({ stopReason: 'error', errorMessage: '429: rate limited' }, false)
  assert.equal(rate?.kind === 'http' && rate.status, 429)
})

test('失败分类：连不上 → connection（不说"密钥错了"，别误导用户换配置）', () => {
  assert.deepEqual(readPiFailure({ stopReason: 'error', errorMessage: 'Connection error.' }, false), {
    kind: 'connection', detail: 'Connection error.',
  })
})

test('失败分类：正常结束（stop/toolUse）不算失败', () => {
  assert.equal(readPiFailure({ stopReason: 'stop' }, false), null)
  assert.equal(readPiFailure({ stopReason: 'toolUse' }, false), null)
})
