// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import * as checkins from '@/api/checkins'
import { useAiAssistantSession } from '@/stores/ai-assistant-session'
import { useAuth } from '@/stores/auth'
import AiAssistantSheet from '@/components/ai/AiAssistantSheet'
import { Toaster } from '@/components/ui/toast'

/**
 * AI 助手的图片附件（F16-05；用户 2026-10-13：「ai助手那里也需要添加附件上传功能，
 * 会话中也要能展示图片，历史会话图片也得展示，不能丢失」+「需要能拍照或者从相册选两种」）。
 *
 * 这一组盯住四件事——每一件错了都是"用户看得见、但看不出为什么"的那种：
 * ① **两个来源入口分别对应相机与相册**（只有一个 `accept="image/*"` 时，有些机型
 *    永远进不去相机；而带了 `capture` 就只剩相机，所以必须两控件两入口）；
 * ② **上传完的图挂在待发区**，且**只有图、没有字也能发**（拍张照直接发是最自然的用法）；
 * ③ **图片 id 随消息发出去**（服务端凭它去私有桶取字节）——不然模型根本看不到图，
 *    却会照着文字回一句听起来很靠谱的话；
 * ④ **翻历史/刷新之后图还在**（对话整体落盘，图片以 id 形式跟着存），
 *    这是用户明确提过的那条"不能丢失"。
 *
 * 图片字节那条路（`GET /ai/attachments/:id/photo`）要过登录令牌，所以组件用的是
 * **带 Authorization 的 fetch** 取 blob——不是 axios。下面用 fetch 桩把两条路分开：
 * SSE 流一段、取图一段。
 */

const clients: QueryClient[] = []

/**
 * 画出抽屉。
 *
 * ⚠️ 两件必须做的准备，少了它们这条测试会**假红**（本次踩过）：
 * ① 抽屉是"关着就不画内容"的（`BottomSheet` 的 visible 来自 store）——先 `openSheet()`，
 *    否则拿到的是一个空 body，报错是"找不到标签"（看起来像组件写错了）；
 * ② 挂载时会去取 `/ai/status` 与 `/ai/actions`（未配置时整个面板换成一句配置说明），
 *    这两个 GET 不桩就是真的网络请求。
 */
function renderSheet(node: React.ReactNode = <AiAssistantSheet />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  useAiAssistantSession.getState().openSheet()
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

/** 一像素的假图：内容不重要，这条路上没有真的解码 */
const PHOTO = 'data:image/jpeg;base64,QUJD'

/**
 * 上传接口的桩。返回的 id 由调用方定，用来验证"待发区里的那张"与"发出去的 id"是同一张。
 *
 * 只桩 `axios.post`，不桩用户的手势：选图那一步走的是真 `fireEvent.change`。
 */
/** 抽屉挂载要用的两个 GET（已配置 / 没有可撤的回执） */
function mockStatus() {
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/ai/status') return Promise.resolve({ data: { configured: true, model: 'm' } } as never)
    if (url === '/ai/actions') return Promise.resolve({ data: { items: [] } } as never)
    throw new Error(`未预期的 GET：${url}`)
  })
}

function mockUpload(ids: string[] = ['att-1']) {
  mockStatus()
  const post = vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/ai/attachments') {
      const id = ids.shift() ?? 'att-x'
      return Promise.resolve({ data: { id, mimeType: 'image/jpeg' } } as never)
    }
    throw new Error(`未预期的 POST：${url}`)
  })
  return { post }
}

/**
 * fetch 桩：一条给 SSE 的流、一条给取图。
 *
 * `photoStatus` 用来造"这张图已经被清理了"那种情形（附件有留存上限，
 * 很旧的对话里那张图可能不在私有桶了）——那时候要显示一句人话而不是破图。
 */
function mockFetch({ reply = '好。', photoStatus = 200 }: { reply?: string; photoStatus?: number } = {}) {
  const sent: { messages: unknown }[] = []
  const photoUrls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    if (target.includes('/ai/attachments/')) {
      photoUrls.push(target)
      if (photoStatus >= 400) return { ok: false, status: photoStatus } as unknown as Response
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(['img'], { type: 'image/jpeg' }),
      } as unknown as Response
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as { messages: unknown }
    sent.push(body)
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: reply })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return { ok: true, status: 200, body: stream } as unknown as Response
  })
  return { sent, photoUrls }
}

