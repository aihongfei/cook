import { Logger } from '@nestjs/common'
import type { Message, ModelsApiStreamOptions, ProviderHeaders } from '@earendil-works/pi-ai'
import type { AiConfig, ChatMessage } from './ai.rules'
import type { ToolCall } from './ai.tools'
import { fromPiToolCall, readPiFailure, toPiMessages, toPiTools, type WireLike } from './ai.pi.rules'
import { createRuntime } from './ai.pi.runtime'

/**
 * AI 调用层（D-026 起是极薄客户端，**D-044 起底层换成 pi-ai**）。
 *
 * 为什么换（用户 2026-10-13：「我说的是让你用 pi-agent 或者其他现成的」）：原先自己写的
 * 原因是这台网关太窄（会话头、结构化输出偶发 400、思维链要回传），而实测 pi-ai
 * **内置了这台网关的目录**（`providers/opencode-go`：`thinkingFormat: deepseek`、
 * `requiresReasoningContentOnAssistantMessages` 正是 R-23 的成因）——官方已把这类怪癖
 * 编进适配器，再自己维护一份不划算（验证见 D-042，决定见 D-044）。
 *
 * **对外契约一字未改**：`chatJson` / `chatStreamEvents` 的签名、`StreamEvent` 的形状、
 * `AiUpstreamError` 的话术与状态码（401/403/429/5xx/其他）都照旧——
 * service / controller / 前端 / 28 条接口验收脚本因此一行都不用动。
 *
 * 客户端**只做**四件事，其余（SSE 解析、工具参数碎片拼装、思维链回传、兼容性开关）
 * 都交给 pi-ai：发消息 → 收正文与工具调用 → 把失败翻成人话 → 保证取消与超时。
 */
export interface ChatRequest {
  messages: ChatMessage[]
  systemPrompt: string
  /**
   * 期望结构化输出时用：传**这一条路自己的** `response_format`（OpenAI 兼容的 json_schema）。
   *
   * 刻意要求调用方显式给出而不是一个 `json: true` 布尔：曾经布尔为真时统一发推荐的
   * `PICKS_SCHEMA`，于是"提示词"那条路被强制返回 `{picks:[...]}`、解析必然失败
   * （见 PROMPTS_SCHEMA 的注释）。**用错 schema 的代价是功能静默失效**，
   * 所以这里让它变成类型上必须交代的一件事。
   */
  jsonSchema?: unknown
  temperature?: number
  signal?: AbortSignal
  /**
   * 挂在**最后一条 user 消息**上的图片（F16-04 冰箱拍照识别用它）。
   *
   * 为什么做成一个独立字段而不是让 `messages` 自带内容块：这条路（非流式 + 结构化输出）
   * 的调用方只有一个，而"给最后那句话附一张图"正好就是它的形状。把 `ChatMessage` 也改成
   * 联合类型会波及 `chatStreamEvents` 与它的所有调用点，而它们本来就走另一条路。
   */
  images?: { data: string; mimeType: string }[]
}

export class AiUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'AiUpstreamError'
  }
}

const logger = new Logger('AiClient')

