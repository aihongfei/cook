import { BadRequestException } from '@nestjs/common'

/**
 * AI 能力的纯规则（M16 的子集 / 用户 2026-10-12 的新需求，口径见 D-026）。
 *
 * 与其它模块同一套路：**不碰网络与数据库的判定都在这里**——配置读取、候选菜清单的拼装、
 * 模型回包的校验都是纯函数，单测直接验，不用起服务和真模型。
 *
 * 一条贯穿始终的原则：**模型的输出是"不可信输入"**。它可能编菜名、给不存在的 id、
 * 回一段不是 JSON 的话。所以推荐结果一律要拿候选清单**核对**过才往外给（见 parsePicks）。
 */

export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  /** 是否带 response_format（json_schema 结构化输出）。默认开，见 readAiConfig */
  sendJsonSchema: boolean
}

/**
 * 默认超时 90 秒。
 *
 * 原先是 30 秒，**实测兜不住**：配置里的推理模型一次推荐要 11～40 秒（回包带大段 reasoning），
 * 30 秒时半数请求超时；调到 60 秒后实测仍有约 1/14 卡线（60s+ 被掐断）。
 * 宁可多等一会儿，也别在模型马上要答时白等一轮。
 */
export const AI_TIMEOUT_DEFAULT_MS = 90_000
export const AI_TIMEOUT_MAX_MS = 120_000

/**
 * 推荐用的 JSON Schema（DeepSeek 支持结构化输出，实测 `json_schema` + `strict` 在本网关正常工作）。
 *
 * **为什么必须是 json_schema 而不是老的 `json_object`**：实测配了 `{"type":"json_object"}` 时，
 * 模型会把该参数原样当正文回（回包正文就是 `{"type":"json_object"}`，reasoning 花掉 900+ token
 * 却什么都没答），推荐必然解析失败；换成 `json_schema` + `strict` 后回的是
 * `{"picks":[{"id":"...","reason":"..."}]}`，干净可用。
 *
 * `strict` + `additionalProperties:false` 是让模型**没机会**自由发挥：字段就那么两个。
 */
export const PICKS_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'picks',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, reason: { type: 'string' } },
            required: ['id', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['picks'],
      additionalProperties: false,
    },
  },
} as const

/**
 * 从环境变量读配置。**没配就是没配**（返回 null），不猜、不给默认模型——
 * 赌一个默认值只会在将来某天悄悄替用户做一个他没同意的选择。
 *
 * 结构化输出（`AI_JSON_SCHEMA`）**默认开**：让模型按 schema 回，比在提示词里求它"只输出 JSON"
 * 靠谱得多（回包形状确定，解析不再靠运气）。只有上游不认 `response_format` 时才关掉
 * ——那种上游会回 4xx，我们翻成"AI 服务没接受这次请求"，一看就知道该关这个开关。
 */
export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const baseUrl = env.AI_API_BASE?.trim()
  const apiKey = env.AI_API_KEY?.trim()
  const model = env.AI_MODEL?.trim()
  if (!baseUrl || !apiKey || !model) return null

  const raw = Number(env.AI_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, AI_TIMEOUT_MAX_MS) : AI_TIMEOUT_DEFAULT_MS
  const flag = env.AI_JSON_SCHEMA?.trim().toLowerCase()
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    timeoutMs,
    sendJsonSchema: flag !== '0' && flag !== 'false',
  }
}

/** 推荐时让模型从这些菜里挑（不给全库，几千道塞不进上下文也没必要） */
export const SUGGEST_CANDIDATES = 24
export const SUGGEST_PICKS_MAX = 5
/** 聊天/推荐输入的长度闸门：家庭场景用不到长篇大论，也防着有人拿它当免费 LLM 用 */
export const AI_HINT_MAX = 200
export const AI_MESSAGE_MAX = 1000
export const AI_MESSAGES_MAX = 10

export interface CandidateDish {
  id: string
  name: string
  category: string
  tags: string[]
  spiciness: number
}

export interface SuggestedPick {
  recipeId: string
  name: string
  reason: string
}