/** 选一张图（走相册那个控件：与"拍一张"只差 `capture`，回调同一条） */
function pickPhoto(id = 'ai-attachment') {
  const input = document.getElementById(`${id}-album`) as HTMLInputElement
  const file = new File(['x'], 'dish.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  localStorage.clear()
  useAiAssistantSession.getState().clearAll()
  useAiAssistantSession.getState().closeSheet()
  useAiAssistantSession.setState({ pending: false, stage: '' })
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
  // 缩图在 jsdom 里跑不动（没有 canvas 解码），这里直接给一个"缩好的"结果：
  // 这条测试验的是**上传与展示**，缩图本身由 RecipeFormPage 那组测试盯着
  vi.spyOn(checkins, 'shrinkImage').mockResolvedValue(PHOTO)
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('点「＋」露出两个来源：拍一张（相机）/ 从相册选（相册），再点一次收起', async () => {
  mockUpload()
  mockFetch()
  renderSheet()

  // 一开始不露：那两行是回答"这张图从哪来"，没打算加图时不占地方
  expect(document.querySelector('.ai__sources')).toBeNull()

  fireEvent.click(screen.getByLabelText('加一张图'))
  const sources = document.querySelector('.ai__sources') as HTMLElement
  expect(sources).toBeTruthy()

  const camera = document.getElementById('ai-attachment-camera') as HTMLInputElement
  const album = document.getElementById('ai-attachment-album') as HTMLInputElement
  // 两颗必须各指一个控件：合并成一个的话，"直接开相机"就没了（部分机型不给相机入口）
  expect(camera.getAttribute('capture')).toBe('environment')
  expect(album.getAttribute('capture')).toBeNull()
  // label 的 for 落在对的控件上（点哪颗开哪个）
  expect(screen.getByText('拍一张').getAttribute('for')).toBe(camera.id)
  expect(screen.getByText('从相册选').getAttribute('for')).toBe(album.id)

  fireEvent.click(screen.getByLabelText('收起图片来源'))
  expect(document.querySelector('.ai__sources')).toBeNull()
})

it('选一张图：先缩再传，缩好的传上去（不是原图），然后挂进待发区', async () => {
  const { post } = mockUpload(['att-7'])
  mockFetch()
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()

  await waitFor(() => expect(post).toHaveBeenCalledWith('/ai/attachments', { image: PHOTO }))
  // 待发区里出现一张（服务端已收下，等着发出去）
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  // 选完来源那两行自己收起：下一步是"配一句话或者直接发"，不是再选一次来源
  expect(document.querySelector('.ai__sources')).toBeNull()
})

it('**只有图、没有字也能发**，且图片 id 跟着这条消息传出去', async () => {
  const { post } = mockUpload(['att-9'])
  const { sent } = mockFetch({ reply: '我看到了。' })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())

  // 一个字都不打，直接点「说」
  fireEvent.click(screen.getByRole('button', { name: '说' }))

  await waitFor(() => expect(sent).toHaveLength(1))
  const messages = sent[0].messages as { role: string; content: string; attachments?: string[] }[]
  expect(messages).toHaveLength(1)
  expect(messages[0].role).toBe('user')
  // 文字是空的、图带上了：服务端凭这个 id 去私有桶取字节（不带的话模型看不到图）
  expect(messages[0].content).toBe('')
  expect(messages[0].attachments).toEqual(['att-9'])
  // 上传只发生一次（发消息不该再传一遍）
  expect(post).toHaveBeenCalledTimes(1)
})

it('发完那一轮：图显示在对话里（带令牌取字节，不是直接塞进 <img src>）', async () => {
  mockUpload(['att-3'])
  const { photoUrls } = mockFetch({ reply: '看到了。' })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))

  // 对话流里的那张图（待发区清空了，这张是消息里的）
  await waitFor(() => expect(document.querySelector('.ai__turn-photos .ai__photo')).toBeTruthy())
  expect(document.querySelectorAll('.ai__pending-photo')).toHaveLength(0)
  // 取图走的是我们那条带令牌的接口地址
  expect(photoUrls.some((url) => url.includes('/ai/attachments/att-3/photo'))).toBe(true)
})

it('刷新之后（从盘上读回来）：那一轮的文字与图都还在', async () => {
  mockUpload(['att-5'])
  const { photoUrls } = mockFetch({ reply: '看到了。' })
  const view = renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))
  await waitFor(() => expect(screen.getByText('看到了。')).toBeTruthy())

  // 等落盘（zustand persist 写在 set 之后，异步一拍）
  await waitFor(() => {
    expect(localStorage.getItem('yushan-ai-assistant') ?? '').toContain('att-5')
  })

  // 模拟刷新：卸载 + 把内存清成"刚启动" + 从盘上读回来
  view.unmount()
  const saved = localStorage.getItem('yushan-ai-assistant') as string
  useAiAssistantSession.getState().clearAll()
  useAiAssistantSession.setState({ conversations: [], activeId: null })
  localStorage.setItem('yushan-ai-assistant', saved)
  await useAiAssistantSession.persist.rehydrate()

  const before = photoUrls.length
  renderSheet()

  await waitFor(() => expect(document.querySelector('.ai__turn-photos .ai__photo')).toBeTruthy())
  // 图片的字节**不落盘**（那是几 MB 的 base64），落盘的是 id；读回来时按 id 再取一次
  expect(photoUrls.length).toBeGreaterThan(before)
  expect(photoUrls[photoUrls.length - 1]).toContain('/ai/attachments/att-5/photo')
})

