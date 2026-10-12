// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { ChatTurn, SuggestedPick } from '@/api/ai'
import { toast } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import AiChatSheet from './AiChatSheet'
import AiSuggestSheet from './AiSuggestSheet'

// 发现页的 AI 两个入口（M16 子集 / D-026）。要盯住的事：
// ① **没配 AI 时明说去哪配**，不给假推荐（假数据会让用户以为 AI 在工作）；
// ② 推荐落地的菜要点得动，而且**必须带着日期+餐次**——后端要求这两个字段，
//    少一个就是 400（"点这道"变成永远失败，用户只会觉得按钮坏了）；
// ③ 问答失败时用户问过的那句要留着（重问一遍还得重新打字，最气人的就是这个）。

const clients: QueryClient[] = []

function renderSheet(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: ['order.create'], members: [],
}

const OPTIONS = {
  meals: [{ value: 'LUNCH', label: '午餐' }, { value: 'DINNER', label: '晚餐' }],
  statuses: [],
  dayOptions: [
    { value: '2026-10-12', label: '今天' },
    { value: '2026-10-13', label: '明天' },
    { value: '2026-10-14', label: '后天' },
  ],
}

function mockApi({
  configured = true,
  picks = [{ recipeId: 'r1', name: '番茄炒蛋', reason: '快手' }] as SuggestedPick[],
  candidates = picks.length,
  suggestFails = false,
}: {
  configured?: boolean
  picks?: SuggestedPick[]
  candidates?: number
  suggestFails?: boolean
} = {}) {
  const get = vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/ai/status') return Promise.resolve({ data: { configured, model: configured ? 'm' : null } } as never)
    if (url === '/family') return Promise.resolve({ data: FAMILY } as never)
    if (url === '/orders/options') return Promise.resolve({ data: OPTIONS } as never)
    throw new Error(`未预期的请求：${url}`)
  })
  const post = vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/ai/suggest') {
      if (suggestFails) return Promise.reject({ response: { status: 502, data: { message: 'AI 的回答不是有效的推荐结果，再点一次试试' } } })
      return Promise.resolve({ data: { picks, hint: '', candidates } } as never)
    }
    if (url === '/orders/items') return Promise.resolve({ data: { date: '2026-10-12', mealLabel: '晚餐' } } as never)
    throw new Error(`未预期的请求：${url}`)
  })
  return { get, post }
}

/**
 * 流式问答的 fetch 桩：`/ai/chat/stream` 走的是 fetch（带 Authorization 头，EventSource 做不到），
 * 所以这里造一个真的 ReadableStream，把 `data: {"text":...}` 按段推给组件。
 * 顺带记录每次发出去的 messages，用来验"第二问带上了第一轮"。
 */
