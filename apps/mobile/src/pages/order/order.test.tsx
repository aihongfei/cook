// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AxiosRequestConfig } from 'axios'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { Family } from '@/api/family'
import type { MealCard, OrderBoard } from '@/api/orders'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import OrderPage from './OrderPage'

// 点菜单（M3 / F3-01~F3-05）的判定核心：
// - 状态机不吃前端硬编码：卡片按钮来自后端下发的 nextActions（所以后端算错角色，这里也会照出来）；
// - 计数徽标用后端给的 counts（切换筛选时其它状态的数字不能被清成 0）；
// - 取消整餐要二次确认，撤回自己点的菜也要问一句；
// - 没加入家庭时给引导，不去撞后端 404。

const clients: QueryClient[] = []

function renderOrder() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={['/order']}>
        <Routes>
          <Route path="/order" element={<OrderPage />} />
          <Route path="/family" element={<h1>家庭页</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function familyFixture(overrides: Partial<Family> = {}): Family {
  return {
    id: 'f1',
    name: '小满一家',
    shared: true,
    inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(),
    memberCount: 2,
    memberLimit: 10,
    myRole: 'OWNER',
    myCapabilities: [
      'order.create',
      'menu.manage',
      'menu.confirm',
      'member.manage',
      'invite.reset',
      'family.edit',
    ],
    members: [
      {
        userId: 'u1',
        nickname: '妈妈',
        avatar: '🍳',
        role: 'OWNER',
        joinedAt: new Date().toISOString(),
        isMe: true,
      },
      {
        userId: 'u2',
        nickname: '小满',
        avatar: '🐰',
        role: 'EATER',
        joinedAt: new Date().toISOString(),
        isMe: false,
      },
    ],
    ...overrides,
  }
}

function cardFixture(overrides: Partial<MealCard> = {}): MealCard {
  return {
    mealKey: '2026-10-13-DINNER',
    date: '2026-10-13',
    meal: 'DINNER',
    mealLabel: '晚餐',
    status: 'PENDING',
    statusLabel: '待确认',
    orderers: ['妈妈', '小满'],
    ordererCount: 2,
    dishCount: 2,
    dishes: [
      {
        recipeId: 'r1',
        name: '番茄炒蛋',
        image: null,
        count: 1,
        notes: [{ nickname: '妈妈', text: '少放盐' }],
        mineItemIds: ['i1'],
      },
      { recipeId: 'r2', name: '红烧排骨', image: null, count: 2, notes: [], mineItemIds: [] },
    ],
    items: [
      {
        id: 'i1',
        recipeId: 'r1',
        name: '番茄炒蛋',
        image: null,
        userId: 'u1',
        nickname: '妈妈',
        avatar: '🍳',
        isMe: true,
        note: '少放盐',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'i2',
        recipeId: 'r2',
        name: '红烧排骨',
        image: null,
        userId: 'u2',
        nickname: '小满',
        avatar: '🐰',
        isMe: false,
        note: null,
        createdAt: new Date().toISOString(),
      },
    ],
    mineCount: 1,
    // 就餐人数（M4 / F4-05）：null = 掌勺人还没定
    dinerCount: null,
    // 成品照张数（F9-08）：后端按可见范围算好，前端只显示
    photoCount: 0,
    // 后端按角色算好的下一步（前端只负责渲染，不自己推状态机）
    nextActions: [
      { status: 'PLANNED', label: '选好了', needsConfirm: false },
      { status: 'CANCELED', label: '取消这餐', needsConfirm: true },
    ],
    submittedAt: '2026-10-12T10:20:00.000Z',
    ...overrides,
  }
}

function boardFixture(
  cards: MealCard[] = [cardFixture()],
  overrides: Partial<OrderBoard> = {},
): OrderBoard {
  const counts: Record<string, number> = {
    ALL: cards.length,
    PENDING: 0,
    PLANNED: 0,
    COOKING: 0,
    DONE: 0,
    CANCELED: 0,
  }
  for (const card of cards) counts[card.status] += 1
  return { cards, counts, scope: 'family', ...overrides }
}

/** 页面同时用 /family、/orders 与 /orders/options */
function mockGet({
  family = familyFixture() as Family | null,
  boards,
}: {
  family?: Family | null
  boards: Record<string, OrderBoard>
}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: AxiosRequestConfig) => {
    // 用 AxiosRequestConfig（而不是自定义的窄类型）才能与 axios 的 get 签名兼容
    const params = config?.params as Record<string, string> | undefined
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/orders/options') {
      return Promise.resolve({
        data: {
          meals: [
            { value: 'LUNCH', label: '午餐' },
            { value: 'DINNER', label: '晚餐' },
          ],
          statuses: [{ value: 'PENDING', label: '待确认' }],
          dayOptions: [
            { value: '2026-10-12', label: '今天' },
            { value: '2026-10-13', label: '明天' },
          ],
        },
      } as never)
    }
    if (url === '/orders') {
      const scope = params?.family === 'false' ? 'mine' : 'family'
      const status = params?.status ?? 'ALL'
      const board = boards[`${scope}:${status}`] ?? boards[scope] ?? boards.family
      if (!board) throw new Error(`未准备的 /orders 响应：${scope}:${status}`)
      return Promise.resolve({ data: board } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  // toast 是模块级 store，不清会带到下一条用例
  useToasts.setState({ items: [] })
  useAuth.getState().setSession({
    token: 'test-token',
    refreshToken: 'test-refresh',
    user: {
      id: 'u1',
      account: 'mama',
      nickname: '妈妈',
      avatar: '🍳',
      email: null,
      createdAt: new Date().toISOString(),
    },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('把后端给的下一步渲染成按钮：待确认时有「选好了」与「取消这餐」', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  expect(await screen.findByText('2026-10-13 · 晚餐')).toBeTruthy()
  expect(screen.getByText('妈妈 · 小满 点的')).toBeTruthy()
  expect(screen.getByRole('button', { name: '选好了' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '取消这餐' })).toBeTruthy()
})

it('卡片显示份数、谁交代的备注，以及「我」点了几份', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  expect(await screen.findByText('红烧排骨')).toBeTruthy()
  expect(screen.getByText('×2')).toBeTruthy()
  // 备注跟着菜走（F3-05）
  expect(screen.getByText('妈妈：少放盐')).toBeTruthy()
  expect(screen.getByText('共 2 道 · 2 人点了（含我点的 1 份）')).toBeTruthy()
})

it('吃货的点单：后端没给 nextActions 就一个流转按钮都不显示', async () => {
  // 权限判定在后端——这里模拟后端给吃货算出的 nextActions 为空
  mockGet({
    family: familyFixture({ myRole: 'EATER', myCapabilities: ['order.create'] }),
    boards: {
      family: boardFixture([cardFixture({ nextActions: [] })]),
    },
  })
  renderOrder()

  expect(await screen.findByText('2026-10-13 · 晚餐')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '选好了' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消这餐' })).toBeNull()
  // 但自己点的菜仍能撤回（这是 order.create 的附带动作，不是管理动作）
  expect(screen.getByRole('button', { name: '撤回我这份' })).toBeTruthy()
})

it('正常推进不打扰用户：点「选好了」直接请求，不弹确认', async () => {
  mockGet({ boards: { family: boardFixture() } })
  const post = vi
    .spyOn(apiClient, 'post')
    .mockResolvedValue({ data: cardFixture({ status: 'PLANNED', statusLabel: '已安排' }) } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '选好了' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-13-DINNER/status', {
      status: 'PLANNED',
    }),
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(await screen.findByText('这餐：已安排')).toBeTruthy()
})

it('取消整餐要二次确认：取消不请求，确认才发（且文案说清"之后能重新点"）', async () => {
  mockGet({ boards: { family: boardFixture() } })
  const post = vi
    .spyOn(apiClient, 'post')
    .mockResolvedValue({
      data: cardFixture({ status: 'CANCELED', statusLabel: '已取消', nextActions: [] }),
    } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '取消这餐' }))
  const dialog = await screen.findByRole('dialog')
  // 标题与确认键文案相同（都叫「取消这餐」），所以按 title id 取标题，避免歧义
  expect(dialog.querySelector('#confirm-title')?.textContent).toBe('取消这餐')
  // 取消不是死路，文案必须说清楚
  expect(within(dialog).getByText(/回到「待确认」/)).toBeTruthy()

  // 先点取消：不发请求，弹窗关闭
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(post).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '取消这餐' }))
  const again = await screen.findByRole('dialog')
  fireEvent.click(within(again).getByRole('button', { name: '取消这餐' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-13-DINNER/status', {
      status: 'CANCELED',
    }),
  )
})