/** 一次调用的公共装配：模型元数据 + 取消/超时控制器，**只有这一处**处理取消语义 */
async function prepare(config: AiConfig, signal?: AbortSignal) {
  const runtime = await createRuntime(config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  // 调用方的取消（客户端断线）也要传导下去，别让上游白跑一轮
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  // pi-ai 的失败是"消息里的 stopReason"而不是抛异常，所以自己记一下是不是我们主动中止的
  let aborted = false
  controller.signal.addEventListener('abort', () => { aborted = true }, { once: true })
  return {
    runtime,
    controller,
    isAborted: () => aborted,
    done: () => clearTimeout(timer),
    /** 每次调用共用的请求选项（密钥、会话头、超时信号） */
    options: (temperature: number): ModelsApiStreamOptions<'openai-completions'> => ({
      apiKey: config.apiKey,
      temperature,
      signal: controller.signal,
      transformHeaders: (headers: ProviderHeaders) => withSessionHeader(headers),
    }),
  }
}

/**
 * 非流式一次性调用（推荐 / 快问示例两条路用它）。
 *
 * 与迁移前的差异（都是 pi-ai 决定的，实测已验，见 D-042）：
 * - 底层走的是**流式请求**（pi-ai 恒发 `stream: true`），只是把整段收齐再返回；
 *   实测"结构化输出（json_schema + strict）与流式叠加"在这台网关下可用；
 * - `response_format` 通过 `onPayload` 注入——pi-ai 没为它建模，`onPayload` 是官方口子；
 * - `AI_JSON_SCHEMA=0` 时**不发** `response_format`（与迁移前同一个总开关）。
 *
 * 迁移后少了一个脆弱点：原先网关偶发 400 拒绝 `response_format` 时，客户端要凭"这个 400
 * 只可能是它引起的"去参数重试一次；现在这个 400 会作为上游失败如实报出（话术不变）。
 */
export async function chatJson(config: AiConfig, request: ChatRequest): Promise<string> {
  const { runtime, isAborted, done, options } = await prepare(config, request.signal)
  const structured = Boolean(request.jsonSchema && config.sendJsonSchema)

  try {
    const run = async (withSchema: boolean) => {
      const stream = runtime.models.stream(
        runtime.model,
        {
          systemPrompt: request.systemPrompt,
          messages: simpleMessages(request.messages, { provider: runtime.model.provider, model: runtime.model.id }, request.images),
        },
        {
          ...options(request.temperature ?? 0.7),
          ...(withSchema ? { onPayload: (payload) => withResponseFormat(payload, request.jsonSchema) } : {}),
        },
      )
      const result = await stream.result()
      return { result, failure: readPiFailure(result, isAborted()) }
    }

    let { result, failure } = await run(structured)

    /*
     * 网关对 response_format 的支持是**按后端路由**的：同一台网关有时 200，有时 400
     * （错误体明说 `This response_format type is unavailable now`，实测约 8 次里 5 次被拒）。
     * 去掉它重试一次——判据只看状态码：我们刚发过一次带 response_format 的请求，请求体其余
     * 部分（模型名、密钥、消息）与不带结构化的那条路完全相同，而那条路一直正常，
     * 所以这个 400 只可能是它引起的。只重试一次、且只在"发过结构化参数"时重试，不会循环。
     *
     * 这一层不随迁移去掉：pi-ai 不认这个参数（它没为 response_format 建模），
     * 也就不知道"这个 400 该摘掉谁"——**重试的责任在注入方**（见 D-044）。
     */
    if (failure?.kind === 'http' && failure.status === 400 && structured && isResponseFormatRejection(failure.detail)) {
      logger.warn(`上游不支持结构化输出（400）：${failure.detail.slice(0, 100)}，去掉 response_format 重试一次`)
      ;({ result, failure } = await run(false))
    }

    if (failure) throw toUpstreamError(failure, config)
    const text = textOf(result)
    if (!text) throw new AiUpstreamError('AI 没有给出回答（回包是空的）', 502)
    return text
  } catch (error) {
    throw normalizeFailure(error, config)
  } finally {
    done()
  }
}

/**
 * 这个 400 是不是"不接受 response_format"引起的。
 *
 * 只看状态码不够：400 也可能是模型名写错、消息格式不对（那些**不该**摘掉 schema 重试，
 * 重试一次白花用户额度，还掩盖了真正的问题）。所以这里认两件事：
 * 错误体里提到 response_format，或者提到这个网关那种"参数不可用"的措辞。
 * 网关的错误体有两种形状，实测都见过：明说的那种，与只回 `{"model":"..."}` 的截断那种
 * （截断的认不出来 → 不重试，如实报错，比乱试强）。
 */
export function isResponseFormatRejection(detail: string): boolean {
  return /response_format/i.test(detail) || /unavailable now/i.test(detail)
}

/**
 * 流式对话 + 工具调用：把正文增量与工具调用**逐事件**交给调用方。
 *
 * 与 `chatJson` 的差别只剩"要流"这一件事——SSE 解析、`tool_calls` 按 index 归并
 * （协议把一次调用切成好几片发）都由 pi-ai 负责，它在本项目**已经验过**
 * （stub 故意按碎片发参数，见 D-042 的第六项）。
 *
 * 事件形状与迁移前完全一致（正文增量 + 一整轮读完的工具调用），所以
 * `runToolLoop` 的三行分发逻辑一行不用改。
 */
export interface WireMessage extends WireLike {}

export interface ToolStreamRequest {
  systemPrompt: string
  messages: WireMessage[]
  /** 传了就允许模型调工具；不传就是纯聊天（与旧行为一致） */
  tools?: readonly unknown[]
  temperature?: number
  signal?: AbortSignal
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }

export async function* chatStreamEvents(config: AiConfig, request: ToolStreamRequest): AsyncGenerator<StreamEvent> {
  const { runtime, isAborted, done, options } = await prepare(config, request.signal)

  try {
    const stream = runtime.models.stream(
      runtime.model,
      {
        systemPrompt: request.systemPrompt,
        messages: toPiMessages(request.messages, { provider: runtime.model.provider, model: runtime.model.id }),
        ...(request.tools?.length ? { tools: toPiTools(request.tools as Parameters<typeof toPiTools>[0]) } : {}),
      },
      options(request.temperature ?? 0.7),
    )

    for await (const event of stream) {
      if (event.type === 'text_delta') {
        yield { type: 'text', text: event.delta }
      } else if (event.type === 'toolcall_end') {
        // 一次给一个（调用方会攒起来）；参数在这里已拼装完整——半截 JSON 交给谁都没法执行
        yield { type: 'tool_calls', calls: [fromPiToolCall(event.toolCall)] }
      } else if (event.type === 'error') {
        throw toUpstreamError(readPiFailure(event.error, isAborted()) ?? { kind: 'connection', detail: '' }, config)
      }
    }

    const result = await stream.result()
    const failure = readPiFailure(result, isAborted())
    if (failure) throw toUpstreamError(failure, config)
  } catch (error) {
    throw normalizeFailure(error, config)
  } finally {
    done()
  }
}

/**
 * 非流式请求的消息形状（system 由 systemPrompt 承载；这里只传 user/assistant 的纯文本）。
 *
 * 助手消息在 pi-ai 里是**完整对象**（要 api/provider/model/usage/stopReason）——它用这些
 * 字段判断"这条历史怎么重放"。填零用量是安全的：这些值只参与上下文估算，不参与请求体
 * （真正发出去的只有 role/content/tool_calls/思维链字段）。
 */
function simpleMessages(
  messages: readonly ChatMessage[],
  identity: { provider: string; model: string },
  images: { data: string; mimeType: string }[] = [],
): Message[] {
  return messages.map((message, index) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: message.content }],
        api: 'openai-completions' as const,
        provider: identity.provider,
        model: identity.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      }
    }
    /*
     * 图片挂**最后一条** user 消息（调用方的语义就是"给这句话附一张图"）。
     * 空文本块要丢掉：有的网关会把空 text 判成非法，而"只给一张图 + 一句要求"
     * 是很常见的形状（提示词本身就承载了全部任务说明）。
     */
    if (images.length > 0 && index === messages.length - 1) {
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = []
      if (message.content) content.push({ type: 'text' as const, text: message.content })
      for (const image of images) content.push({ type: 'image' as const, data: image.data, mimeType: image.mimeType })
      return { role: 'user' as const, content, timestamp: Date.now() }
    }
    return { role: 'user' as const, content: message.content, timestamp: Date.now() }
  })
}

