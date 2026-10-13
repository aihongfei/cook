import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
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

/**
 * 快问与示例问题（用户 2026-10-12：「这块也要使用ai吧，内置的这些不够用」）。
 *
 * 后端按**这家人的实际情况**（几口人、最近常点什么、什么季节）现写两批短句；
 * `ai-prompts.ts` 里写死的那份**降级为兜底**——没配 AI、还在生成、生成失败时照旧能用。
 */
export interface AiPrompts {
  /** 「AI 帮你想」的快问（点一下等于替我打了这句话） */
  hints: string[]
  /** 「问 AI」的示例问题（示范这个入口能问多细） */
  examples: string[]
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

/**
 * 一张回执上的一笔（F16-10 / D-052 的 A 档）。
 *
 * **它是"AI 真的写进库了"这句话的证据**：模型说"记好了"却拿不出一张卡，那就是在骗人。
 * 所以前端只在收到 `receipts` 事件时才把卡画出来（不去猜"它大概写了吧"）。
 *
 * `id` 是服务端那条写入记录的 id，「撤」拿它去调 `/ai/actions/:id/undo`——
 * **撤销的判断全在服务端**（用户改过、那条已不在、已经撤过了，三种都要给出人话），
 * 前端不做也不该做这类判断：让客户端决定服务端写什么，等于把护栏交出去。
 */
export interface AiReceipt {
  /** 写入记录的 id（撤销要用） */
  id: string
  kind: string
  /** 一笔写的是什么，如「鸡蛋 · 一盒 · 冷藏」 */
  summary: string
  /** 撤销按钮上的字：「撤掉」/「改回去」/「放回去」 */
  label: string
  /** 被写的那条 target id（撤「删除」重建时要用，前端只当不透明值） */
  target: string
  /**
   * **前端自己打的标**：这一笔已经撤过了（服务端不返回它）。
   * 撤过的卡不删掉而是划掉——撤了什么也该看得见，否则用户回头会以为自己没点过。
   */
  undone?: boolean
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

/**
 * 快问/示例问题（按家庭现生成）。**只在 AI 已配置且真的要用时请求**（`enabled`），
 * 失败也不重试——它只是入口处的引导语，拿不到就用写死的那份，不该让用户看见错误提示。
 *
 * **每次打开都现要一批**（用户 2026-10-12：「可以每次点开都使用ai生成，不然都是这几个推荐和问题」）。
 * `staleTime: 0` 让缓存只当"先垫着的那一份"：重挂载（=重新打开抽屉）必然再去生成一批；
 * 生成要 8 秒左右，这期间界面用上一次那批，不空着也不闪兜底。两个抽屉同时开只发一次请求
 * （同一个 queryKey，在途请求会合并）。
 *
 * `refetchOnWindowFocus` 关掉：移动端切出去再回来就会重新聚焦，那会在用户正要点的时候
 * 把标签换掉——"刚要点的那个自己跑掉"，与 AiSuggestSheet 里那处要避免的是同一个毛病。
 * 重新生成只认"重新打开"这一个由头。
 */
export function useAiPrompts(enabled: boolean) {
  return useQuery({
    queryKey: ['ai', 'prompts'],
    queryFn: async () => {
      const { data } = await apiClient.post<AiPrompts>('/ai/prompts', {}, { timeout: AI_TIMEOUT_MS })
      return data
    },
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
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
    /**
     * AI 真写进库的那几笔（可选）：**只在这一轮真的写了时才调**。
     * 收到它才画回执卡——卡片是"它办成了事"的证据，不能靠猜。
     */
    onReceipts?: (items: AiReceipt[]) => void
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
            type?: string; text?: string; label?: string
            items?: MenuProposal[] | AiReceipt[]; error?: string
          }
          // 头已经发出去了，中途失败是以 error 事件回来的（见后端 chatStream）
          if (payload.error) throw new StreamError(payload.error, 502)
          // 按 type 分派而不是"猜有哪些字段"：四种事件共用一套解析（见具名事件的说明）
          if (payload.type === 'status' && payload.label) handlers.onStatus?.(payload.label)
          else if (payload.type === 'proposals' && Array.isArray(payload.items)) {
            handlers.onProposals?.(payload.items as MenuProposal[])
          } else if (payload.type === 'receipts' && Array.isArray(payload.items)) {
            handlers.onReceipts?.(payload.items as AiReceipt[])
          } else if (payload.text) handlers.onChunk(payload.text)
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

/**
 * AI 写过库之后，把**它可能动过的那些域**的缓存全部作废。
 *
 * 为什么是一张固定的清单而不是按回执的 `kind` 分派：回执里只有一个 `kind` 字符串，
 * 让前端拿它去查"该作废哪个 key"等于把后端的动作枚举复制一份到前端——
 * 后端加一种新动作时前端必然漏掉一处（而漏掉的后果就是**页面上看不见刚发生的事**，
 * 用户会以为 AI 在骗他）。宁可多作废一个没动过的域（它本来就没被取过，不会发请求）。
 *
 * 这份清单与 AI 现在能写的六块一一对应（D-052/D-053 + 2026-10-13 的全应用 CRUD）：
 * 冰箱、菜谱（含「我的菜谱」）、收藏、常用组合、菜单/餐次、采购清单（由菜单推导）。
 *
 * 只作废不自己拼缓存：回执里只有一句摘要，硬 set 一份"猜的"数据比不动更糟。
 */
export function invalidateAfterAiWrite(queryClient: QueryClient): void {
  for (const key of ['fridge', 'recipes', 'favorites', 'combos', 'orders', 'shopping']) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/**
 * 撤一笔 AI 写库。
 *
 * **成功之后必须让相关页面跟着变**（用户 2026-10-13：「在我的菜谱页面使用 ai 添加菜谱后，
 * 背后的菜谱没有自动刷新」——那正是这里只作废了冰箱导致的）。
 * 用户撤完/写完很可能就是回那一页看结果，如果那页还显示着旧内容，
 * 他会以为 AI 没生效或撤销坏了——真去再进一次就能发现，但那一瞬间的困惑是白搭的。
 */
export function useUndoAiAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<{ message: string; undone: boolean }>(`/ai/actions/${id}/undo`)
      return data
    },
    onSuccess: () => invalidateAfterAiWrite(queryClient),
  })
}