it('撤回自己点的菜也要确认：不点确认不会发请求', async () => {
  mockGet({ boards: { family: boardFixture() } })
  const del = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: cardFixture() } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '撤回我这份' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/把「番茄炒蛋」从这餐里撤回/)).toBeTruthy()

  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(del).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '撤回我这份' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '撤回' }))
  await waitFor(() => expect(del).toHaveBeenCalledWith('/orders/items/i1'))
})

it('别人点的菜不显示撤回入口（只有我点过的才有）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({
          mineCount: 0,
          dishes: [
            { recipeId: 'r2', name: '红烧排骨', image: null, count: 1, notes: [], mineItemIds: [] },
          ],
        }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByText('红烧排骨')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '撤回我这份' })).toBeNull()
})

it('已安排之后不再显示撤回入口（状态不允许了）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({
          status: 'PLANNED',
          statusLabel: '已安排',
          nextActions: [{ status: 'COOKING', label: '开始做', needsConfirm: false }],
        }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByRole('button', { name: '开始做' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '撤回我这份' })).toBeNull()
})

it('切换「只看我的」按 scope 重新取数（两个视角各自一片缓存）', async () => {
  mockGet({
    boards: {
      'family:ALL': boardFixture(),
      'mine:ALL': boardFixture([cardFixture({ mineCount: 1 })], { scope: 'mine' }),
    },
  })
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '只看我的' }))
  const get = apiClient.get as unknown as { mock: { calls: unknown[][] } }
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) =>
          call[0] === '/orders' &&
          (call[1] as { params?: Record<string, string> })?.params?.family === 'false',
      ),
    ).toBe(true),
  )
})