export function parseHint(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new BadRequestException('hint 只能是文字')
  const hint = raw.trim()
  if (hint.length > AI_HINT_MAX) throw new BadRequestException(`一次最多说 ${AI_HINT_MAX} 个字`)
  return hint
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 只放行 user/assistant 两种角色：system 由服务端拼，不让调用方塞（否则提示词会被顶掉） */
export function parseChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('至少要有一句话')
  if (raw.length > AI_MESSAGES_MAX) throw new BadRequestException(`一次最多带 ${AI_MESSAGES_MAX} 条消息`)
  return raw.map((item) => {
    const role = (item as { role?: unknown })?.role
    const content = (item as { content?: unknown })?.content
    if (role !== 'user' && role !== 'assistant') throw new BadRequestException('消息角色只能是 user 或 assistant')
    if (typeof content !== 'string' || !content.trim()) throw new BadRequestException('消息内容不能为空')
    if (content.length > AI_MESSAGE_MAX) throw new BadRequestException(`单条消息最多 ${AI_MESSAGE_MAX} 个字`)
    return { role, content: content.trim() }
  })
}

/** 候选清单给模型看的紧凑文本：id 是回包要引用的，必须给 */
export function formatCandidates(candidates: CandidateDish[]): string {
  return candidates
    .map((dish) => {
      const tags = dish.tags.length ? ` 标签:${dish.tags.join('/')}` : ''
      const spicy = dish.spiciness > 0 ? ` 辣度:${dish.spiciness}` : ''
      return `- id=${dish.id} ${dish.name}（${dish.category}）${tags}${spicy}`
    })
    .join('\n')
}

/**
 * 模型回了"不像答案"的东西（不是 JSON 数组、正文是空的）。
 *
 * 与输入校验错误分开：用户把请求写错是 400（改一下就能成），**模型没答好是 502**——
 * 让用户看到 400 会以为是自己填错了，反复改提示词也修不好。见 ai.service 的映射。
 */
export class AiReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiReplyError'
  }
}

/**
 * 解析并**核对**模型回的推荐。
 *
 * 三道闸门，每一道都有明确理由：
 * - 不是 JSON 数组 → 直接判失败（宁可告诉用户"AI 没答好"，也不把一段散文当成推荐塞进界面）；
 * - `id` 不在候选清单里 → **丢掉**（模型会编 id；放行就等于让它在界面上凭空造一道不存在的菜）；
 * - 同名去重、最多 5 条（模型偶尔会重复输出同一条）。
 *
 * 编造的 id 会被静默丢掉而不是整体失败：模型给 5 条里有 1 条编的，剩下 4 条仍然有用。
 */
export function parsePicks(text: string, candidates: CandidateDish[]): SuggestedPick[] {
  const parsed = extractJsonArray(text)
  if (!parsed) throw new AiReplyError('AI 的回答不是有效的推荐结果')
  const byId = new Map(candidates.map((dish) => [dish.id, dish]))
  const picks: SuggestedPick[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const recipeId = typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id.trim() : ''
    const reason = typeof (item as { reason?: unknown })?.reason === 'string' ? (item as { reason: string }).reason.trim() : ''
    const dish = byId.get(recipeId)
    if (!dish || seen.has(recipeId)) continue
    seen.add(recipeId)
    picks.push({ recipeId, name: dish.name, reason: reason.slice(0, 120) })
    if (picks.length >= SUGGEST_PICKS_MAX) break
  }
  return picks
}

/**
 * 从模型的回包里抠出 JSON 数组。常见形状是 ```json ... ``` 包裹、前后带说明文字、
 * 或**外层套一个对象**（`{"picks":[...]}`——提示词要的是数组，但模型不总会照办）。
 * 所以先剥代码块，再依次试：整体解析 → 第一个 `[` 到最后一个 `]` → 对象里第一个数组字段。
 */
function extractJsonArray(text: string): unknown[] | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const candidates = [cleaned, cleaned.slice(cleaned.indexOf('['), cleaned.lastIndexOf(']') + 1)]
  for (const raw of candidates) {
    if (!raw.startsWith('[')) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 继续试下一种切法
    }
  }
  // 再退一步：整体是个对象时，取**元素带 id 的那个数组字段**。
  // 不取"第一个数组"：模型可能同时回别的数组（如 {"warnings":[...],"picks":[...]}），
  // 取第一个就会把警告当推荐。判据是元素里有 id——这正是我们要引用的字段。
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const array = Object.values(parsed as Record<string, unknown>)
        .find((value) => Array.isArray(value) && value.some((item) => typeof (item as { id?: unknown })?.id === 'string'))
      if (Array.isArray(array)) return array
    }
  } catch {
    // 连对象都不是，交给上层判失败
  }
  return null
}
