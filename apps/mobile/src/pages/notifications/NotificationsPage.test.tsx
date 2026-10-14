// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { useAuth } from '@/stores/auth'
import NotificationsPage from './NotificationsPage'

/**
 * 通知中心（M10 / D-078）。要盯住四件事：
 *
 * ① **去处由后端给**（`item.to`）——前端不按 kind 写第二张跳转表；
 * ② **点开才已读**：点开**那一条**才调 `/notifications/read`（用户 2026-10-15：
 *    「需要**真的已读**时才清」「通知那边点进去才清除通知」）——**打开页面本身不清**；
 * ③ **一键已读**只提交当前列表里那些未读的 id；
 * ④ **那条边界说明必须留着**——没有推送通道时，别人触发的提醒不会有手机弹窗，
 *    不说的话用户会以为提醒坏了（这是这一版最容易被"顺手删掉"的一句话）。
 */

const clients: QueryClient[] = []

const ME = { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' }

/**
 * `/notifications` 是**登录才有**的查询（`enabled: Boolean(token)`），
 * 所以每个用例都要先有会话——不登的话它一个请求都不发，界面永远停在加载态。
 * （这是本项目的固定前提，别处的页面测试同样要 signIn。）
 */
function signIn() {
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/notifications', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/order" element={<div data-testid="order-page" />} />
          {/* 提醒的去处是**那一餐的详情**（不是列表页） */}
          <Route path="/order/:mealKey" element={<div data-testid="order-detail-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const ITEMS = [
  {
    id: 'done:2026-10-15-DINNER',
    kind: 'done',
    title: '今天晚餐做好了',
    body: '你点的 红烧排骨 可以吃了',
    at: '2026-10-15T18:30:00',
    // 去处是那一餐的详情（后端给整条路径，前端不按 kind 拼）
    to: '/order/2026-10-15-DINNER',
    tag: '做好了',
    unread: true,
  },
  {
    id: 'prep:2026-10-15',
    kind: 'prep',
    title: '明天午餐还没安排',
    body: '想吃什么去点两道',
    at: '2026-10-15T00:00:00',
    to: '/prep',
    tag: '备菜',
    unread: false,
  },
]

const PREFS = { mealPlan: true, mealDone: true, expiry: true, prep: true }

function mockBoard(board: unknown, onPost?: (url: string, body: unknown) => void) {
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
    if (url === '/notifications') return Promise.resolve({ data: board } as never)
    throw new Error(`未预期的请求：${url}`)
  }) as never)
  vi.spyOn(apiClient, 'post').mockImplementation(((url: string, body: unknown) => {
    onPost?.(url, body)
    // 后端回的是"标了几条"（`{ read: n }`），不是"看到哪儿了"——已读是逐条记的
    return Promise.resolve({ data: { read: 1 } } as never)
  }) as never)
}

beforeEach(() => {
  localStorage.clear()
  signIn()
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('列出提醒：标题、副标题、小标都来自后端（前端不拼第二份）', async () => {
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS })
  renderPage()

  expect(await screen.findByText('今天晚餐做好了')).toBeTruthy()
  expect(screen.getByText('你点的 红烧排骨 可以吃了')).toBeTruthy()
  expect(screen.getByText('做好了')).toBeTruthy()
  expect(screen.getByText('明天午餐还没安排')).toBeTruthy()
  // 两道之后是开关那一节（四个都在）
  for (const title of ['菜单安排', '饭已做好', '快过期', '该备菜了']) {
    expect(screen.getByText(title)).toBeTruthy()
  }
})

it('点一条提醒按后端给的去处跳（路由表不写在前端）', async () => {
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS })
  renderPage()

  fireEvent.click(await screen.findByText('今天晚餐做好了'))
  // 后端给的 to 是 **`/order/2026-10-15-DINNER`**（那一餐的详情）：点进来直接是这一餐，
  // 而不是列表页让他自己找——前端一个字的跳转表都没有，路径整条来自后端
  expect(await screen.findByTestId('order-detail-page')).toBeTruthy()
})

it('**打开页面本身不清红点**（用户要的是"真的已读"才清）', async () => {
  const calls: string[] = []
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS }, (url) => calls.push(url))
  renderPage()

  await screen.findByText('今天晚餐做好了')
  // 给一点时间让可能的请求发出来——进来这一下**不该**标记任何东西
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(calls).toEqual([])
})

it('点开那一条才标它已读（先标记再跳走，顺序不能反）', async () => {
  const posts: { url: string; body: unknown }[] = []
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS }, (url, body) => posts.push({ url, body }))
  renderPage()

  fireEvent.click(await screen.findByText('今天晚餐做好了'))
  // 标记请求带的是**那一条**的 id，不是"全部"、也不是空
  await waitFor(() => expect(posts).toContainEqual({ url: '/notifications/read', body: { id: 'done:2026-10-15-DINNER' } }))
  // 而且**同时**跳到了它指的地方（不跳的话用户点了没反应）——就是那一餐的详情
  expect(await screen.findByTestId('order-detail-page')).toBeTruthy()
})