it('图被清理掉了就说一句人话（附件有留存上限，很旧的对话里那张图可能已经不在）', async () => {
  mockUpload(['att-old'])
  mockFetch({ reply: '看到了。', photoStatus: 404 })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))

  // 破图比一句话糟得多：用户会以为是网络问题，反复下拉刷新
  await waitFor(() => expect(screen.getAllByText('这张图已清理').length).toBeGreaterThan(0))
})

it('上传失败如实说，且**不进待发区**（别让用户等到模型回答完才发现它没看图）', async () => {
  mockStatus()
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true,
    response: { status: 413, data: { message: '这张图太大了，换一张小点的' } },
  })
  mockFetch()
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()

  await waitFor(() => expect(screen.getByText('这张图太大了，换一张小点的')).toBeTruthy())
  expect(document.querySelector('.ai__pending-photo')).toBeNull()
})

it('待发区那张可以不要（"不发了"只撤这一张，别的还在）', async () => {
  mockUpload(['att-a', 'att-b'])
  mockFetch()
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelectorAll('.ai__pending-photo')).toHaveLength(1))
  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelectorAll('.ai__pending-photo')).toHaveLength(2))

  fireEvent.click(screen.getAllByLabelText('不发了')[0])

  // 只撤掉那一张
  await waitFor(() => expect(document.querySelectorAll('.ai__pending-photo')).toHaveLength(1))
})

/*
 * 看大图（用户 2026-10-13：「图片需要能点击全屏看」）。
 *
 * 为什么这条必须在应用内做、且必须测：打包成 App 之后没有"新标签页"——
 * 原先那个 `<a target="_blank">` 点了要么什么都不发生，要么把用户丢出应用。
 * 所以钉两件事：① 缩略图是按钮、点开有全屏层；② 关得掉（点哪儿都关）。
 */
it('点缩略图全屏看大图，再点一下关掉（应用内，不是开新标签）', async () => {
  mockUpload(['att-1'])
  mockFetch({ reply: '看到了。' })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))

  const thumb = await screen.findByLabelText('看第 1 张图的大图')
  // 缩略图是 button：`<a target="_blank">` 在打包后的 App 里点不出任何东西
  expect(thumb.tagName).toBe('BUTTON')
  expect(document.querySelector('.photo-viewer')).toBeNull()

  fireEvent.click(thumb)

  const viewer = await screen.findByRole('dialog', { name: '看大图' })
  expect(viewer).toBeTruthy()
  // 全屏那张用的是**同一个 blob URL**：不重复请求，也不会出现"缩略图有、点开却没有"
  const big = viewer.querySelector('img') as HTMLImageElement
  const small = thumb.querySelector('img') as HTMLImageElement
  expect(big.src).toBe(small.src)
  expect(big.src.startsWith('blob:')).toBe(true)

  // 点哪儿都关（手机上退出全屏的肌肉记忆就是再点一下）
  fireEvent.click(viewer)
  await waitFor(() => expect(document.querySelector('.photo-viewer')).toBeNull())
})

it('大图挂在 body 上（portal）——留在抽屉里会被那个面板的 transform 关成半屏', async () => {
  mockUpload(['att-1'])
  mockFetch({ reply: '看到了。' })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))

  fireEvent.click(await screen.findByLabelText('看第 1 张图的大图'))

  const viewer = document.querySelector('.photo-viewer') as HTMLElement
  // 直接挂在 body 下：祖先里有 transform 时 `position: fixed` 会被困在那一块里
  expect(viewer.parentElement).toBe(document.body)
})

it('看大图时锁住背后滚动，关掉后还回去', async () => {
  mockUpload(['att-1'])
  mockFetch({ reply: '看到了。' })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))
  const thumb = await screen.findByLabelText('看第 1 张图的大图')

  fireEvent.click(thumb)
  // 不锁的话手指滑一下底下的对话跟着滚，关掉回来就不是原来的位置了
  expect(document.body.style.overflow).toBe('hidden')

  fireEvent.click(screen.getByLabelText('关掉大图'))
  await waitFor(() => expect(document.body.style.overflow).toBe(''))
})

it('取不到那张图时给一句话，不给一颗点开是空白的大图', async () => {
  mockUpload(['att-old'])
  mockFetch({ reply: '看到了。', photoStatus: 404 })
  renderSheet()

  fireEvent.click(screen.getByLabelText('加一张图'))
  pickPhoto()
  await waitFor(() => expect(document.querySelector('.ai__pending-photo')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '说' }))

  await waitFor(() => expect(screen.getAllByText('这张图已清理').length).toBeGreaterThan(0))
  expect(screen.queryByLabelText('看第 1 张图的大图')).toBeNull()
})
