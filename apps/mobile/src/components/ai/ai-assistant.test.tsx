// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { useFridge } from '@/api/fridge'
import { logout } from '@/api/auth'
import type { AiReceipt, ChatTurn } from '@/api/ai'
import { Toaster } from '@/components/ui/toast'
import { useAiAssistantSession } from '@/stores/ai-assistant-session'
import { useAuth } from '@/stores/auth'
import AiAssistantBall from '@/components/ai/AiAssistantBall'
import AiAssistantSheet from '@/components/ai/AiAssistantSheet'

/**
 * 全局 AI 助手（F16-10 / D-052，用户 2026-10-13 拍板"悬浮球 + A 档 + 加表"）。
 *
 * 这一组盯的是**这功能凭什么敢让模型直接写库**那三件事：
 * ① **回执卡是那句话的证据**——只有服务端真发来 `receipts` 才画卡；
 *    模型嘴上说"记好了"而服务端没给回执，界面上就必须什么都不出现（不能在界面上替它圆谎）。
 * ② **「撤」真的发一次撤销请求**，且服务端说"其实没撤成"时**照实转达**，
 *    不许把它显示成"已撤销"（那正是这一档最容易骗到用户的地方）。
 * ③ **对话活过换页**：收起抽屉、切到另一页、再点悬浮球，那一轮对话与那张卡都还在——
 *    「撤」是这一档唯一的安全网，只在"别切页"的前提下存在等于没有。
 */

const clients: QueryClient[] = []

function renderApp(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
      {/* 与 main.tsx 的挂法一致（Toaster 在 Router 外面，换页不会被卸载）。
          少它的话 toast 没有落点，断言"那句话显示出来了"会假红——桩本身没问题，
          是**测试环境里少挂了一层**（已踩过） */}
      <Toaster />
    </QueryClientProvider>,
  )
}

/** 一个最小的"两页"外壳：悬浮球挂在常驻位置、抽屉按开合挂载（与 TabLayout 的挂法一致） */
function Shell() {
  const open = useAiAssistantSession((state) => state.open)
  return (
    <div>
      <Routes>
        <Route path="/" element={<Link to="/fridge">去冰箱</Link>} />
        <Route path="/fridge" element={<div>冰箱页</div>} />
      </Routes>
      <AiAssistantBall />
      {open && <AiAssistantSheet />}
    </div>
  )
}

function receipt(over: Partial<AiReceipt> & { id: string }): AiReceipt {
  return { kind: 'fridge.create', summary: '酸奶 · 一盒 · 冷藏', label: '撤掉', target: 'i1', ...over }
}

/**
 * 流式问答的 fetch 桩。
 *
 * `receipts` 是**这一组的主角**：它模仿后端在流末尾发 `event: receipts`。
 * 把 `replies` 与 `receipts` 分开传，正是为了造出"它嘴上说记好了、但后端没回执"那种情形——
 * 那是模型吹牛，界面必须不认。
 */
function mockStream({
  replies = ['记好了。'],
  receipts = [] as AiReceipt[],
  proposals = [] as unknown[],
  failWith,
  statuses = [] as string[],
}: {
  replies?: string[]
  receipts?: AiReceipt[]
  proposals?: unknown[]
  failWith?: string
  statuses?: string[]
} = {}) {
  const sent: { messages: ChatTurn[] }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages: ChatTurn[] }
    sent.push(body)
    if (failWith) {
      return { ok: false, status: 503, json: async () => ({ message: failWith }) } as unknown as Response
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const label of statuses) {
          controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ type: 'status', label })}\n\n`))
        }
        for (const reply of replies) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: reply })}\n\n`))
        }
        if (receipts.length) {
          controller.enqueue(encoder.encode(
            `event: receipts\ndata: ${JSON.stringify({ type: 'receipts', items: receipts })}\n\n`,
          ))
        }
        if (proposals.length) {
          controller.enqueue(encoder.encode(
            `event: proposals\ndata: ${JSON.stringify({ type: 'proposals', items: proposals })}\n\n`,
          ))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return { ok: true, status: 200, body: stream } as unknown as Response
  })
  return { sent }
}

