import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * AI 推荐与问答（M16 子集 / D-026）。
 *
 * 三件事值得先知道：
 * - **超时要单独放宽**：`apiClient` 默认 15 秒是给普通接口的，模型一次推荐要 11～40 秒，
 *   用默认值会一半请求在客户端就被掐断。这里显式给 120 秒（与服务端上限一致）。
 * - **没配 AI 不是错误**：`/ai/status` 免登录可读，前端据此显示入口或"去配置"。
 *   真去调用未配置的接口会得到 503 + 怎么配，那是**故意**的（不静默降级到假数据）。
 * - **推荐结果只有 id 与理由**：菜名/图片由后端按库里真实数据回填（模型编的 id 已被丢掉），
 *   所以这里的 picks 可以直接当作"库里存在的菜"用。
 */

/** 模型一次调用可能跑很久（推理模型 11～40 秒），别用客户端的默认 15 秒 */
const AI_TIMEOUT_MS = 120_000

/** fetch 直连时用同一个地址口径（apiClient 的 baseURL 也是它） */
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api'

export interface AiStatus {
  configured: boolean
  model: string | null
}

export interface SuggestedPick {
  recipeId: string
  name: string
  reason: string
}

export interface SuggestResult {
  picks: SuggestedPick[]
  hint: string
  /** 这次从库里取了多少道候选给模型（0 = 库里搜不到，模型没得挑） */
  candidates: number
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 一条"要不要加进菜单"的建议（D-026 第三次补充）。
 *
 * 它是**提议**不是既成事实：用户点了确认才会走 `/orders/items` 真的写进那一餐
 * （与手点同一条接口）。所以这里不需要任何"撤销"逻辑——没点就等于没发生。
 */
export interface MenuProposal {
  recipeId: string
  name: string
  mealDate: string
  meal: 'LUNCH' | 'DINNER'
  note: string
  /** 按钮上的人话，如「今天晚餐」 */
  when: string
}

export async function fetchAiStatus(): Promise<AiStatus> {
  const { data } = await apiClient.get<AiStatus>('/ai/status')
  return data
}

export function useAiStatus() {
  return useQuery({
    queryKey: ['ai', 'status'],
    queryFn: fetchAiStatus,
    // 配置是服务端环境变量决定的，一次会话里不会变；不用反复问
    staleTime: 5 * 60_000,
  })
}

export function useAiSuggest() {
  return useMutation({
    mutationFn: async (input: { hint?: string }) => {
      const { data } = await apiClient.post<SuggestResult>('/ai/suggest', input, { timeout: AI_TIMEOUT_MS })
      return data
    },
  })
}

export function useAiChat() {
  return useMutation({
    mutationFn: async (messages: ChatTurn[]) => {
      const { data } = await apiClient.post<{ reply: string }>('/ai/chat', { messages }, { timeout: AI_TIMEOUT_MS })
      return data
    },
  })
}

/**
 * 流式问答：POST /ai/chat/stream，按 SSE 逐段把文字喂给回调。
 *
 * 为什么不用 EventSource：`EventSource` 只能发 GET，带不了请求体也带不了 Authorization 头
 * （令牌在头里，不在 URL 里）。所以用 fetch 读 `response.body`，自己按 SSE 切块——
 * 与后端 ai.controller 里写的格式对应（`data: {"text":"..."}` / `data: [DONE]`）。
 *
 * 回调里的 `chunk` 是**增量**（这一小段文字），调用方负责接到已有文字后面。
 *
 * 三种具名事件（`event: text|status|proposals`，见后端 ai.controller）：
 * - `text`：正文增量；
 * - `status`：工具执行中的一句人话（"正在翻菜谱…"）。**工具轮次要好几秒**，
 *   没有它用户只看到光标闪，像是卡住了；
 * - `proposals`：攒好的加菜建议，抽屉里据此长出确认按钮。它在**流结束时**才到
 *   （服务端要等模型把话说完才交），所以不要用它来结束等待——以 `[DONE]` 为准。
 */
export async function streamAiChat(
  messages: ChatTurn[],
  handlers: {
    /** 每收到一段就调一次（增量文本） */
    onChunk: (text: string) => void
    /** 工具执行中的状态提示（可选）：传了就显示，不传就当没有 */
    onStatus?: (label: string) => void
    /** 全部建议（可选）：流结束时一次性给出 */
    onProposals?: (items: MenuProposal[]) => void
    signal?: AbortSignal
  },
): Promise<void> {
  const token = useAuth.getState().token
  const response = await fetch(`${API_BASE}/ai/chat/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages }),
    signal: handlers.signal,
  })

  // 出错时后端还没写响应头，所以这里能拿到真正的状态码与话术
  if (!response.ok) {
    let message = 'AI 服务开小差了，过会儿再试'
    try {
      const payload = (await response.json()) as { message?: string | string[] }
      const raw = payload.message
      message = Array.isArray(raw) ? String(raw[0] ?? '') || message : raw || message
    } catch {
      // 保持兜底话术
    }
    throw new StreamError(message, response.status)
  }

  if (!response.body) throw new StreamError('这次没收到 AI 的回答，再试一次', 502)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 以空行分隔事件；最后一段可能被切断，留在 buffer 里等下一块
    const events = buffer.split(/\n\n/)
    buffer = events.pop() ?? ''
    for (const event of events) {
      for (const line of event.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try {
          const payload = JSON.parse(data) as {
            type?: string; text?: string; label?: string; items?: MenuProposal[]; error?: string
          }
          // 头已经发出去了，中途失败是以 error 事件回来的（见后端 chatStream）
          if (payload.error) throw new StreamError(payload.error, 502)
          // 按 type 分派而不是"猜有哪些字段"：三种事件共用一套解析（见具名事件的说明）
          if (payload.type === 'status' && payload.label) handlers.onStatus?.(payload.label)
          else if (payload.type === 'proposals' && Array.isArray(payload.items)) handlers.onProposals?.(payload.items)
          else if (payload.text) handlers.onChunk(payload.text)
        } catch (error) {
          if (error instanceof StreamError) throw error
          // 半截 JSON：跳过（下一块会补全成新的一段）
        }
      }
    }
  }
}

/** 流式问答的失败（带状态码，便于按 apiErrorMessage 的同一套话术显示） */
export class StreamError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'StreamError'
    this.status = status
  }
}
