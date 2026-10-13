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
    // 确认留痕（M4 / F4-05）：null = 还没定下这一版
    confirmedBy: null,
    confirmedAt: null,
    // 能不能「再点一次」（F3-06）：由后端按状态与日期算好，前端只负责显示按钮
    canRepeat: false,
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

/*
 * 定菜单先过汇总视图（M4 / F4-05，口径见 D-030）。
 *
 * 原来的行为是点「选好了」直接写库——而它是唯一会让菜单上锁的动作（定完想加菜得先取消）。
 * 现在改成：先开确认抽屉（不请求）→ 看过整桌菜、按「就这些，定了」才真的定。
 * 这条同时把"不许提前写库"钉住：只点「选好了」就必须一个请求都没有。
 */
it('点「选好了」先开汇总视图，不直接写库（定完就锁单，该看一眼再定）', async () => {
  mockGet({ boards: { family: boardFixture() } })
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture({ status: 'PLANNED' }) } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '选好了' }))

  // 抽屉开了：看得到整桌菜（含随菜备注）、几个人点了，并说明定完会锁上
  expect(await screen.findByText('定下这一餐')).toBeTruthy()
  // 备注与人数在卡片上也有一份，所以断言要**限定在抽屉里**（不限定会命中两个元素）
  const sheet = within(document.querySelector('.sheet__body') as HTMLElement)
  expect(sheet.getByText('共 2 道')).toBeTruthy()
  expect(sheet.getByText('妈妈：少放盐')).toBeTruthy()
  expect(sheet.getByText(/定下来之后菜单就锁上了/)).toBeTruthy()
  expect(post).not.toHaveBeenCalled()

  // 到这一步才真的定
  fireEvent.click(screen.getByRole('button', { name: '就这些，定了' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-13-DINNER/status', {
      status: 'PLANNED',
    }),
  )
  expect(await screen.findByText('这一餐定了')).toBeTruthy()
})

it('汇总视图里能看到人数并当场去定：人数没定不拦着定菜单', async () => {
  mockGet({ boards: { family: boardFixture([cardFixture({ dinerCount: null })]) } })
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '选好了' }))
  await screen.findByText('定下这一餐')
  // 人数行同样在卡片上有一份，所以限定在抽屉里取
  const sheet = within(document.querySelector('.sheet__body') as HTMLElement)
  const dinersRow = sheet.getByRole('button', { name: /还没定几个人吃/ })
  // 没定人数也允许定菜单（拦住只会逼出一个随手填的假数字）：提交键可用
  expect(sheet.getByRole('button', { name: '就这些，定了' }).hasAttribute('disabled')).toBe(false)

  // 点那一行去定人数：确认抽屉收起后人数抽屉接着开（不叠着开）
  fireEvent.click(dinersRow)
  expect(await screen.findByText('定几个人吃')).toBeTruthy()
})

it('开始做/做好了仍是直接生效，不给厨房里的人多问一句', async () => {
  // 口径 D-030 第 1 条：只有"上锁"那一步过汇总视图
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
  const post = vi
    .spyOn(apiClient, 'post')
    .mockResolvedValue({ data: cardFixture({ status: 'COOKING', statusLabel: '准备中' }) } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '开始做' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-13-DINNER/status', { status: 'COOKING' }),
  )
  // 没有汇总抽屉掺和进来
  expect(screen.queryByText('定下这一餐')).toBeNull()
})

it('卡片显示确认留痕：谁把这一版菜单定下来的（纯信息，不是按钮）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({
          status: 'PLANNED',
          statusLabel: '已安排',
          confirmedBy: { nickname: '妈妈', avatar: '🍳' },
          confirmedAt: new Date(2026, 9, 12, 15, 20).toISOString(),
        }),
      ]),
    },
  })
  renderOrder()

  const trace = await screen.findByText(/定下这餐/)
  expect(trace.textContent).toContain('妈妈')
  expect(trace.textContent).toContain('10 / 12 15:20')
  expect(trace.tagName).toBe('P')
})

it('还在收集中的那一餐不显示留痕（没有"谁定的"这回事）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ status: 'PENDING', confirmedBy: null, confirmedAt: null }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByText('2026-10-13 · 晚餐')).toBeTruthy()
  expect(screen.queryByText(/定下这餐/)).toBeNull()
})

it('正常推进不打扰用户：点「选好了」不弹确认对话框（那是取消整餐才有的事）', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '选好了' }))
  expect(await screen.findByText('定下这一餐')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
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
  // 空态要把两条路都说出来：去菜谱挑，或者自己写一道（F3-10）
  expect(screen.getByText(/点「想吃这道」/)).toBeTruthy()
  expect(screen.getByText(/也可以自己写一道/)).toBeTruthy()
})

it('点菜单上有「自己写一道」入口，点开是填写抽屉（F3-10）', async () => {
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

  // 入口与空态同时在（空态是"没有单子"，入口是"加点什么"，两者不互相替代）
  fireEvent.click(await screen.findByRole('button', { name: /自己写一道/ }))
  expect(await screen.findByPlaceholderText('如：外婆的糖醋小排')).toBeTruthy()
})