/**
 * 会话头：这个网关强制要 `x-opencode-session`，不然 400（实测错误原文
 * `MissingSessionID`）。每次调用用不同的 id（timestamp），避免被网关当成同一对话堆上下文。
 *
 * 用 pi-ai 的 `transformHeaders`（它专为这类网关留的口子）而不是自己包 fetch：
 * 头在"鉴权之后、派发之前"合并，是唯一能保证不被覆盖的位置。
 */
function withSessionHeader(headers: ProviderHeaders): ProviderHeaders {
  return { ...headers, 'x-opencode-session': `cook-ai-${Date.now()}` }
}

/** 结构化输出：把 schema 注进请求体（pi-ai 没为 response_format 建模，onPayload 是它的口子） */
function withResponseFormat(payload: unknown, jsonSchema: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  return { ...(payload as Record<string, unknown>), response_format: jsonSchema }
}

/** 助手消息里的正文（多段拼起来；推理内容不算回答——与迁移前同一个口径） */
function textOf(message: { content?: unknown }): string {
  const blocks = (message.content ?? []) as { type?: string; text?: string }[]
  return blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('').trim()
}

/** pi-ai 的失败形态 → 迁移前同一套话术与状态码 */
function toUpstreamError(failure: NonNullable<ReturnType<typeof readPiFailure>>, config: AiConfig): AiUpstreamError {
  if (failure.kind === 'timeout') {
    return new AiUpstreamError(`AI 响应超过 ${Math.round(config.timeoutMs / 1000)} 秒，先不等了——过会儿再试`, 504)
  }
  if (failure.kind === 'http') {
    logger.warn(`上游 ${failure.status}（model=${config.model}）：${failure.detail}`)
    return new AiUpstreamError(upstreamMessage(failure.status, failure.detail), failure.status)
  }
  logger.warn(`上游连接失败（model=${config.model}）：${failure.detail}`)
  return new AiUpstreamError('连不上 AI 服务，检查 .env 里的 AI_API_BASE 是否可达', 502)
}

/** 已经是我们的错误就原样放行；别的（含 pi-ai 的加载失败）一律按"连不上"处理，别冒成 500 */
function normalizeFailure(error: unknown, config: AiConfig): unknown {
  if (error instanceof AiUpstreamError) return error
  const detail = (error as Error)?.message ?? String(error)
  logger.warn(`上游调用失败（model=${config.model}）：${detail}`)
  return new AiUpstreamError('连不上 AI 服务，检查 .env 里的 AI_API_BASE 是否可达', 502)
}

function upstreamMessage(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AI 服务不认这个密钥（AI_API_KEY 可能填错了）'
  if (status === 429) return 'AI 服务限流了，缓一会儿再试'
  if (status >= 500) return `AI 服务自己出错了（${status}），过会儿再试`
  return `AI 服务没接受这次请求（${status}）：${detail}`
}