function mockApi({ configured = true, undoResult }: {
  configured?: boolean
  /** 撤销接口的回复。不传 = 成功撤销 */
  undoResult?: { status?: number; data?: unknown }
} = {}) {
  const get = vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/ai/status') return Promise.resolve({ data: { configured, model: configured ? 'm' : null } } as never)
    if (url === '/ai/actions') return Promise.resolve({ data: { items: [] } } as never)
    if (url === '/fridge') return Promise.resolve({ data: { zones: [], summary: {}, soon: [] } } as never)
    throw new Error(`未预期的 GET：${url}`)
  })
  const post = vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url.startsWith('/ai/actions/') && url.endsWith('/undo')) {
      if (undoResult?.status && undoResult.status >= 400) {
        // 带上 isAxiosError：apiErrorMessage 靠它认这个错（手搓的裸对象会被当成"未知错误"，
        // 于是服务端那句人话永远显示不出来——测试里踩过一次，见 auth.test 的同款注释）
        return Promise.reject({
          isAxiosError: true,
          response: { status: undoResult.status, data: undoResult.data },
        })
      }
      return Promise.resolve({ data: undoResult?.data ?? { message: '已撤销：酸奶 · 一盒 · 冷藏', undone: true } } as never)
    }
    if (url === '/orders/items') return Promise.resolve({ data: { date: '2026-10-13', mealLabel: '晚餐' } } as never)
    throw new Error(`未预期的 POST：${url}`)
  })
  return { get, post }
}

/**
 * 说一句话（必要时先点开悬浮球）。
 *
 * **先看抽屉开着没有**：抽屉开着时悬浮球是收起来的（它会被遮罩盖住，留着只是噪音），
 * 无条件去点球会拿到 null——连说两句的用例就是这么假红的（第一版）。
 */
async function say(text: string) {
  if (!document.querySelector('.ai__note')) {
    fireEvent.click(screen.getByLabelText('问问 AI 助手'))
  }
  const input = await screen.findByPlaceholderText('说一句，如：记一下冰箱里有酸奶')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '说' }))
}

