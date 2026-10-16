// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { AppNotification, NotificationBoard } from '@/api/notifications'
import { ALL_PREFS_ON, boardFixture, notificationFixture } from '@/api/notifications.testkit'
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
          {/* 事件型那几类的去处（2026-10-16）：打卡墙、家庭页、菜谱详情 */}
          <Route path="/checkins" element={<div data-testid="checkins-page" />} />
          <Route path="/family" element={<div data-testid="family-page" />} />
          <Route path="/recipes/:id" element={<div data-testid="recipe-detail-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const ITEMS = [
  notificationFixture({
    id: 'done:2026-10-15-DINNER',
    kind: 'done',
    title: '今天晚餐做好了',
    body: '你点的 红烧排骨 可以吃了',
    at: '2026-10-15T18:30:00',
    // 去处是那一餐的详情（后端给整条路径，前端不按 kind 拼）
    to: '/order/2026-10-15-DINNER',
    // 属于哪一餐——同样由后端给（点单列表用它标"哪张卡有事没看过"）
    mealKey: '2026-10-15-DINNER',
    tag: '做好了',
    unread: true,
  }),
  notificationFixture({
    id: 'prep:2026-10-15',
    kind: 'prep',
    title: '明天午餐还没安排',
    body: '想吃什么去点两道',
    at: '2026-10-15T00:00:00',
    to: '/prep',
    // 该备菜说的是"这一餐空着"——空着才没有卡，所以这一条给不出 mealKey
    mealKey: null,
    tag: '备菜',
    unread: false,
  }),
]

/**
 * 装一份看板。**传 `{ items }` 就够**：`unread`/`unreadByKind`/`prefs` 由
 * `boardFixture` 按 items 算出来（与后端同一口径），用例不必自己写那三个数
 * ——手写的那几份在"加一类提醒"时会漏字段（2026-10-16 就是这么炸的编译）。
 */
function mockBoard(board: Partial<NotificationBoard> & { items?: AppNotification[] }, onPost?: (url: string, body: unknown) => void) {
  const full = boardFixture(board)
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
    if (url === '/notifications') return Promise.resolve({ data: full } as never)
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
  mockBoard({ items: ITEMS })
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
  mockBoard({ items: ITEMS })
  renderPage()

  fireEvent.click(await screen.findByText('今天晚餐做好了'))
  // 后端给的 to 是 **`/order/2026-10-15-DINNER`**（那一餐的详情）：点进来直接是这一餐，
  // 而不是列表页让他自己找——前端一个字的跳转表都没有，路径整条来自后端
  expect(await screen.findByTestId('order-detail-page')).toBeTruthy()
})

it('**打开页面本身不清红点**（用户要的是"真的已读"才清）', async () => {
  const calls: string[] = []
  mockBoard({ items: ITEMS }, (url) => calls.push(url))
  renderPage()

  await screen.findByText('今天晚餐做好了')
  // 给一点时间让可能的请求发出来——进来这一下**不该**标记任何东西
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(calls).toEqual([])
})

it('点开那一条才标它已读（先标记再跳走，顺序不能反）', async () => {
  const posts: { url: string; body: unknown }[] = []
  mockBoard({ items: ITEMS }, (url, body) => posts.push({ url, body }))
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
  mockBoard({ items: ITEMS }, (url, body) => posts.push({ url, body }))
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
  mockBoard({ items: ITEMS }, (url, body) => posts.push({ url, body }))
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
  mockBoard({ items: ITEMS.map((item) => ({ ...item, unread: false })) })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull()
})

it('空态给出下一步（不是一句"没有消息"了事）', async () => {
  mockBoard({ items: [] })
  renderPage()

  expect(await screen.findByText('眼下没什么要处理的')).toBeTruthy()
  expect(screen.getByText('去看看今天的菜单')).toBeTruthy()
})

it('九个开关各自照后端的当前值画，改一个只提交那一个', async () => {
  const posts: { url: string; body: unknown }[] = []
  mockBoard(
    // 关掉一个**靠后**的（菜谱）与一个靠前的（备菜）：顺序若写错，这条就会红
    { items: [], prefs: { ...ALL_PREFS_ON, prep: false, recipe: false } },
    (url, body) => posts.push({ url, body }),
  )
  renderPage()

  const switches = await screen.findAllByRole('switch')
  /*
   * 顺序与 `NOTIFICATION_KINDS` 一致（前四个状态型、后五个事件型），
   * 且**九个都在**——2026-10-16 从四个扩到九个，只画前四个的话，
   * 用户会在通知中心看到"订单/冰箱/打卡/家庭/菜谱"的提醒却找不到关掉它的开关。
   */
  expect(switches.length).toBe(9)
  expect(switches.map((node) => (node as HTMLInputElement).checked)).toEqual([
    true, true, true, false, true, true, true, true, false,
  ])

  fireEvent.click(switches[0])
  await waitFor(() => expect(posts).toContainEqual({ url: '/notifications/prefs', body: { mealPlan: false } }))
})

