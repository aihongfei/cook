// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AxiosRequestConfig } from 'axios'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { Family } from '@/api/family'
import type { MealCard } from '@/api/orders'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import OrderDetailPage from './OrderDetailPage'

/*
 * 某一餐的详情（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
 *
 * 这一页要回答的是**摘要装不下的那几件事**，所以测的就是它们：
 * - 谁点的是哪一份（**逐份**，同一道菜两人点的备注都要看得到）；
 * - 谁定的、谁做的（两件事可以是两个人，分开说）；
 * - 动作与撤回仍然能用（详情页不是只读页）；
 * - 自己写的那道菜（没有 recipeId）**不做成链接**——点不动的链接比没有链接更糟。
 */

const clients: QueryClient[] = []

function renderDetail(mealKey = '2026-10-13-DINNER') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[`/order/${mealKey}`]}>
        <Routes>
          <Route path="/order/:mealKey" element={<OrderDetailPage />} />
          <Route path="/order" element={<h1>点菜单</h1>} />
          <Route path="/recipes/:id" element={<h1>菜谱详情</h1>} />
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
    myCapabilities: ['order.create', 'menu.manage', 'menu.confirm'],
    members: [],
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
    dishes: [],
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
        createdAt: '2026-10-12T10:20:00.000Z',
      },
      {
        // 同一道菜第二个人点，备注不同——**卡片摘要合并了它，详情页必须还看得出来**
        id: 'i2',
        recipeId: 'r1',
        name: '番茄炒蛋',
        image: null,
        userId: 'u2',
        nickname: '小满',
        avatar: '🐰',
        isMe: false,
        note: '多放糖',
        createdAt: '2026-10-12T10:25:00.000Z',
      },
      {
        // 自己写的一道（F3-10）：没有 recipeId，点不进菜谱详情
        id: 'i3',
        recipeId: null,
        name: '外婆的腌笃鲜',
        image: null,
        userId: 'u1',
        nickname: '妈妈',
        avatar: '🍳',
        isMe: true,
        note: null,
        createdAt: '2026-10-12T10:30:00.000Z',
      },
    ],
    mineCount: 2,
    dinerCount: 4,
    confirmedBy: null,
    confirmedAt: null,
    doneBy: null,
    doneAt: null,
    photoCount: 0,
    canRepeat: false,
    canAdd: true,
    nextActions: [
      { status: 'PLANNED', label: '选好了', needsConfirm: false },
      { status: 'CANCELED', label: '取消这餐', needsConfirm: true },
    ],
    submittedAt: '2026-10-12T10:20:00.000Z',
    ...overrides,
  }
}

