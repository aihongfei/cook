/**
 * 迁移到 pi-ai 之后要用的**纯转换规则**（无网络、无 Nest，可直接单测）。
 *
 * 为什么单独一个文件：迁移里最容易出错的不是"调不通"，而是**形状对不上**——
 * 我们的内部消息形状（`WireMessage`：工具的 arguments 是**原始 JSON 字符串**）
 * 与 pi-ai 的形状（工具调用的 arguments 是**对象**、工具结果要带 `toolName`、
 * 助手消息要带 `usage`/`stopReason`）之间要来回转。这类 bug 的表现是"第二轮就断"，
 * 而 stub 上游恰好能拦住它（见 RUNBOOK R-018 的那次事故）。
 *
 * 所以转换与"失败怎么翻"都放在这里，配单测；`ai.client.ts` 只负责把它们接到网络上。
 */
import type { Message, Tool, ToolCall as PiToolCall } from '@earendil-works/pi-ai'

/** 上游线格式里的一条用户消息内容块（文本 / 图片） */
export type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** 内部消息（与 ai.client 的 WireMessage 结构一致；结构性类型，避免循环依赖） */
export interface WireLike {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * 纯文本，或**带图的内容块数组**（F16-05：对话里的图片）。
   *
   * 两种形状并存是有原因的：助手/工具消息永远是纯文本（模型不返图），
   * 只有用户消息可能带图。统一成数组会让"纯文本那条路"多一层包装，
   * 而那条路是**每轮工具循环都要重放**的（多一层就多一处出错的地方）。
   */
  content: string | WireContentBlock[] | null
  tool_calls?: { id: string; name: string; arguments: string }[]
  tool_call_id?: string
}

/** OpenAI 形状的工具声明（我们 ai.tools 里 AI_TOOLS 的格式） */
export interface OpenAiFunctionTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

/** 助手消息要用到的模型标识（构造 pi-ai 的 AssistantMessage 时必填） */
export interface PiModelIdentity {
  provider: string
  model: string
}

/** pi-ai 要求的 usage 形状：我们回喂的是"上一轮的助手消息"，用量填零（它只用于上下文估算） */
const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const

/**
 * 工具声明：OpenAI 形状 → pi-ai 形状。
 *
 * 只取 `function` 里那三个字段（pi-ai 的工具是平的 `{name, description, parameters}`）。
 * `parameters` 直接透传：我们本来写的就是标准 JSON Schema，pi-ai 会在发送时按后端能力
 * 决定要不要加 `strict`（我们的 compat 没开 strict——保持与迁移前**逐字节相同**的报文）。
 */
export function toPiTools(tools: readonly OpenAiFunctionTool[]): Tool[] {
  return tools.map((tool, index) => {
    // 显式校验而不是让它在解构时抛 TypeError：这个函数接的是**我们的**工具表
    // （OpenAI 形状），而 pi-ai 自己的形状是平铺的。把 pi-ai 文档里的例子复制进来
    // 是个很容易犯的错，报一句能看懂的错比 `Cannot read properties of undefined` 有用得多。
    if (!tool?.function?.name) {
      throw new Error(
        `工具声明第 ${index + 1} 条不是 OpenAI 形状（要有 function.name/description/parameters）——`
        + '注意 pi-ai 自己的工具表是平铺的，不能直接混用',
      )
    }
    return {
      name: tool.function.name,
      description: tool.function.description,
      // 类型上 pi-ai 用 TypeBox 的 TSchema；我们给的是等价的标准 JSON Schema。
      // 这里必须断言：两边形状一致、但没有公共类型（pi-ai 的校验发生在运行时）。
      parameters: tool.function.parameters as Tool['parameters'],
    }
  })
}

/**
 * 内部消息 → pi-ai 消息。
 *
 * 三个必须做对的地方：
 * - **工具的 arguments 是字符串，pi-ai 要对象**：反序列化；模型万一给了非法 JSON
 *   （罕见但会发生）就用空对象，让它下一轮自己纠正——不能因为这些脏参数崩掉整轮。
 * - **工具结果要带 `toolName`，而我们的 `role: 'tool'` 消息里没有**：从**前面那条助手消息**
 *   的 tool_calls 里按 id 找回来（协议要求 id 对应，所以这条映射是可靠的）。
 * - **助手消息必须带 `usage`/`stopReason`/`api`/`provider`/`model`**（pi-ai 的
 *   AssistantMessage 是完整对象）：填零用量与 `toolUse`——网关只关心内容与
 *   `reasoning_content` 字段是否存在（后者由 compat 的
 *   `requiresReasoningContentOnAssistantMessages` 自动补空串，这正是 R-23 要的）。
 */