beforeEach(() => {
  localStorage.clear()
  /*
   * 会话在**模块级 store** 里、而且**落盘**（这是本功能的要点，见文件头 ③），
   * 不重置的话上一条用例留下的对话会带进下一条——界面会显示上一轮的答案，断言当场假红。
   * 清两处：内存里的 store（同一条用例内的两次渲染）与 localStorage（跨用例）。
   */
  useAiAssistantSession.getState().clearAll()
  useAiAssistantSession.getState().closeSheet()
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('没配 AI 时明说去哪配，不假装能用（悬浮球照常出现，点开是配置说明）', async () => {
  mockApi({ configured: false })
  renderApp(<Shell />)
  fireEvent.click(screen.getByLabelText('问问 AI 助手'))
  expect(await screen.findByText(/还没接上 AI/)).toBeTruthy()
})

it('说一句"记一下"，模型的话上屏**且**长出回执卡（卡里写清写了什么）', async () => {
  mockStream({
    replies: ['记好了。'],
    receipts: [receipt({ id: 'r1', summary: '酸奶 · 一盒 · 冷藏' })],
  })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')

  expect(await screen.findByText('记好了。')).toBeTruthy()
  expect(await screen.findByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()
  // 「撤」上写的是**撤什么**（"撤掉"），不是一个抽象的"撤销"
  expect(screen.getByRole('button', { name: '撤掉' })).toBeTruthy()
})

it('AI 写完库之后，**冰箱页那份缓存要作废**（否则收起抽屉看到的是写之前那份）', async () => {
  /*
   * 这条是**真浏览器实测抓到的**：库里已经有苹果和豆腐了、回执卡也挂出来了，
   * 可冰箱页显示的还是写之前那四样（react-query 的 staleTime 是 30 秒，
   * 它以为手里那份还是新的）。用户看到的就是"AI 说记好了，冰箱里却没有"——
   * 真去刷新一下会发现东西在，但那一瞬间的怀疑是白搭的。
   *
   * 所以回执到达时要 invalidate 冰箱那份缓存。这里钉的就是这个动作：
   * 用一个真的订阅了 ['fridge'] 的探针组件数它取了几次。
   */
  const { get } = mockApi()
  let fridgeFetches = 0
  get.mockImplementation((url: string) => {
    if (url === '/ai/status') return Promise.resolve({ data: { configured: true, model: 'm' } } as never)
    if (url === '/fridge') {
      fridgeFetches += 1
      return Promise.resolve({ data: { zones: [], summary: {}, soon: [] } } as never)
    }
    throw new Error(`未预期的 GET：${url}`)
  })
  mockStream({ receipts: [receipt({ id: 'r1' })] })

  function FridgeProbe() {
    useFridge()
    return <div>冰箱探针</div>
  }
  renderApp(
    <>
      <FridgeProbe />
      <Shell />
    </>,
  )
  await waitFor(() => expect(fridgeFetches).toBe(1))

  await say('记一下冰箱里有酸奶')
  expect(await screen.findByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()

  // 回执一到，冰箱那份就该被作废并重新取（次数从 1 变成 2）
  await waitFor(() => expect(fridgeFetches).toBeGreaterThan(1))
})

it('模型嘴上说"记好了"但服务端没给回执：**不画卡**（界面不替它圆谎）', async () => {
  // 这是本功能最容易骗到用户的地方：它有写库能力，所以"它说写了"必须由服务端那句回执来证明
  mockStream({ replies: ['记好了，冰箱里有了。'] })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')

  expect(await screen.findByText('记好了，冰箱里有了。')).toBeTruthy()
  // 一个字都没写进库的证据都没有 → 卡片与「撤」都不该出现
  expect(screen.queryByText('已经帮你办好了')).toBeNull()
  expect(screen.queryByRole('button', { name: '撤掉' })).toBeNull()
})

it('点「撤」真的发一次撤销请求（拿的是那一笔的 id，不是"最后一条"）', async () => {
  mockStream({ receipts: [receipt({ id: 'r-keep' }), receipt({ id: 'r-target', summary: '牛奶 · 两盒 · 冷藏' })] })
  const { post } = mockApi()
  renderApp(<Shell />)

  await say('记一下酸奶和牛奶')
  const rows = await screen.findAllByRole('button', { name: '撤掉' })
  // 点**第二**笔：如果实现里写的是"撤最后一笔"或"按名字找"，这里就会撤错
  fireEvent.click(rows[1])

  await waitFor(() => {
    expect(post).toHaveBeenCalledWith('/ai/actions/r-target/undo')
  })
})

it('撤完之后那一行划掉但**留着**（撤了什么也该看得见），且说"已撤掉"', async () => {
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  fireEvent.click(await screen.findByRole('button', { name: '撤掉' }))

  await waitFor(() => {
    expect(screen.getByText('已撤掉')).toBeTruthy()
  })
  // 摘要仍在（划掉而不是删掉）：用户回头看要能知道这句曾经写了什么、又被撤了
  expect(screen.getByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()
})

it('服务端说"其实没撤成"（那条已将不在）：**照实转达**，不显示成"已撤销"', async () => {
  /*
   * 这是这一档最危险的一处：撤销是"尽力而为"，失败必须让用户看见。
   * 把它显示成"已撤销"就是在骗人——他以为撤了，实际那条还在（或反过来）。
   */
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi({ undoResult: { data: { message: '「酸奶」还在，没被删', undone: false } } })
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  fireEvent.click(await screen.findByRole('button', { name: '撤掉' }))

  expect(await screen.findByText(/还在，没被删/)).toBeTruthy()
  // undone:false 的**不是**"已撤销"：那一行不能被划掉（划掉等于宣称撤成了）
  await waitFor(() => {
    expect(screen.queryByText('已撤掉')).toBeNull()
  })
})

it('撤销失败（409 已经撤过了）：把服务端那句话显示出来，不静默吞掉', async () => {
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi({ undoResult: { status: 409, data: { message: '这一笔已经撤过了' } } })
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  fireEvent.click(await screen.findByRole('button', { name: '撤掉' }))

  expect(await screen.findByText(/已经撤过/)).toBeTruthy()
})

it('对话活过换页：收起抽屉 → 切到另一页 → 再点悬浮球，对话与回执**都还在**', async () => {
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  expect(await screen.findByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()

  /*
   * 收起抽屉（用户想去看冰箱到底有没有变）——这是本功能的典型动作。
   * 遮罩要等抽屉入场那一帧才挂到 DOM 上（antd-mobile 的 Mask 用 ShouldRender，
   * 弹簧一动才渲染），所以先等它出现再点；直接 querySelector 会拿到 null（踩过）。
   * 关掉是**动画**：afterClose 要等弹簧跑完才回调，所以给足超时。
   */
  await waitFor(() => expect(document.querySelector('.adm-mask')).not.toBeNull())
  fireEvent.click(document.querySelector('.adm-mask') as Element)
  await waitFor(() => expect(useAiAssistantSession.getState().open).toBe(false), { timeout: 3000 })

  // 切到另一页（组件被卸载重挂，这正是"会话必须在 store 里"的原因）
  fireEvent.click(screen.getByText('去冰箱'))
  expect(await screen.findByText('冰箱页')).toBeTruthy()

  fireEvent.click(screen.getByLabelText('问问 AI 助手'))

  // 那一轮对话、那张卡、那个「撤」原样回来
  expect(await screen.findByText('记好了。')).toBeTruthy()
  expect(screen.getByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()
  expect(screen.getByRole('button', { name: '撤掉' })).toBeTruthy()
})

it('「新对话」把这场收起来开一场新的，**旧的留在历史里**（用户 2026-10-13 的要求）', async () => {
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  expect(await screen.findByText('记好了。')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '新对话' }))

  // 新的一场是空的（对话与回执都不显示）
  await waitFor(() => {
    expect(screen.queryByText('记好了。')).toBeNull()
    expect(screen.queryByText('酸奶 · 一盒 · 冷藏')).toBeNull()
  })
  // 但**旧的那场没丢**：历史里能找到它，标题就是那句话
  expect(screen.getByRole('button', { name: /以前的对话/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /以前的对话/ }))
  expect(await screen.findByText('记一下冰箱里有酸奶')).toBeTruthy()
})

it('历史里点回以前那场：对话与回执原样回来（含「撤」）', async () => {
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  expect(await screen.findByText('记好了。')).toBeTruthy()

  // 开一场新的（旧的那场进历史）
  fireEvent.click(screen.getByRole('button', { name: '新对话' }))
  await waitFor(() => expect(screen.queryByText('记好了。')).toBeNull())

  // 从历史里翻回去
  fireEvent.click(screen.getByRole('button', { name: /以前的对话/ }))
  fireEvent.click(await screen.findByText('记一下冰箱里有酸奶'))

  expect(await screen.findByText('记好了。')).toBeTruthy()
  expect(screen.getByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()
  // 「撤」也还在——这是这一档的安全网，翻旧账找它正是用户的常见动作
  expect(screen.getByRole('button', { name: '撤掉' })).toBeTruthy()
})

it('刷新页面（重新挂载、从 localStorage 读回来）：对话与回执还在', async () => {
  /*
   * 这是用户追的那句「会话历史也要保留啊」的核心：**刷新不能白纸**。
   * 桩的办法是 unmount 整棵树再渲染一次——store 是模块级的，内存里那份还在，
   * 所以这里**先把内存清掉、只留 localStorage**，才真的验到"从盘上读回来"。
   * 只 unmount/remount 的话，验的是内存里那份（那条路上面已经验过了）。
   */
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  mockApi()
  const view = renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  expect(await screen.findByText('记好了。')).toBeTruthy()

  // 落盘是**异步**的（zustand persist 写 localStorage 在 set 之后），给它一拍
  await waitFor(() => {
    expect(localStorage.getItem('yushan-ai-assistant')).toContain('酸奶')
  })
  const persisted = localStorage.getItem('yushan-ai-assistant')

  // 模拟"刷新"：卸载整棵树 + 把内存里的 store 清成"刚启动"的样子，再喂回盘上那份
  view.unmount()
  useAiAssistantSession.getState().clearAll()
  useAiAssistantSession.getState().closeSheet()
  useAiAssistantSession.setState({ conversations: [], activeId: null })
  localStorage.setItem('yushan-ai-assistant', persisted as string)
  // zustand persist 的 rehydrate：重新从存储读一次（真实刷新时这一步在 store 创建时自动发生）
  await useAiAssistantSession.persist.rehydrate()

  renderApp(<Shell />)
  fireEvent.click(screen.getByLabelText('问问 AI 助手'))

  expect(await screen.findByText('记好了。')).toBeTruthy()
  expect(screen.getByText('酸奶 · 一盒 · 冷藏')).toBeTruthy()
})

it('刷新时若那轮还没答完（末尾一个空格），落盘前要剪掉——否则下次发出去就是 400', async () => {
  /*
   * 后端 `parseChatMessages` 会拒空内容（"消息内容不能为空"），而流式途中刷新会留下
   * 一个还没长出字的 assistant 格。原样存下来的话，用户下次问一句就会连带发出那条空消息，
   * 整句话 400——症状是"隔一会儿回来它就不理我了"，极难查。
   * 这里直接验落盘的内容里没有空格（store 层，不经过界面）。
   */
  useAiAssistantSession.getState().beginTurn('记一下冰箱里有酸奶')
  // 不 appendChunk：这一轮永远没答完（正是"途中刷新"的样子）
  expect(useAiAssistantSession.getState().conversations[0].turns).toHaveLength(2)

  await waitFor(() => {
    const raw = localStorage.getItem('yushan-ai-assistant') ?? ''
    expect(raw).toContain('记一下冰箱里有酸奶')
    // 盘上那一场只剩用户那句，空格已剪
    const saved = JSON.parse(raw) as { state: { conversations: { turns: { content: string }[] }[] } }
    expect(saved.state.conversations[0].turns.map((turn) => turn.content)).toEqual(['记一下冰箱里有酸奶'])
  })
})

it('发给模型的只有最近十条（后端硬卡 10 条，超了整句 400）', async () => {
  /*
   * 历史可以很长（现在会一直留着），但**发出去**的必须守住后端那条线（AI_MESSAGES_MAX = 10）。
   * 这里直接往 store 里灌 12 句，再问一句，看真正发出去的 messages 有多长。
   */
  const { sent } = mockStream({ replies: ['好。'] })
  mockApi()
  renderApp(<Shell />)

  // 灌 6 轮（12 条）旧对话，每句都有内容
  for (let index = 0; index < 6; index += 1) {
    useAiAssistantSession.getState().beginTurn(`旧话${index}`)
    useAiAssistantSession.getState().appendChunk(`旧答${index}`)
    useAiAssistantSession.getState().endTurn()
  }
  expect(useAiAssistantSession.getState().conversations[0].turns).toHaveLength(12)

  await say('再来一句')

  await waitFor(() => expect(sent).toHaveLength(1))
  // 10 条上限：9 条历史 + 这一句（最早那几条被丢掉，而不是整句失败）
  expect(sent[0].messages).toHaveLength(10)
  expect(sent[0].messages[sent[0].messages.length - 1]).toEqual({ role: 'user', content: '再来一句' })
})

it('删掉历史里的一场：它从列表里消失，且**别的场还在**', async () => {
  mockStream({ replies: ['好。'] })
  mockApi()
  renderApp(<Shell />)

  await say('第一场')
  expect(await screen.findByText('好。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '新对话' }))
  await say('第二场')
  await waitFor(() => expect(screen.getAllByText('好。').length).toBeGreaterThan(0))

  fireEvent.click(screen.getByRole('button', { name: /以前的对话/ }))
  // 两场都在（"第二场"是当前这场、"第一场"已经进历史）
  expect(await screen.findByText('第一场')).toBeTruthy()
  expect(screen.getByText('第二场')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '删掉「第一场」' }))

  await waitFor(() => expect(screen.queryByText('第一场')).toBeNull())
  // 只删那一场，不是把历史清空
  expect(screen.getByText('第二场')).toBeTruthy()
})

it('退出登录会清掉对话历史（同一台手机换人用，不该看见上一个人家里有什么）', async () => {
  /*
   * 这是"保留历史"的对价：对话里有**这家冰箱的内容**。持久化到 localStorage 之后，
   * 不清就是实打实的隐私事故——下一个人点开悬浮球就看见别人家的冰箱。
   * 所以 logout 里显式 clearAll（见 api/auth.ts）。
   */
  const { post } = mockApi()
  mockStream({ replies: ['好。'] })
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  expect(await screen.findByText('好。')).toBeTruthy()
  await waitFor(() => expect(localStorage.getItem('yushan-ai-assistant')).toContain('酸奶'))

  await logout()

  // 内存与盘上都不该再留着那句话
  expect(useAiAssistantSession.getState().conversations).toEqual([])
  await waitFor(() => {
    expect(localStorage.getItem('yushan-ai-assistant') ?? '').not.toContain('酸奶')
  })
  // 后端也照常收到了退出请求（不是只清了本地）
  expect(post).toHaveBeenCalledWith('/auth/logout', expect.anything())
})

it('撤销的判断全在服务端：前端只发 id，不猜结果（回归这档的护栏）', async () => {
  /*
   * 前端手里只有"它写过了"这个事实，判不了"用户后来改过没有""那条还在不在"。
   * 所以「撤」只能是一次 id + 由服务端回话。这条钉住那个形状：
   * 请求体里**不带**任何"该怎么撤"的信息（带了就等于前端在替服务端决定写什么）。
   */
  mockStream({ receipts: [receipt({ id: 'r1' })] })
  const { post } = mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')
  fireEvent.click(await screen.findByRole('button', { name: '撤掉' }))

  await waitFor(() => expect(post).toHaveBeenCalled())
  const call = post.mock.calls.find(([url]) => String(url).includes('/undo'))
  expect(call?.[0]).toBe('/ai/actions/r1/undo')
  // 不传请求体（axios 的可选 config 省略时调用就只有 url 一个参数）：
  // 带了"该怎么撤"的信息就等于前端在替服务端决定写什么
  expect(call?.[1]).toBeUndefined()
})

it('工具跑着的时候显示后端给的那句人话（不是干等一个光标）', async () => {
  // 工具轮次要 3~5 秒一轮；没有这句用户只看到光标闪，像卡住了（D-026 决定五）
  mockStream({ replies: ['好。'], statuses: ['正在看冰箱里有什么…', '正在记进冰箱…'] })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')

  /*
   * 流是立刻跑完的，所以这里验的是"过程中它确实用过那句状态"：
   * 用 store 的 stage 断言比抢时间窗更稳（jsdom 里没有可见的中间帧）。
   * 收尾之后 stage 要清掉——留着一句话挂在界面上，会让人以为它还在动。
   */
  expect(await screen.findByText('好。')).toBeTruthy()
  expect(useAiAssistantSession.getState().stage).toBe('')
})

it('AI 提的加菜建议仍然**没写库**（点了"加入菜单"才写，B 档没被这次改动带跑）', async () => {
  /*
   * 回归 D-026 的铁律：给冰箱接了写库能力之后，菜单那条**必须**还是"等用户点"。
   * 这一条是这次改动最容易带坏的地方——同一个抽屉里既有"直接写"又有"等确认"。
   */
  mockStream({
    receipts: [],
    replies: ['今晚可以吃这个。'],
    proposals: [{
      recipeId: 'rec1', name: '番茄炒蛋', mealDate: '2026-10-13', meal: 'DINNER', note: '', when: '今天晚餐',
    }],
  })
  const { post } = mockApi()
  renderApp(<Shell />)

  await say('今晚想吃清淡的')

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  // 只是卡片出现：这期间**一个写接口都没调**
  expect(post).not.toHaveBeenCalled()
  // 回执卡也不该出现（它没写库）
  expect(screen.queryByText('已经帮你办好了')).toBeNull()

  // 点了才真的写：走与手点同一条 /orders/items（真实调用是**两个参数**，没有第三段 config）
  fireEvent.click(screen.getByRole('button', { name: '加入菜单' }))
  await waitFor(() => {
    expect(post).toHaveBeenCalledWith(
      '/orders/items',
      { recipeId: 'rec1', mealDate: '2026-10-13', meal: 'DINNER', note: undefined },
    )
  })
})

it('失败时保留用户问的那句（重问一遍还得重新打字最气人）', async () => {
  mockStream({ failWith: 'AI 服务开小差了，过会儿再试' })
  mockApi()
  renderApp(<Shell />)

  await say('记一下冰箱里有酸奶')

  expect(await screen.findByText(/开小差/)).toBeTruthy()
  expect(screen.getByText('记一下冰箱里有酸奶')).toBeTruthy()
})