function mockGet({ family = familyFixture() as Family | null, card = cardFixture() as MealCard | null, onGet }: {
  family?: Family | null
  card?: MealCard | null
  onGet?: (url: string) => void
} = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string, _config?: AxiosRequestConfig) => {
    onGet?.(url)
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url.startsWith('/orders/')) {
      if (!card) return Promise.reject(new Error('这一餐不存在'))
      return Promise.resolve({ data: card } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
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

it('逐份列出谁点了什么：同一道菜两人的备注都看得到（摘要里被合并掉的那部分）', async () => {
  mockGet()
  renderDetail()

  // 链接里是「菜名 ›」两个文本节点，所以按角色+正则找，不按整串文本找。
  // 用 `findAllByRole`：这道菜**本来就该出现两次**（两个人各点了一份），
  // 单数版会在两个匹配上抛错——而"出现两次"正是这一条要证的事实。
  expect((await screen.findAllByRole('link', { name: /番茄炒蛋/ })).length).toBe(2)
  // 两个人各一行、各有自己的备注——合并成「×2」就看不到这两句
  expect(screen.getByText('备注：少放盐')).toBeTruthy()
  expect(screen.getByText('备注：多放糖')).toBeTruthy()
  expect(screen.getAllByRole('link', { name: /番茄炒蛋/ }).length).toBe(2)
})

it('按人分组：我排在最前，且带「我」的标记', async () => {
  mockGet()
  renderDetail()

  await screen.findAllByRole('link', { name: /番茄炒蛋/ })
  const groups = document.querySelectorAll('.od-person')
  expect(groups.length).toBe(2)
  expect(within(groups[0] as HTMLElement).getByText('我')).toBeTruthy()
  expect(within(groups[0] as HTMLElement).getByText('妈妈')).toBeTruthy()
})

it('自己写的那道菜不做成链接（它没有菜谱详情可进）', async () => {
  mockGet()
  renderDetail()

  const free = await screen.findByText('外婆的腌笃鲜')
  expect(free.tagName).toBe('SPAN')
  expect(screen.getByText('自己写的')).toBeTruthy()
  // 菜谱里那道是真的链接，点得进菜谱详情
  expect(screen.getAllByRole('link', { name: /番茄炒蛋/ }).length).toBe(2)
})

it('谁定的与谁做的分开说（两件事可能是两个人）', async () => {
  mockGet({
    card: cardFixture({
      status: 'DONE',
      statusLabel: '已做好',
      nextActions: [],
      confirmedBy: { nickname: '妈妈', avatar: '🍳' },
      confirmedAt: '2026-10-12T11:00:00.000Z',
      doneBy: { nickname: '爸爸', avatar: '🐻' },
      doneAt: '2026-10-12T18:30:00.000Z',
    }),
  })
  renderDetail()

  expect(await screen.findByText(/妈妈 .* 定下这餐/)).toBeTruthy()
  expect(screen.getByText(/爸爸 .* 标了「做好了」/)).toBeTruthy()
})

it('详情页不是只读页：动作按钮在，且「取消这餐」走二次确认', async () => {
  mockGet()
  renderDetail()

  const cancel = await screen.findByRole('button', { name: '取消这餐' })
  fireEvent.click(cancel)
  // 二次确认出现（取消影响全家人，不能点一下就算）
  expect(await screen.findByText(/取消后这一餐就作废了/)).toBeTruthy()
})

it('每一份都能退（不在"只能退自己点的"了），且**别人的那一份点明是谁的**', async () => {
  /*
   * 口径 2026-10-15 放开（用户：「批量操作…退菜这种的」）：
   * 家里谁都退得掉任何一份（原来只给我自己那份画按钮），到「正在做」为止都能退。
   * 但"我退的不是自己的菜"必须在弹窗里看到——所以两条断言：按钮都在、别人的那条点名。
   */
  mockGet()
  renderDetail()

  await screen.findAllByRole('link', { name: /番茄炒蛋/ })
  // 我点的两份写「退掉」，小满那份写「退掉这份」
  expect(screen.getAllByRole('button', { name: '退掉' }).length).toBe(2)
  const other = screen.getAllByRole('button', { name: '退掉这份' })
  expect(other.length).toBe(1)

  fireEvent.click(other[0])
  // 弹窗里点明是谁点的（小满）——退别人的菜是个大动作
  expect(await screen.findByText(/把小满点的「.*」退掉/)).toBeTruthy()
})

it('「做好了」的那一餐：每一份都不再给退的入口（成品不再是能改的东西）', async () => {
  mockGet({ card: cardFixture({ status: 'DONE', statusLabel: '已做好', nextActions: [] }) })
  renderDetail()

  await screen.findAllByRole('link', { name: /番茄炒蛋/ })
  expect(screen.queryByRole('button', { name: '退掉' })).toBeNull()
  expect(screen.queryByRole('button', { name: '退掉这份' })).toBeNull()
})

it('已做好的一餐给成品照入口，且不再给流转按钮', async () => {
  mockGet({
    card: cardFixture({
      status: 'DONE',
      statusLabel: '已做好',
      photoCount: 2,
      nextActions: [],
    }),
  })
  renderDetail()

  expect(await screen.findByText(/已传 2 张成品照/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /再传一张/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '选好了' })).toBeNull()
})

it('这一餐不存在时给出话与重试，而不是空白页', async () => {
  mockGet({ card: null })
  renderDetail()

  expect(await screen.findByText('这一餐打不开')).toBeTruthy()
})

it('返回按钮指向来源：从通知中心进来就退回通知中心', async () => {
  mockGet()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[{ pathname: '/order/2026-10-13-DINNER', state: { from: '/notifications' } }]}>
        <Routes>
          <Route path="/order/:mealKey" element={<OrderDetailPage />} />
          <Route path="/notifications" element={<h1>家里的消息</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const back = await screen.findByRole('link', { name: /返回家里的消息/ })
  expect(back.getAttribute('href')).toBe('/notifications')
})

/*
 * 「＋ 再加一道」（用户 2026-10-15：「今天点了餐就不能修改了，也不能继续点，都要优化」）。
 *
 * 判据是**后端算好的 `canAdd`**（到「正在做」为止都能加，只有"做好了"封口），
 * 前端不自己推状态；点了跳到菜谱小书并把这一餐当目标——与备菜计划那一行的「加菜」同一条路，
 * 不在这页另做一套点菜抽屉（一件事一个入口，D-066）。
 */
function renderAdd() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  /** 落点探针：把带过来的路由 state 读出来（"这一餐"必须真的传下去了） */
  function RecipesLanding() {
    const location = useLocation()
    return <div data-testid="recipes-page" data-state={JSON.stringify(location.state)} />
  }
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={['/order/2026-10-13-DINNER']}>
        <Routes>
          <Route path="/order/:mealKey" element={<OrderDetailPage />} />
          <Route path="/recipes" element={<RecipesLanding />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

it('「＋ 再加一道」跳到菜谱小书，并把这一餐（日期/餐次/说明）当目标带下去', async () => {
  mockGet()
  renderAdd()

  const add = await screen.findByRole('link', { name: '＋ 再加一道' })
  expect(add.getAttribute('href')).toBe('/recipes')

  fireEvent.click(add)
  const landing = await screen.findByTestId('recipes-page')
  const state = JSON.parse(landing.dataset.state || '{}')
  // 挑完菜点「点这道」要落回**这一餐**：日期、餐次、给用户看的那句说明一个都不能少
  expect(state.plan?.date).toBe('2026-10-13')
  expect(state.plan?.meal).toBe('DINNER')
  expect(state.plan?.label).toBe('这一餐（10-13 晚餐）')
  // 返回目标也跟着下来（从这一餐去的菜谱小书，返回该回这一餐）
  expect(state.from).toBe('/order/2026-10-13-DINNER')
})

it('已做好的那一餐不给「再加一道」（成品封口，要改就是删记录）', async () => {
  mockGet({ card: cardFixture({ status: 'DONE', statusLabel: '已做好', canAdd: false, nextActions: [] }) })
  renderDetail()

  await screen.findAllByRole('link', { name: /番茄炒蛋/ })
  expect(screen.queryByRole('link', { name: '＋ 再加一道' })).toBeNull()
})