export function toPiMessages(messages: readonly WireLike[], identity: PiModelIdentity): Message[] {
  const toolNames = new Map<string, string>()
  const out: Message[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      // system 由 systemPrompt 单独承载（pi-ai 会折成首条 system 消息）；这里忽略
      continue
    }

    if (message.role === 'user') {
      /*
       * 用户消息：纯文本直接给，**带图的要翻成 pi-ai 的内容块**
       * （`{type:'image', data, mimeType}` → 它按 `data:<mime>;base64,<data>` 发出去）。
       *
       * 空的文本块要丢掉：pi-ai 那边会把"只剩一个空 text"的内容整条跳过，
       * 而"只发一张图不说话"正是最常见的用法（用户拍张照直接发）。
       */
      if (typeof message.content === 'string' || message.content === null) {
        out.push({ role: 'user', content: message.content ?? '', timestamp: Date.now() })
      } else {
        const blocks = message.content
          .filter((block) => block.type !== 'text' || block.text.length > 0)
          .map((block) => (block.type === 'text'
            ? { type: 'text' as const, text: block.text }
            : { type: 'image' as const, data: block.data, mimeType: block.mimeType }))
        // 全是空块时给一个空串（而不是空数组）：后者在 pi-ai 里会被整条跳过，
        // 于是"这条用户消息"凭空消失，模型看到的对话少了半句
        out.push({ role: 'user', content: blocks.length > 0 ? blocks : '', timestamp: Date.now() })
      }
      continue
    }

    if (message.role === 'assistant') {
      const content: (Message & { role: 'assistant' })['content'] = []
      /*
       * 助手消息**只能是文本**（模型不返图）。用 `asText` 收窄而不是直接当字符串用：
       * `WireLike.content` 是联合类型，这里若不收窄，将来某处误把带图的内容块塞进助手消息，
       * 会被序列化成 `[object Object]` 发出去——那种错误上游只回一句"格式不对"。
       */
      const said = asText(message.content)
      if (said) content.push({ type: 'text', text: said })
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.name)
        content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: parseArguments(call.arguments) })
      }
      out.push({
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider: identity.provider,
        model: identity.model,
        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        stopReason: 'toolUse',
        timestamp: Date.now(),
      })
      continue
    }

    // role === 'tool'
    out.push({
      role: 'toolResult',
      toolCallId: message.tool_call_id ?? '',
      toolName: toolNames.get(message.tool_call_id ?? '') ?? 'unknown_tool',
      content: [{ type: 'text', text: asText(message.content) }],
      isError: false,
      timestamp: Date.now(),
    })
  }

  return out
}

/**
 * 把内容收窄成纯文本：助手/工具消息只可能是文本。
 *
 * 内容块数组里的文本块**拼起来**（而不是丢掉）：真出现那种形状时，
 * 至少把话说出来，比发出一句空话强。
 */
function asText(content: WireLike['content']): string {
  if (typeof content === 'string') return content
  if (content === null) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** 工具参数的字符串 → 对象（pi-ai 的形状）；解析不了就给空对象，让模型下一轮纠正 */
function parseArguments(raw: string): PiToolCall['arguments'] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PiToolCall['arguments']
    }
  } catch {
    // 落到下面的空对象
  }
  return {}
}

/** pi-ai 的工具调用 → 我们的形状（arguments 变回**原始 JSON 字符串**，下游 ai.tools 按字符串解析） */
export function fromPiToolCall(call: PiToolCall): { id: string; name: string; arguments: string } {
  return { id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
}

/**
 * 上游失败信息（从 pi-ai 的最终消息里读）。
 *
 * pi-ai 不抛 HTTP 错误，而是把它放进消息的 `stopReason`/`errorMessage`
 * （实测：`401: {"message":"..."}` / `Connection error.` / `Request aborted`）。
 * 这里把它翻成**可判定的三类**，话术与状态码由调用方（ai.client）用原有的 `upstreamMessage` 出，
 * 保证用户看到的话与迁移前一模一样。
 */
export type PiFailure =
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'connection'; detail: string }

export function readPiFailure(
  result: { stopReason?: string; errorMessage?: string },
  aborted: boolean,
): PiFailure | null {
  const stopped = result.stopReason === 'error' || result.stopReason === 'aborted'
  if (!stopped && !aborted) return null

  const detail = result.errorMessage ?? ''
  // 我们自己的超时/调用方取消都会走到 aborted（pi-ai 回 errorMessage='Request aborted'）
  if (aborted || result.stopReason === 'aborted' || /abort/i.test(detail)) return { kind: 'timeout' }

  // 上游 HTTP 错误：`<状态码>: <详情>`
  const matched = /^(\d{3})\s*:\s*([\s\S]*)$/.exec(detail.trim())
  if (matched) {
    return { kind: 'http', status: Number(matched[1]), detail: matched[2].trim().slice(0, 200) }
  }
  return { kind: 'connection', detail: detail.slice(0, 200) }
}

/**
 * 流式那条路上"要不要摘掉 `response_format` 再试一次"（F16-02，2026-10-15 补）。
 *
 * 这个判据与 `chatJson` 的那条**必须分开**，差在一个条件：**`emitted`（已经吐过字没有）**。
 *
 * 非流式那条路整段结果都在手里，被拒了就重试，用户什么都还没看见；流式不一样——
 * `yield` 出去的每一段都已经由 SSE 写到了用户屏幕上。**吐过字之后再重试，用户会看到
 * 自己刚读的那段话被抹掉重写一遍**，那比报一次错更糟（错至少是诚实的）。
 *
 * 所以流式的重试窗口只有"**第一个事件之前**"：三个条件缺一不可——
 * 这一趟带了 schema、认得出是 `response_format` 引起的 400、且 `emitted` 为假。
 * 判据单独放在这里（而不是写在 client 的分支里）是为了能直接单测：
 * 它决定了"会不会重试"，写宽了会白花额度，写窄了会让 F16-06/07/08 那三条路直接 502。
 */
export function isResponseFormatRejection(detail: string): boolean {
  return /response_format/i.test(detail) || /unavailable now/i.test(detail)
}

export function shouldRetryStructuredStream(input: {
  /** 这一趟带了 `response_format` 吗（去掉之后的那一趟不再重试，天然防循环） */
  withSchema: boolean
  /** 这一趟已经 yield 过事件了吗 */
  emitted: boolean
  status: number
  message: string
}): boolean {
  if (!input.withSchema) return false
  if (input.emitted) return false
  if (input.status !== 400) return false
  return isResponseFormatRejection(input.message)
}
