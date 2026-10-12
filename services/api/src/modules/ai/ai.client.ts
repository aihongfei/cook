import { Logger } from '@nestjs/common'
import { PICKS_SCHEMA, type AiConfig, type ChatMessage } from './ai.rules'

/**
 * 直连 OpenAI 兼容接口的极薄客户端（D-026）。
 *
 * 为什么不用现成的 SDK：这里只需要一个能力——**把 messages 发到一个配置好的地址、拿回文本**。
 * 一台家庭服务器上一个 HTTP POST 就够了，引 SDK 要背上依赖树与 ESM/CJS 互操作（实测 pi-ai
 * 在本项目的 CommonJS 构建下 require 不了，且带 70+ 传递依赖）。多模态与工具调用（M16 的真正
 * 主场）再评估换 harness（见 D-009/D-026）。
 *
 * 三件必须做对的事：
 * - **超时不靠运气**：AbortController 兜住（模型慢/网关挂住时用户体验是"转圈到天亮"）；
 * - **错误话术可读**：上游 401/429/500 都翻成人能看懂的一句，别把 HTML 错误页甩到界面上；
 * - **密钥不落日志**：日志只记 model 与状态码。
 */
export interface ChatRequest {
  messages: ChatMessage[]
  systemPrompt: string
  /** 期望结构化输出时用（OpenAI 兼容的 response_format，见 PICKS_SCHEMA） */
  json?: boolean
  temperature?: number
  signal?: AbortSignal
}

export class AiUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'AiUpstreamError'
  }
}

const logger = new Logger('AiClient')

export async function chatJson(config: AiConfig, request: ChatRequest): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  // 调用方的取消（客户端断线）也要传导下去，别让上游白跑一轮
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true })

  const buildBody = (structured: boolean) => ({
    model: config.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    temperature: request.temperature ?? 0.7,
    // 显式要非流式：不写这一行时上游可能默认走 SSE，而我们要的是"拿回整段文本"
    // （实测踩过：不写 stream:false 时上游回 SSE，客户端按 JSON 解析直接失败）
    stream: false,
    // 结构化输出：json_schema + strict（**不要用老的 json_object**——那个在本网关下会让模型
    // 把参数当正文回，见 rules 的 PICKS_SCHEMA 注释）
    ...(structured ? { response_format: PICKS_SCHEMA } : {}),
  })

  // OpenCode ZenGo 这类 agentic 网关强制要 x-opencode-session，不然会 400。
  // 每次调用用不同的 id（timestamp），避免被网关当成同一对话堆上下文。
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    'x-opencode-session': `cook-ai-${Date.now()}`,
  }

  const post = (structured: boolean) => fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(structured)),
    signal: controller.signal,
  })

  try {
    let structured = Boolean(request.json && config.sendJsonSchema)
    let response = await post(structured)

    // 网关对 response_format 的支持是**按后端路由**的：同一台网关有时回 200，有时 400。
    // 实测 8 次里 5 次被拒，而且错误体有两种形状——一种明说
    // `This response_format type is unavailable now`，另一种只回 `{"model":"deepseek-v4.1-flash"}`
    // （信息被截没了）。所以判据**只能看状态码**：我们刚发过一次带 response_format 的请求，
    // 其余的请求体（模型名、密钥、消息）与 /ai/chat 完全相同而 chat 一直正常，那这个 400
    // 就只可能是 response_format 引起的。去掉它重试一次，别让用户为这个参数吃一次失败。
    // 只重试一次、且只在"发过结构化参数"时重试——不会循环，别的 400（如模型名写错）多花一轮即可暴露。
    if (!response.ok && structured && response.status === 400) {
      const detail = await safeErrorText(response.clone())
      logger.warn(`上游不支持结构化输出（${response.status} ${detail.slice(0, 100)}），去掉 response_format 重试一次`)
      structured = false
      response = await post(false)
    }

    if (!response.ok) {
      const detail = await safeErrorText(response)
      logger.warn(`上游 ${response.status}（model=${config.model}）：${detail}`)
      throw new AiUpstreamError(upstreamMessage(response.status, detail), response.status)
    }

    // 有的网关即使收到 stream:false 也照样回 SSE，所以按 content-type 分流，两种都认
    const contentType = response.headers.get('content-type') ?? ''
    const content = contentType.includes('text/event-stream')
      ? readSseText(await response.text())
      : readJsonText(await response.json())

    if (!content) throw new AiUpstreamError('AI 没有给出回答（回包是空的）', 502)
    return content
  } catch (error) {
    if (error instanceof AiUpstreamError) throw error
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new AiUpstreamError(`AI 响应超过 ${Math.round(config.timeoutMs / 1000)} 秒，先不等了——过会儿再试`, 504)
    }
    logger.warn(`上游连接失败（model=${config.model}）：${(error as Error)?.message ?? error}`)
    throw new AiUpstreamError('连不上 AI 服务，检查 .env 里的 AI_API_BASE 是否可达', 502)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式对话：把上游的 SSE 逐块读出来，**每读到一段就 yield 一段**。
 *
 * 为什么值得单独写一条路：实测这个模型要先推理 5～40 秒才吐正文，一次性等回包的话
 * 用户盯着转圈的时间几乎等于全程；流式能让第一个字一出现就上屏，等待感差别很大。
 *
 * 与 `chatJson` 的差别只有两处，别的一律照旧：
 * - 请求体发 `stream: true`，且**不带 response_format**（结构化输出与流式要靠流式 JSON 解析凑，
 *   而我们这边已经有容忍解析 `scanPicks`，不需要再赌网关支不支持两者叠加）；
 * - 回包按 SSE 边读边给，不 `await` 到整段。
 *
 * 没有流可读（上游直接回 JSON、或网关把 stream 忽略了）时，退回一次性解析——**不报错**，
 * 因为对调用方来说"拿到了完整回答"这个结果是一样的。
 */