it('点已读的那条不再重复提交（省一次没必要的写）', async () => {
  const posts: { url: string; body: unknown }[] = []
  // 第二条（备菜）本来就是已读的
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS }, (url, body) => posts.push({ url, body }))
  renderPage()

  /*
   * 它点进去是 `/prep`，而**这个测试的路由表里没有那一页**——所以跳转之后
   * 页面会变成空白。断言因此不能等"列表还在"，只能等标记动作**没发生**。
   */
  fireEvent.click(await screen.findByText('明天午餐还没安排'))
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(posts.filter((call) => call.url === '/notifications/read')).toEqual([])
})

it('一键已读：只提交当前列表里那些**未读**的 id', async () => {
  const posts: { url: string; body: unknown }[] = []
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS }, (url, body) => posts.push({ url, body }))
  renderPage()

  fireEvent.click(await screen.findByRole('button', { name: '全部已读' }))
  await waitFor(() =>
    expect(posts).toContainEqual({
      url: '/notifications/read-all',
      // 只那一条未读的；已读的那条不该一起去写库
      body: { ids: ['done:2026-10-15-DINNER'] },
    }),
  )
})

it('没有未读时不摆「全部已读」（不画点了没反应的按钮）', async () => {
  mockBoard({ items: ITEMS.map((item) => ({ ...item, unread: false })), unread: 0, unreadByKind: {}, prefs: PREFS })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull()
})

it('空态给出下一步（不是一句"没有消息"了事）', async () => {
  mockBoard({ items: [], unread: 0, unreadByKind: {}, prefs: PREFS })
  renderPage()

  expect(await screen.findByText('眼下没什么要处理的')).toBeTruthy()
  expect(screen.getByText('去看看今天的菜单')).toBeTruthy()
})

it('四个开关反映后端的当前值，改一个只提交那一个', async () => {
  const posts: { url: string; body: unknown }[] = []
  mockBoard(
    { items: [], unread: 0, unreadByKind: {}, prefs: { ...PREFS, prep: false } },
    (url, body) => posts.push({ url, body }),
  )
  renderPage()

  const switches = await screen.findAllByRole('switch')
  // 顺序与 NOTIFICATION_KINDS 一致；「该备菜了」被关掉了
  expect(switches.map((node) => (node as HTMLInputElement).checked)).toEqual([true, true, true, false])

  fireEvent.click(switches[0])
  await waitFor(() => expect(posts).toContainEqual({ url: '/notifications/prefs', body: { mealPlan: false } }))
})

it('那条边界说明留着：说清"什么会弹、什么不会"', async () => {
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  /*
   * 这段话**最容易被顺手删掉**：不解释会显得界面更"干净"。
   * 但没有推送通道时，"别人点了菜/饭已做好"这类远端事件不会有手机弹窗——
   * 不说清，用户就以为提醒坏了。
   *
   * M10 交付二之后它说得更准了：能本机判定的两类（到点做饭、有东西到期）**会弹**，
   * 其余仍然只在应用内。而"手机会弹"这件事**默认开着、界面上不再有开关**
   * （用户 2026-10-14：「这个是默认的，不用设置」「删掉这块配置」），
   * 所以这里只剩一句说明——它必须留着，否则用户不知道什么会弹。
   */
  expect(screen.getByText(/别人点了菜这类「家里刚发生的事」仍然只在应用内看得到/)).toBeTruthy()
  expect(screen.getByText(/关掉这个应用也会响/)).toBeTruthy()
})

it('手机弹窗提醒**默认开着**：界面上没有它的开关（用户要求删掉这块配置）', async () => {
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  expect(screen.queryByRole('switch', { name: '手机弹窗提醒' })).toBeNull()
  // 但说明还在：不说清"哪些会弹、哪些只在应用里"用户会以为提醒坏了
  expect(screen.getByText(/关掉这个应用也会响/)).toBeTruthy()
})

it('到期提醒说的是"到期那天早上"（提前排给系统闹钟，不是只在当天算）', async () => {
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS })
  renderPage()

  // 口径必须写对：写"当天到期时会弹一下"会让人以为只在当天算，
  // 而真正让"关掉也响"成立的是**提前排**（见 local-notify.rules 的 expiryReminders）
  expect(await screen.findByText(/冰箱里有东西到期那天早上/)).toBeTruthy()
})

it('**不给假按钮**：系统权限被拒时只留一句"去设置里打开"（点了没反应的按钮不许有）', async () => {
  mockBoard({ items: ITEMS, unread: 1, unreadByKind: { done: 1 }, prefs: PREFS })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  /*
   * 浏览器里 `permissionState()` 是 'unsupported'，所以这条路径只在真机上出现——
   * 单测里能钉住的是**没有那个开关**、以及说明文案的骨架。
   * 「被拒 → 只给引导、不给按钮」这条纪律见 D-066 与 R-071。
   */
  expect(screen.queryByRole('button', { name: /去打开|开启|打开通知/ })).toBeNull()
})