it('新加的五类各有自己的开关，且改它只提交它（用户 2026-10-16 要的那四块）', async () => {
  const posts: { url: string; body: unknown }[] = []
  mockBoard({ items: [] }, (url, body) => posts.push({ url, body }))
  renderPage()

  // 五个新开关的文案都在（用户要在界面上看得见"什么会打扰我"）
  for (const title of ['订单有变化', '冰箱有变化', '打卡墙', '家庭有变化', '菜谱有变化']) {
    expect(await screen.findByText(title)).toBeTruthy()
  }

  // 改「家庭有变化」只提交这一个键
  const family = await screen.findByRole('switch', { name: '家庭有变化' })
  fireEvent.click(family)
  await waitFor(() => expect(posts).toContainEqual({ url: '/notifications/prefs', body: { family: false } }))
})

it('事件型的提醒（打卡/家庭/菜谱）也画得出来：图标与小标都从后端那条拿', async () => {
  mockBoard({
    items: [
      notificationFixture({
        id: 'checkin:photo-1', kind: 'checkin', title: '妈妈往打卡墙传了一张照片',
        body: '去看看做得怎么样', to: '/checkins', mealKey: null, tag: '打卡',
      }),
      notificationFixture({
        id: 'family:f1:2', kind: 'family', title: '爸爸加入了家庭',
        body: '现在家里有 3 口人', to: '/family', mealKey: null, tag: '新成员',
      }),
      notificationFixture({
        id: 'recipe:new-1', kind: 'recipe', title: '妈妈上传了新菜谱「番茄炒蛋」',
        body: '家常 · 川菜', to: '/recipes/own-1', mealKey: null, tag: '新菜谱',
      }),
    ],
  })
  renderPage()

  expect(await screen.findByText('妈妈往打卡墙传了一张照片')).toBeTruthy()
  expect(screen.getByText('爸爸加入了家庭')).toBeTruthy()
  expect(screen.getByText('妈妈上传了新菜谱「番茄炒蛋」')).toBeTruthy()
  /*
   * 小标（tag）与去处都由后端给：前端只渲染。这里钉住"三类各画各的"，
   * 而不是"十类里只有四类能画出来"——旧的 `KIND_STYLE` 只有四个键时，
   * 事件型那几条会因为 `KIND_STYLE[item.kind]` 是 undefined 而直接崩掉。
   */
  expect(screen.getByText('打卡')).toBeTruthy()
  expect(screen.getByText('新成员')).toBeTruthy()

  /*
   * 去处照后端给的那条走（**不是**所有提醒都去订单详情——这一点最容易在
   * "加了几类提醒但没加路由"时漏掉）：打卡那条落到打卡墙。
   */
  fireEvent.click(screen.getByText('妈妈往打卡墙传了一张照片'))
  expect(await screen.findByTestId('checkins-page')).toBeTruthy()
})

it('那条边界说明留着：说清"什么会弹、什么不会"', async () => {
  mockBoard({ items: ITEMS })
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
  /*
   * 两半都要在（2026-10-16 改口径之后）：
   * ① 本机能算的那两类**关掉应用也会响**（交付二，走去系统闹钟）；
   * ② "家里刚发生的事"靠后台巡查，**最多晚约一刻钟**——上一版这里写的是
   *    「只在应用内看得到」，那是交付三之前的实话，现在不准了：
   *    说成"应用内才能看到"会让用户以为必须开着 App，而它其实在后台也会响。
   */
  expect(screen.getByText(/关掉这个应用也会响/)).toBeTruthy()
  expect(screen.getByText(/最多晚约一刻钟知道/)).toBeTruthy()
})

it('手机弹窗提醒**默认开着**：界面上没有它的开关（用户要求删掉这块配置）', async () => {
  mockBoard({ items: ITEMS })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  expect(screen.queryByRole('switch', { name: '手机弹窗提醒' })).toBeNull()
  // 但说明还在：不说清"哪些会弹、哪些只在应用里"用户会以为提醒坏了
  expect(screen.getByText(/关掉这个应用也会响/)).toBeTruthy()
})

it('到期提醒说的是"到期那天早上"（提前排给系统闹钟，不是只在当天算）', async () => {
  mockBoard({ items: ITEMS })
  renderPage()

  // 口径必须写对：写"当天到期时会弹一下"会让人以为只在当天算，
  // 而真正让"关掉也响"成立的是**提前排**（见 local-notify.rules 的 expiryReminders）
  expect(await screen.findByText(/冰箱里有东西到期那天早上/)).toBeTruthy()
})

it('**不给假按钮**：系统权限被拒时只留一句"去设置里打开"（点了没反应的按钮不许有）', async () => {
  mockBoard({ items: ITEMS })
  renderPage()

  await screen.findByText('今天晚餐做好了')
  /*
   * 浏览器里 `permissionState()` 是 'unsupported'，所以这条路径只在真机上出现——
   * 单测里能钉住的是**没有那个开关**、以及说明文案的骨架。
   * 「被拒 → 只给引导、不给按钮」这条纪律见 D-066 与 R-071。
   */
  expect(screen.queryByRole('button', { name: /去打开|开启|打开通知/ })).toBeNull()
})

/*
 * 「到过那条提醒指向的地方」就算看过（用户 2026-10-14：「我点进去怎么还是菜单啊，
 * 没有去掉红点啊」）。外壳在每个地址上调一次 `useMarkArrived`，这里直接测这个 hook。
 */