it('筛选计数用后端给的数字，且 0 的状态不占位置（当前选中的除外）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: 'a', status: 'PENDING', statusLabel: '待确认' }),
        cardFixture({ mealKey: 'b', status: 'DONE', statusLabel: '已做好', nextActions: [] }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByRole('button', { name: /全部 2/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /待确认 1/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /已做好 1/ })).toBeTruthy()
  // 一个都没有的状态不显示（免得顶上挂一排 0）
  expect(screen.queryByRole('button', { name: /准备中/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /已取消/ })).toBeNull()
})

it('筛选后列表为空时给出空态而不是空白', async () => {
  mockGet({
    boards: {
      'family:ALL': boardFixture(),
      'family:COOKING': {
        cards: [],
        counts: { ALL: 1, PENDING: 1, PLANNED: 0, COOKING: 0, DONE: 0, CANCELED: 0 },
        scope: 'family',
      },
    },
  })
  renderOrder()

  // 正在准备中：0 条 → 这个 chip 本来不显示，所以直接用手动筛选是点不到的；
  // 改验「全部」为空时的空态（同一段渲染逻辑）
  await screen.findByText('2026-10-13 · 晚餐')
  expect(screen.queryByText('还没有人点菜')).toBeNull()
})

it('一单都没有时给空态与点菜引导', async () => {
  mockGet({
    boards: {
      family: {
        cards: [],
        counts: { ALL: 0, PENDING: 0, PLANNED: 0, COOKING: 0, DONE: 0, CANCELED: 0 },
        scope: 'family',
      },
    },
  })
  renderOrder()

  expect(await screen.findByText('还没有人点菜')).toBeTruthy()
  expect(screen.getByText('翻到想吃的菜，点「想吃这道」，家里人就能看到。')).toBeTruthy()
})

it('还没加入家庭时给引导，不请求点单接口', async () => {
  mockGet({ family: null, boards: {} })
  renderOrder()

  expect(await screen.findByText('点菜单是给家里人一起用的。')).toBeTruthy()
  expect(screen.getByRole('link', { name: '去创建或加入家庭' })).toBeTruthy()
  const get = apiClient.get as unknown as { mock: { calls: unknown[][] } }
  expect(get.mock.calls.some((call) => call[0] === '/orders')).toBe(false)
})

it('「已做好」的卡片显示成品照张数，并给去打卡墙看看的入口', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: 'done-1', status: 'DONE', statusLabel: '已做好', nextActions: [], photoCount: 3 }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByText('已传 3 张成品照，去看看 →')).toBeTruthy()
  // 已经有照片了，按钮话术变成"再传一张"（不然像在催人重复上传）
  expect(screen.getByRole('button', { name: '📷 再传一张' })).toBeTruthy()
})

it('一张成品照都没有时只说上传，不提"去看看"（没东西可看）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: 'done-2', status: 'DONE', statusLabel: '已做好', nextActions: [], photoCount: 0 }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByRole('button', { name: '📷 上传这餐的成品照' })).toBeTruthy()
  expect(screen.queryByText(/张成品照，去看看/)).toBeNull()
})

it('还没做好的卡片上没有成品照入口（照片是"做出来了"的证据）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: 'cooking-1', status: 'COOKING', statusLabel: '准备中' }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByText('准备中')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /成品照/ })).toBeNull()
  expect(screen.queryByText(/张成品照，去看看/)).toBeNull()
})

it('卡片上显示就餐人数；没定过就说"还没定"，不显示 0 人', async () => {
  mockGet({ boards: { family: boardFixture([cardFixture({ mealKey: 'd1', dinerCount: null, ordererCount: 2 })]) } })
  renderOrder()

  const line = await screen.findByRole('button', { name: /还没定几个人吃/ })
  expect(line.textContent).not.toContain('0 人吃')
})

it('定过人数就同时给出"几人吃"与"几人点了"（前者含没点菜只吃饭的家人，两者不是一回事）', async () => {
  mockGet({ boards: { family: boardFixture([cardFixture({ mealKey: 'd2', dinerCount: 5, ordererCount: 2 })]) } })
  renderOrder()

  expect(await screen.findByRole('button', { name: /5 人吃（2 人点了）/ })).toBeTruthy()
})

it('点人数那行会打开定人数的抽屉', async () => {
  mockGet({ boards: { family: boardFixture([cardFixture({ mealKey: 'd3', dinerCount: 3 })]) } })
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: /3 人吃/ }))
  expect(await screen.findByText('定几个人吃')).toBeTruthy()
  expect(screen.getByRole('button', { name: '就这么多人' })).toBeTruthy()
})