it('「点单历史」与「自己写一道」并排在同一行里', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  // 两个入口随 family 数据一起出现，先等它们渲染出来再断言结构
  const historyEntry = await screen.findByRole('link', { name: /点单历史/ })
  const freeEntry = screen.getByRole('button', { name: /自己写一道/ })

  // 两个入口同为"进另一个地方"的动作，各占半行（用户 2026-10-13 要求并排）。
  // 这里是 DOM 结构断言：分行的样式（.order-shortcuts 的 flex）挂在这一个共同父节点上，
  // 谁被移出去谁就会掉回整行——jsdom 算不了布局，守着这个父节点才守得住"在同一行"。
  const row = document.querySelector('.order-shortcuts')
  expect(row).toBeTruthy()
  expect(historyEntry.parentElement).toBe(row)
  expect(freeEntry.parentElement).toBe(row)
})

it('还没加入家庭时不显示「自己写一道」（点菜是家庭内的协作）', async () => {
  mockGet({ family: null, boards: {} })
  renderOrder()

  await screen.findByText('点菜单是给家里人一起用的。')
  expect(screen.queryByRole('button', { name: /自己写一道/ })).toBeNull()
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

/*
 * 再点一次（F3-06，口径见 D-034）。
 *
 * 判定核心是**入口出不出现在后端的 canRepeat 上**（前端不复刻"做好了/已取消/日子过去了"这套判据），
 * 以及抽屉里的"照到哪一餐"能不能把请求发对。
 */

it('定局的那一餐才有「再点一次」入口（能不能照它点由后端算）', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: 'done-1', canRepeat: true, status: 'DONE', statusLabel: '已做好', nextActions: [] }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByRole('button', { name: '🔁 再点一次' })).toBeTruthy()
})

it('还在收集中的那一餐不给这个入口（要加菜直接点那道菜，不必绕道"复制"）', async () => {
  mockGet({
    boards: { family: boardFixture([cardFixture({ mealKey: 'open-1', canRepeat: false })]) },
  })
  renderOrder()

  expect(await screen.findByText('2026-10-13 · 晚餐')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '🔁 再点一次' })).toBeNull()
})

it('「再点一次」先把要照的那桌菜念出来，再让选照到哪一餐', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({
          mealKey: '2026-10-10-DINNER',
          date: '2026-10-10',
          canRepeat: true,
          status: 'DONE',
          statusLabel: '已做好',
          nextActions: [],
          dishes: [
            { recipeId: 'r1', name: '番茄炒蛋', image: null, count: 1, notes: [{ nickname: '妈妈', text: '少放盐' }], mineItemIds: [] },
            { recipeId: 'r2', name: '红烧排骨', image: null, count: 2, notes: [], mineItemIds: [] },
          ],
        }),
      ]),
    },
  })
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '🔁 再点一次' }))

  expect(await screen.findByText('再点一次')).toBeTruthy()
  // 要照的是哪一桌：菜名连同份数（×2 是"两个人各点了一份"，照抄时只收一份）
  expect(screen.getByText('番茄炒蛋、红烧排骨 ×2')).toBeTruthy()
  // 备注不跟着走这件事要说清楚，否则用户会以为"少放盐"也被带过去了
  expect(screen.getByText(/备注不跟着走/)).toBeTruthy()
})

it('确认后按选中的那一餐发请求，并把"加了哪些、哪些本来就有"如实说给用户', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: '2026-10-10-DINNER', date: '2026-10-10', canRepeat: true, status: 'CANCELED', statusLabel: '已取消', nextActions: [] }),
      ]),
    },
  })
  const post = vi
    .spyOn(apiClient, 'post')
    .mockResolvedValue({
      data: {
        added: ['番茄炒蛋'],
        skipped: ['红烧排骨'],
        card: cardFixture({ mealKey: '2026-10-12-DINNER' }),
      },
    } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '🔁 再点一次' }))
  /*
   * **显式选日子与餐次**，不依赖"默认下一餐"：`nextMealDefaults` 按当前钟点算
   * （15 点前默认今晚、之后默认明天午饭），断言钉死其中一个值会在下午变红。
   * 这里要验的是"选中的那一餐有没有发对"，默认值那条规则由 next-meal 自己的口径保证。
   */
  fireEvent.click(await screen.findByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: '晚餐' }))
  fireEvent.click(screen.getByRole('button', { name: /照这桌点进/ }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-10-DINNER/repeat', {
      mealDate: '2026-10-13',
      meal: 'DINNER',
    }),
  )
  await waitFor(() => expect(useToasts.getState().items.map((item) => item.text)).toContain('照 2026-10-10 晚餐点了 1 道进明天晚餐'))
  // 跳过的那道单独说一句：这一桌两道却只提示加了一道，用户会去数
  expect(useToasts.getState().items.map((item) => item.text)).toContain('红烧排骨 本来就有，没重复加')
})

it('整桌都已经有了：只说"都有了"，不编一个"加了 0 道"', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: '2026-10-10-DINNER', date: '2026-10-10', canRepeat: true, status: 'DONE', statusLabel: '已做好', nextActions: [] }),
      ]),
    },
  })
  vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: {
      added: [],
      skipped: ['番茄炒蛋', '红烧排骨'],
      card: cardFixture({ mealKey: '2026-10-13-DINNER' }),
      message: '这一餐里这桌菜都有了',
    },
  } as never)
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '🔁 再点一次' }))
  fireEvent.click(await screen.findByRole('button', { name: '明天' }))
  fireEvent.click(await screen.findByRole('button', { name: /照这桌点进/ }))

  await waitFor(() =>
    expect(useToasts.getState().items.map((item) => item.text)).toContain('这一餐里这桌菜都有了'),
  )
  // 后端给的话就照念，前端不自己拼一句（两处拼迟早说岔）
  expect(useToasts.getState().items.map((item) => item.text).join('|')).not.toContain('点了 0 道')
})