export async function* chatStream(config: AiConfig, request: ChatRequest): AsyncGenerator<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    'x-opencode-session': `cook-ai-${Date.now()}`,
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: request.systemPrompt },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        temperature: request.temperature ?? 0.7,
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await safeErrorText(response)
      logger.warn(`上游 ${response.status}（流式，model=${config.model}）：${detail}`)
      throw new AiUpstreamError(upstreamMessage(response.status, detail), response.status)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      // 上游没按流回（有的网关会忽略 stream）：整段读出来一次 yield，结果一样
      const content = readJsonText(await response.json())
      if (!content) throw new AiUpstreamError('AI 没有给出回答（回包是空的）', 502)
      yield content
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔；最后一段可能被切断，留在 buffer 里等下一块
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const delta = readSseDelta(event)
        if (delta) yield delta
      }
    }
    // 收尾：上游最后一段没跟空行时也要认
    const tail = readSseDelta(buffer)
    if (tail) yield tail
  } catch (error) {
    if (error instanceof AiUpstreamError) throw error
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new AiUpstreamError(`AI 响应超过 ${Math.round(config.timeoutMs / 1000)} 秒，先不等了——过会儿再试`, 504)
    }
    logger.warn(`上游连接失败（流式，model=${config.model}）：${(error as Error)?.message ?? error}`)
    throw new AiUpstreamError('连不上 AI 服务，检查 .env 里的 AI_API_BASE 是否可达', 502)
  } finally {
    clearTimeout(timer)
  }
}

/** 一个 SSE 事件块里的正文增量（只认 choices[0].delta.content，推理内容不算回答） */
function readSseDelta(event: string): string {
  let text = ''
  for (const line of event.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }
      const delta = parsed.choices?.[0]?.delta?.content
      if (typeof delta === 'string') text += delta
    } catch {
      // 跳过解析不了的段落（心跳/注释/半截 JSON）
    }
  }
  return text
}

/**
 * 上游错误体可能是一大段 HTML/JSON，截断并尽量取出"人话"那一层。
 *
 * 实测网关的错误体有几种形状，取错了会得到莫名其妙的一句（曾把 `{"model":"deepseek-v4.1-flash"}`
 * 当详情甩给用户）。所以按 `error.message` → 顶层 `message` → 最外层原文依次退，非字符串的
 * message 不再当正文用（那通常是个对象，里面是一个更深的错误结构）。
 */
async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 400)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
      const message = parsed.error?.message ?? parsed.message
      if (typeof message === 'string' && message.trim()) return message.slice(0, 200)
    } catch {
      // 不是 JSON 就用截断后的原文
    }
    return text
  } catch {
    return '（读不到错误详情）'
  }
}

function upstreamMessage(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AI 服务不认这个密钥（AI_API_KEY 可能填错了）'
  if (status === 429) return 'AI 服务限流了，缓一会儿再试'
  if (status >= 500) return `AI 服务自己出错了（${status}），过会儿再试`
  return `AI 服务没接受这次请求（${status}）：${detail}`
}

/** 非流式回包：OpenAI 兼容形状的 choices[0].message.content */
function readJsonText(payload: unknown): string {
  const content = (payload as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

/**
 * SSE 回包：把各段 `choices[0].delta.content` 拼起来。
 *
 * 只取 `data:` 行、遇到 `[DONE]` 就停；解析不了的段落直接跳过——
 * 上游偶尔会插空行、注释行（`: keep-alive`）或心跳，为这些细节报错不划算。
 */
function readSseText(raw: string): string {
  let text = ''
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }
      const delta = parsed.choices?.[0]?.delta?.content
      if (typeof delta === 'string') text += delta
    } catch {
      // 跳过解析不了的段落（见上）
    }
  }
  return text.trim()
}