function mockStream({
  replies = ['你好'],
  failWith,
  hang = false,
}: { replies?: string[]; failWith?: string; hang?: boolean } = {}) {
  const sent: { messages: ChatTurn[] }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages: ChatTurn[] }
    sent.push(body)
    if (failWith) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ message: failWith }),
      } as unknown as Response
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const reply of replies) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: reply })}\n\n`))
        if (!hang) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        // 一直不 close（模拟"模型还在想"）。**要真的听 signal**：真实 fetch 在中止时会让
        // 正在读的 body 抛 AbortError；桩里不听的话"中途取消"这条路径永远测不到——
        // 反证时才发现（去掉 abort 判断测试照样绿，等于没验）
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'))
        })
      },
    })
    return { ok: true, status: 200, body: stream } as unknown as Response
  })
  return { sent }
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('没配 AI 时不编推荐，明说去哪配（两个入口同一口径）', async () => {
  mockApi({ configured: false })

  const suggest = renderSheet(<AiSuggestSheet visible onClose={() => {}} />)
  expect(await screen.findByText(/还没接上 AI/)).toBeTruthy()
  expect(screen.getByText(/AI_API_BASE/)).toBeTruthy()
  // 关键：不能出现"想几道"这种能按的按钮——按下去只会得到 503
  expect(screen.queryByText('想几道')).toBeNull()
  suggest.unmount()

  renderSheet(<AiChatSheet visible onClose={() => {}} />)
  expect(await screen.findByText(/还没接上 AI/)).toBeTruthy()
  // 同样不能给能按的输入框
  expect(screen.queryByPlaceholderText(/肉怎么去腥/)).toBeNull()
})

it('推荐落地的菜点得动，而且带着日期与餐次（少一个后端就 400）', async () => {
  // 固定在上午 10 点：默认"下一餐"= 今天晚餐。时间参与判定，不固定就会早晚跑出两种结果
  // （只在这个用例里开假时钟：它会拖住 react-query 的 pending 状态，问答那两个用例等不了）
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-12T10:00:00+08:00'))
  try {
    const { post } = mockApi()
    renderSheet(<AiSuggestSheet visible onClose={() => {}} />)

    fireEvent.click(await screen.findByText('清淡点'))
    expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
    expect(screen.getByText('快手')).toBeTruthy()

    fireEvent.click(screen.getByText('点这道'))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/items', expect.objectContaining({
      recipeId: 'r1', mealDate: '2026-10-12', meal: 'DINNER',
    })))
  } finally {
    vi.useRealTimers()
  }
})

it('推荐为空时说实话（不给"正在想"的假象），并指路去菜谱小书', async () => {
  mockApi({ picks: [], candidates: 0 })
  renderSheet(<AiSuggestSheet visible onClose={() => {}} />)

  fireEvent.click(await screen.findByText('快手菜'))
  expect(await screen.findByText(/这次没挑出来/)).toBeTruthy()
  expect(screen.getByText('菜谱小书')).toBeTruthy()
})

it('问答失败时用户问的那句要留着（重问一遍还得重新打字）', async () => {
  const { sent } = mockStream({ failWith: 'AI 还没配置' })
  renderSheet(<AiChatSheet visible onClose={() => {}} />)

  const input = await screen.findByPlaceholderText(/肉怎么去腥/)
  fireEvent.change(input, { target: { value: '豆腐买多了怎么存' } })
  fireEvent.click(screen.getByText('问'))

  expect(await screen.findByText('豆腐买多了怎么存')).toBeTruthy()
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toEqual({ messages: [{ role: 'user', content: '豆腐买多了怎么存' }] })
})

it('中途关掉抽屉不发"出错了"（用户自己走的，不是失败）', async () => {
  mockStream({ hang: true, replies: [] })
  const onClose = vi.fn()
  const { rerender } = renderSheet(<AiChatSheet visible onClose={onClose} />)
  const toastError = vi.spyOn(toast, 'error')

  const input = await screen.findByPlaceholderText(/肉怎么去腥/)
  fireEvent.change(input, { target: { value: '豆腐买多了怎么存' } })
  fireEvent.click(screen.getByText('问'))
  expect(await screen.findByText('在翻菜谱小书…')).toBeTruthy()

  // 抽屉关掉：组件收到 visible=false，去中断上游
  rerender(
    <QueryClientProvider client={clients[clients.length - 1]}>
      <MemoryRouter>
        <AiChatSheet visible={false} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  // 先等一个**正面的**事件（等待提示消失 = abort 已被处理），再断言没弹错。
  // 不能一上来就断言"没弹过错"：那个断言在第一个 tick 就成立，等于没验（反证时发现过）
  await waitFor(() => expect(screen.queryByText(/在翻菜谱小书/)).toBeNull())
  expect(toastError).not.toHaveBeenCalled()
  // 也不该留下一个空气泡（撤掉没长出字的那格）。
  // 用 class 数：空的 div 没有文本节点，按文本查是查不出来的（反证时才发现这个断言形同虚设）
  expect(document.querySelectorAll('.ai__turn--assistant')).toHaveLength(0)
})

it('问答边收边显示（流式），再问时把上文一起带上', async () => {
  const { sent } = mockStream({ replies: ['回答', '第1问'] })
  renderSheet(<AiChatSheet visible onClose={() => {}} />)

  const input = await screen.findByPlaceholderText(/肉怎么去腥/)
  fireEvent.change(input, { target: { value: '豆腐买多了怎么存' } })
  fireEvent.click(screen.getByText('问'))
  // 两段分开到、最后拼成完整一句——这正是流式要的效果（不是一次性出现）
  expect(await screen.findByText('回答第1问')).toBeTruthy()

  fireEvent.change(input, { target: { value: '那冻起来行吗' } })
  const sendBtn = screen.getByText('问') as HTMLButtonElement
  await waitFor(() => expect(sendBtn.disabled).toBe(false))
  fireEvent.click(sendBtn)

  // 第二问必须带上第一轮（user + assistant），否则模型不知道"那"指什么
  await waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toEqual({
    messages: [
      { role: 'user', content: '豆腐买多了怎么存' },
      { role: 'assistant', content: '回答第1问' },
      { role: 'user', content: '那冻起来行吗' },
    ],
  })
})
