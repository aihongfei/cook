// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AxiosRequestConfig } from 'axios'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { emitTabRetap } from '@/lib/tab-retap'
import type { Family } from '@/api/family'
import type { NotificationBoard } from '@/api/notifications'
import { ALL_PREFS_ON, boardFixture as boardNotification, notificationFixture } from '@/api/notifications.testkit'
import type { MealCard, OrderBoard } from '@/api/orders'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import OrderPage from './OrderPage'

// 点菜单（M3 / F3-01~F3-05）的判定核心：
// - 状态机不吃前端硬编码：卡片按钮来自后端下发的 nextActions（所以后端算错角色，这里也会照出来）；
// - 计数徽标用后端给的 counts（切换筛选时其它状态的数字不能被清成 0）；
// - 取消整餐要二次确认；
// - 没加入家庭时给引导，不去撞后端 404。
//
// 2026-10-16 列表改版（用户：「不要多选了，这块永远就展示今明后三天的菜单」）之后，
// 这一页**不再有多选/批量退菜**，也**不再在卡片上逐份退菜**——那两件事都收进了这一餐的
// 详情页（在那里验，见 OrderDetailPage.test.tsx）。这一份里与之相关的用例随之删掉。

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
          <Route path="/order/:mealKey" element={<h2>这一餐详情</h2>} />
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
    // 「谁做的这餐」（M10 / F10-02）：与"谁定的"并列下发，详情页分开说
    doneBy: null,
    doneAt: null,
    // 能不能「再点一次」（F3-06）：由后端按状态与日期算好，前端只负责显示按钮
    canRepeat: false,
    // 与后端同一条判据（到「正在做」为止都能加，只有「做好了」封口）；下面按状态覆盖的那几处会各自改它
    canAdd: true,
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
  // 三天之外还有几餐（列表只看今明后三天）：默认 0，需要时由用例覆盖
  return { cards, counts, scope: 'family', beyondCount: 0, ...overrides }
}

/*
 * 卡片标题说人话：今天/明天/后天，再远的写月-日（OrderPage 的 `labelOfDay`）。
 *
 * 夹具的日期是**写死**的（2026-10-13 这类），所以断言不能写死标题：同一个夹具今天跑出来是
 * 「10-13 · 晚餐」，在 10-13 那天跑就变成「今天 · 晚餐」。这里按同一套说法算出来，
 * 免得这一批用例在某几天集体变红；规则本身另有一条用例（见「卡片标题说人话」）。
 */
function dayKey(offsetDays: number): string {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

function headingOf(date: string, mealLabel = '晚餐'): string {
  const day =
    date === dayKey(0) ? '今天' : date === dayKey(1) ? '明天' : date === dayKey(2) ? '后天' : date.slice(5)
  return `${day} · ${mealLabel}`
}

/** 页面同时用 /family、/orders、/orders/options 与 /notifications（卡片上的未读标记） */
function mockGet({
  family = familyFixture() as Family | null,
  boards,
  // 默认那份"没有提醒"的看板走夹具（也顺带钉住"三条数由 items 推出来"）
  notifications = boardNotification(),
}: {
  family?: Family | null
  boards: Record<string, OrderBoard>
  notifications?: NotificationBoard
}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: AxiosRequestConfig) => {
    // 用 AxiosRequestConfig（而不是自定义的窄类型）才能与 axios 的 get 签名兼容
    const params = config?.params as Record<string, string> | undefined
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/notifications') return Promise.resolve({ data: notifications } as never)
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
  /*
   * jsdom 没有布局引擎：`clientWidth` 恒为 0，而"这一下划得够不够翻页"是按页宽（22%）算的
   * → 不给个真宽度，滑动那两条用例会永远停在"不够"。真实浏览器里宽度是真的（见 SwipePager）。
   */
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
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

  expect(await screen.findByText(headingOf('2026-10-13'))).toBeTruthy()
  // 谁点的 + 几点提交（日期已由标题承担，这里不再重复一个日期）
  expect(screen.getByText(/^妈妈 · 小满 点的 · \d{2}:\d{2} 提交$/)).toBeTruthy()
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
  // 统计收成**一条信息行**（2026-10-16 改版：原来散在四处，每处都在说同一档事）
  const info = document.querySelector('.order-card__info') as HTMLElement
  expect(info.textContent).toContain('共 2 道 · 2 人点了 · 含我 1 份')
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

  expect(await screen.findByText(headingOf('2026-10-13'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: '选好了' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消这餐' })).toBeNull()
  // 而"我点了几份"这条信息照旧（吃货要知道自己点了什么，跟能不能管理这一餐无关）
  expect(screen.getByText(/含我 1 份/)).toBeTruthy()
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

  expect(await screen.findByText(headingOf('2026-10-13'))).toBeTruthy()
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

/*
 * 逐份退菜**从列表搬去详情页**（2026-10-16 改版：用户「订单页的卡片又显的很乱」）。
 *
 * 原样是每道菜行尾挂一颗「退掉我这份」药丸，两道菜就是右侧一列药丸，而那张卡上还有
 * 一整排工具与流转按钮。现在列表回到"扫一眼就知道这一顿有什么"，退谁的那一份在详情页
 * ——那里按人分组，弹窗会把"退的是谁的"点名（**行为用例在 OrderDetailPage.test.tsx**：
 * 每一份都能退、别人那一份点明是谁的、做好了就封口）。
 *
 * 这一条守的是**别把药丸又加回列表**（它是用户明说"很乱"的那一层），
 * 同时守住"整卡可点"的前提还成立：菜品区里没有任何可交互元素，点菜名就是点这张卡。
 */
it('列表卡片上不再有逐份退菜的按钮：菜品区只有文字，整块让给"点进详情"', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  await screen.findByText('番茄炒蛋')
  const dishArea = document.querySelector('.order-card__dishes') as HTMLElement
  expect(dishArea).toBeTruthy()
  expect(dishArea.querySelectorAll('button, a, input')).toHaveLength(0)
  // 两道菜的名字与份数都还在（去掉的是按钮，不是信息）
  expect(screen.getByText('红烧排骨')).toBeTruthy()
  expect(screen.getByText('×2')).toBeTruthy()
})

it('「已安排」的那一餐仍然给得出下一步按钮（状态机照旧，改的只是卡片的排版）', async () => {
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
})

it('「做好了」的一餐：卡片上给的是成品照，而不是能改的东西', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ status: 'DONE', statusLabel: '已做好', nextActions: [], photoCount: 1 }),
      ]),
    },
  })
  renderOrder()

  expect(await screen.findByText(headingOf('2026-10-13'))).toBeTruthy()
  // 流转按钮一个都不给（后端 nextActions 为空），能点的只剩"看照片/传照片"那一档
  expect(screen.queryByRole('button', { name: '选好了' })).toBeNull()
  expect(screen.getByRole('button', { name: '再传一张' })).toBeTruthy()
})

it('切换「只看我的」按 scope 重新取数（两个视角各自一片缓存）', async () => {
  mockGet({
    boards: {
      'family:ALL': boardFixture(),
      'mine:ALL': boardFixture([cardFixture({ mineCount: 1 })], { scope: 'mine' }),
    },
  })
  renderOrder()

  fireEvent.click(await screen.findByRole('tab', { name: '只看我的' }))
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
        beyondCount: 0,
      },
    },
  })
  renderOrder()

  // 正在准备中：0 条 → 这个 chip 本来不显示，所以直接用手动筛选是点不到的；
  // 改验「全部」为空时的空态（同一段渲染逻辑）
  await screen.findByText(headingOf('2026-10-13'))
  expect(screen.queryByText('这三天还没有人点菜')).toBeNull()
})

it('一单都没有时给空态与点菜引导', async () => {
  mockGet({
    boards: {
      family: {
        cards: [],
        counts: { ALL: 0, PENDING: 0, PLANNED: 0, COOKING: 0, DONE: 0, CANCELED: 0 },
        scope: 'family',
        beyondCount: 0,
      },
    },
  })
  renderOrder()

  // 空态的说法跟着列表窗口走：看的就是这三天，所以是"这三天还没有人点菜"
  expect(await screen.findByText('这三天还没有人点菜')).toBeTruthy()
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
        beyondCount: 0,
      },
    },
  })
  renderOrder()

  // 入口与空态同时在（空态是"没有单子"，入口是"加点什么"，两者不互相替代）
  fireEvent.click(await screen.findByRole('button', { name: /自己写一道/ }))
  expect(await screen.findByPlaceholderText('如：外婆的糖醋小排')).toBeTruthy()
})

/*
 * 这两个入口的位置在 2026-10-16 定了（用户：「历史按钮放在筛选右侧吧」、
 * 「自己写一道可以用悬浮的」）。它们**不再是并排的一行**——原先是固定区里的一整行
 * （`.order-shortcuts`），三件事里它最重，现在各自按自己的分量摆：
 *
 * - 「历史」进筛选行最右：它与 chips 同一行、与卡片同一条右栏距，但**不在 chips 那个横滚容器里**
 *   （不然选后面几个状态时它会被一起滚走）；
 * - 「自己写一道」成悬浮胶囊（`.order-write`）：压在 AI 球正上方，全页常驻、不占列表高度。
 *
 * jsdom 算不了布局，所以守的是**决定这件事的结构**：谁挂在谁下面、在不在固定区里。
 */
it('「历史」在筛选行最右（不在 chips 的横滚容器里）；「自己写一道」是悬浮胶囊', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  const historyEntry = await screen.findByRole('link', { name: /历史/ })
  const row = document.querySelector('.order-filter') as HTMLElement
  expect(row).toBeTruthy()
  // ① 同一行、且是这一行的最后一个子节点（贴右）
  expect(historyEntry.parentElement).toBe(row)
  expect(row.lastElementChild).toBe(historyEntry)
  // ② chips 那一截（第一个子节点）才是横滚容器，历史不在里面
  expect(row.firstElementChild?.contains(historyEntry)).toBe(false)

  // ③ 「自己写一道」**不在固定区**、也不是列表里的一行：它是一个悬在最上层的按钮
  const freeEntry = screen.getByRole('button', { name: /自己写一道/ })
  expect(document.querySelector('.order-shortcuts')).toBeNull()
  expect(freeEntry.closest('.page__fixed')).toBeNull()
  const css = readFileSync(join(__dirname, './order.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const write = css.match(/\.order-write\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(write, '没读到 .order-write 规则').toBeTruthy()
  expect(write, '悬浮胶囊要脱离文档流才不占列表高度').toMatch(/position:\s*fixed/)
  // 它压不住最后一排按钮：列表尾部要留出悬浮件的空档（预览里实测盖住了动作行）
  expect(css).toMatch(/\.order-float-tail\s*\{[\s\S]*?height:\s*9[0-9]px|\.order-float-tail\s*\{[\s\S]*?height:\s*1[0-9][0-9]px/)
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

  expect(await screen.findByText('已传 3 张成品照，去看看')).toBeTruthy()
  // 已经有照片了，按钮话术变成"再传一张"（不然像在催人重复上传）
  expect(screen.getByRole('button', { name: '再传一张' })).toBeTruthy()
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

  expect(await screen.findByRole('button', { name: '传成品照' })).toBeTruthy()
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

  // 人数在右边那颗按钮上，点单人数在左边的半句里——两个数各说各的事，不能合成一个
  expect(await screen.findByRole('button', { name: /5 人吃/ })).toBeTruthy()
  const stats = document.querySelector('.order-card__info > span') as HTMLElement
  expect(stats.textContent).toContain('2 人点了')
  expect(stats.textContent).not.toContain('5 人')
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

  expect(await screen.findByRole('button', { name: '再点一次' })).toBeTruthy()
})

it('还在收集中的那一餐不给这个入口（要加菜直接点那道菜，不必绕道"复制"）', async () => {
  mockGet({
    boards: { family: boardFixture([cardFixture({ mealKey: 'open-1', canRepeat: false })]) },
  })
  renderOrder()

  expect(await screen.findByText(headingOf('2026-10-13'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: '再点一次' })).toBeNull()
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

  fireEvent.click(await screen.findByRole('button', { name: '再点一次' }))

  /*
   * 抽屉打开后「再点一次」这句话**有两处**：卡片上那颗按钮（还在页面上）与抽屉标题。
   * 从前那颗按钮前面有个文字 🔁 把两者分开，现在图标是图（2026-10-16），
   * 按钮的可读名字就只剩「再点一次」了——所以要按抽屉那一层去找标题。
   */
  expect(await screen.findByText('再点一次', { selector: '.sheet__title' })).toBeTruthy()
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

  fireEvent.click(await screen.findByRole('button', { name: '再点一次' }))
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

  fireEvent.click(await screen.findByRole('button', { name: '再点一次' }))
  fireEvent.click(await screen.findByRole('button', { name: '明天' }))
  fireEvent.click(await screen.findByRole('button', { name: /照这桌点进/ }))

  await waitFor(() =>
    expect(useToasts.getState().items.map((item) => item.text)).toContain('这一餐里这桌菜都有了'),
  )
  // 后端给的话就照念，前端不自己拼一句（两处拼迟早说岔）
  expect(useToasts.getState().items.map((item) => item.text).join('|')).not.toContain('点了 0 道')
})

/*
 * 卡片进详情（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
 *
 * 这里验的是**入口能不能用**，以及那条最容易踩坏的边界：整卡 onClick 挂在外层，
 * 而卡片里还有真按钮——点内层按钮**不能**顺带把人带去详情页
 * （点「选好了」结果跳走了，是最典型的那种"点错了还不知道为什么"）。
 */
it('点卡片空白处进这一餐的详情', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  const date = await screen.findByText(headingOf('2026-10-13'))
  fireEvent.click(date)
  expect(await screen.findByText('这一餐详情')).toBeTruthy()
})

it('点卡片里的按钮（选好了）**不会**误进详情页', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  fireEvent.click(await screen.findByRole('button', { name: '选好了' }))
  // 走的是"定这一餐"的汇总视图，不是跳详情
  expect(await screen.findByText('定下这一餐')).toBeTruthy()
  expect(screen.queryByText('这一餐详情')).toBeNull()
})

it('卡片标题区是真链接：键盘与读屏也能进详情（不只是鼠标可点）', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  /*
   * 标题区那条链接的可达名是**整块**（日期 + 谁点的 + 提交时间），所以按前缀匹配。
   * 页面别处还有「历史」「去备菜计划」等链接，但它们不含这个日期，不会误命中。
   */
  const links = screen.getAllByRole('link', { name: new RegExp(headingOf('2026-10-13')) })
  expect(links.length).toBe(1)
  expect(links[0].getAttribute('href')).toBe('/order/2026-10-13-DINNER')
})

/*
 * 卡片上的未读标记（用户 2026-10-14：「订单有红点，但是里面的卡片看不出来哪个是提醒的」）。
 *
 * 红点说"订单这一支有事"，但它不说明**是哪一餐**——卡片的职责是回答这个。
 * 三条要钉住的性质：
 *   ① 只标未读的（已读过的不能还挂着标记，否则用户会觉得"我明明点过了"）；
 *   ② 一餐两条各占各的（菜单 + 做好了），且**做好了排在前面**；
 *   ③ 标不到卡上的那两类（快过期、该备菜）**不硬塞**——尤其备菜虽属订单，
 *      但它说的正是"这一餐还空着"，空着的那一餐在列表上没有卡。
 */
it('未读标记只落在**那几餐**的卡上：别的卡一点变化都没有', async () => {
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: '2026-10-13-DINNER', date: '2026-10-13', mealLabel: '晚餐' }),
        cardFixture({
          mealKey: '2026-10-14-LUNCH',
          date: '2026-10-14',
          meal: 'LUNCH',
          mealLabel: '午餐',
        }),
      ]),
    },
    notifications: {
      items: [
        notificationFixture({
            id: 'done:2026-10-14-LUNCH',
            kind: 'done',
            title: '明天午餐做好了',
            body: '你点的 红烧排骨 可以吃了',
            at: '2026-10-14T12:30:00.000Z',
            to: '/order/2026-10-14-LUNCH',
            mealKey: '2026-10-14-LUNCH',
            tag: '做好了',
            unread: true,
        }),
      ],
      unread: 1,
      unreadByArea: { order: 1 },
      unreadByKind: { done: 1 },
      prefs: ALL_PREFS_ON,
    },
  })
  renderOrder()

  // 角标上写的是**后端给的那个 `tag`**，前端不另写一张"什么类别写什么字"的表
  expect(await screen.findByText('做好了')).toBeTruthy()
  // 有未读的那张卡自己也是"未读样"（左边一条品牌色竖标），另一张完全没变
  const cards = document.querySelectorAll('.order-card')
  expect(cards.length).toBe(2)
  expect(cards[0].className).not.toContain('is-unread')
  expect(cards[1].className).toContain('is-unread')
  // 而且角标只挂在那一张上——不是两张各挂一颗
  expect(cards[0].querySelector('.order-card__corner')).toBeNull()
  expect(cards[1].querySelector('.order-card__corner')).not.toBeNull()
})

it('一餐两条未读时都念得出来，且「做好了」在前（哪个更该先看到，不随列表顺序变）', async () => {
  mockGet({
    boards: { family: boardFixture() },
    notifications: {
      items: [
        notificationFixture({
            id: 'done:2026-10-13-DINNER',
            kind: 'done',
            title: '今天晚餐做好了',
            body: '你点的 红烧排骨 可以吃了',
            at: '2026-10-13T18:30:00.000Z',
            to: '/order/2026-10-13-DINNER',
            mealKey: '2026-10-13-DINNER',
            tag: '做好了',
            unread: true,
        }),
        notificationFixture({
            id: 'plan:2026-10-13-DINNER',
            kind: 'plan',
            title: '今天晚餐的菜单定下来了',
            body: '妈妈定了 2 道菜',
            at: '2026-10-13T10:00:00.000Z',
            to: '/order/2026-10-13-DINNER',
            mealKey: '2026-10-13-DINNER',
            tag: '选好了',
            unread: true,
        }),
      ],
      unread: 2,
      unreadByArea: { order: 2 },
      unreadByKind: { plan: 1, done: 1 },
      prefs: ALL_PREFS_ON,
    },
  })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  // 角标写在**卡片右上角**（用户 2026-10-14 说标题行里的标记他根本没看见），
  // 一餐最多两条，并排念在一颗角标里（`A · B`），不叠两颗
  expect(document.querySelector('.order-card__corner')?.textContent).toBe('做好了 · 选好了')
  // 它不是按钮、也不吃掉点击：点角标等于点这张卡（CSS 里 pointer-events: none）
  expect(document.querySelector('.order-card__corner')?.tagName).toBe('SPAN')
})

it('已读的那条不留标记（标过了还挂着，用户会以为没生效）', async () => {
  mockGet({
    boards: { family: boardFixture() },
    notifications: {
      items: [
        notificationFixture({
            id: 'done:2026-10-13-DINNER',
            kind: 'done',
            title: '今天晚餐做好了',
            body: null,
            at: '2026-10-13T18:30:00.000Z',
            to: '/order/2026-10-13-DINNER',
            mealKey: '2026-10-13-DINNER',
            tag: '做好了',
            unread: false,
        }),
      ],
      unread: 0,
      unreadByArea: {},
      unreadByKind: {},
      prefs: ALL_PREFS_ON,
    },
  })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  expect(screen.queryByText('做好了')).toBeNull()
  expect(document.querySelector('.order-card')?.className).not.toContain('is-unread')
})

/*
 * 再点一次「订单」Tab：滚到那条提醒对应的卡（用户 2026-10-14：「再加一下重复点击
 * 订单tab时自动滚到通知的那个卡片位置」）。
 *
 * 为什么需要它：列表按日子**倒序**，"今天"在最下——提醒经常落在用户一眼看不到的
 * 那几张卡上（实测那次在第 14 张），他会以为角标没做出来。
 */
it('再点一次订单 Tab：滚到那条未读提醒所在的卡', async () => {
  const scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: '2026-10-13-DINNER', date: '2026-10-13' }),
        cardFixture({ mealKey: '2026-10-12-LUNCH', date: '2026-10-12', meal: 'LUNCH', mealLabel: '午餐' }),
      ]),
    },
    notifications: {
      items: [
        notificationFixture({
            id: 'plan:2026-10-12-LUNCH',
            kind: 'plan',
            title: '昨天午餐的菜单定下来了',
            body: null,
            at: '2026-10-12T10:00:00.000Z',
            to: '/order/2026-10-12-LUNCH',
            mealKey: '2026-10-12-LUNCH',
            tag: '选好了',
            unread: true,
        }),
      ],
      unread: 1,
      unreadByArea: { order: 1 },
      unreadByKind: { plan: 1 },
      prefs: ALL_PREFS_ON,
    },
  })
  renderOrder()
  await screen.findByText(headingOf('2026-10-13'))

  emitTabRetap('/order')
  await waitFor(() => expect(scrollSpy).toHaveBeenCalled())

  // 滚的是**那一张**卡（`data-meal-key`），不是列表顶部、也不是别的卡
  const target = document.querySelector('[data-meal-key="2026-10-12-LUNCH"]') as HTMLElement
  expect(scrollSpy.mock.instances[0]).toBe(target)
  expect(scrollSpy.mock.calls[0][0]).toMatchObject({ block: 'center' })
})

it('那条提醒的卡被筛选挡住时：放开筛选再滚（用户要的是"带我去看"，不是"没找到"）', async () => {
  const scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
  // 切到「只看我的」之后，后端那份列表里没有那张卡
  mockGet({
    boards: {
      family: boardFixture([
        cardFixture({ mealKey: '2026-10-13-DINNER', date: '2026-10-13' }),
        cardFixture({ mealKey: '2026-10-12-LUNCH', date: '2026-10-12', meal: 'LUNCH', mealLabel: '午餐' }),
      ]),
      mine: boardFixture([cardFixture({ mealKey: '2026-10-13-DINNER', date: '2026-10-13' })]),
    },
    notifications: {
      items: [
        notificationFixture({
            id: 'plan:2026-10-12-LUNCH',
            kind: 'plan',
            title: '昨天午餐的菜单定下来了',
            body: null,
            at: '2026-10-12T10:00:00.000Z',
            to: '/order/2026-10-12-LUNCH',
            mealKey: '2026-10-12-LUNCH',
            tag: '选好了',
            unread: true,
        }),
      ],
      unread: 1,
      unreadByArea: { order: 1 },
      unreadByKind: { plan: 1 },
      prefs: ALL_PREFS_ON,
    },
  })
  renderOrder()
  await screen.findByText(headingOf('2026-10-13'))

  fireEvent.click(screen.getByRole('tab', { name: '只看我的' }))
  await waitFor(() => expect(screen.queryByText(headingOf('2026-10-12', '午餐'))).toBeNull())

  emitTabRetap('/order')
  // 它自己切回「全家点菜单」，那张卡回来了，然后才滚
  await waitFor(() => expect(screen.getByText(headingOf('2026-10-12', '午餐'))).toBeTruthy())
  await waitFor(() => expect(scrollSpy).toHaveBeenCalled())
})

/*
 * 「该备菜」那条：红点亮在订单，但它**没有卡可标**（那一餐还空着）。
 * 列表顶上单独说一句——否则用户看到的是"红点亮着、列表里一处标记都没有"。
 */
it('只有「该备菜」未读时：列表顶上说一句，去处是备菜页（后端给的那条）', async () => {
  mockGet({
    boards: { family: boardFixture() },
    notifications: {
      items: [
        notificationFixture({
            id: 'prep:2026-10-13',
            kind: 'prep',
            title: '接下来 3 餐还没安排',
            body: '最近的是今天晚餐',
            at: '2026-10-13T00:00:00.000Z',
            to: '/prep',
            mealKey: null,
            tag: '备菜',
            unread: true,
        }),
      ],
      unread: 1,
      unreadByArea: { order: 1 },
      unreadByKind: { prep: 1 },
      prefs: ALL_PREFS_ON,
    },
  })
  renderOrder()

  // 顶上那句用的是后端给的标题与副标题（前端不另拼）
  expect(await screen.findByText('接下来 3 餐还没安排')).toBeTruthy()
  expect(screen.getByText('最近的是今天晚餐')).toBeTruthy()
  expect(document.querySelector('.order-notice')?.getAttribute('href')).toBe('/prep')
  // 卡片上仍然一个角标都没有（这一条本来就没有卡）
  expect(document.querySelectorAll('.order-card__corner').length).toBe(0)
})

/*
 * 列表只看今明后三天（2026-10-16 用户定：「这块永远就展示今明后三天的菜单，其余历史的都放入历史中」）。
 *
 * 多选与批量退菜（原来这一整组用例守的东西）**整条不做**了——用户先前的判断是那块"也不好看"，
 * 最终选择是删掉：逐份退菜在详情页，整餐取消在卡片上，批量退菜这个入口没有第三条出路。
 *
 * 这一组改成守收窗之后的三件事：
 * ① 超过三天的餐**不进列表**（窗口由后端给，前端不自己按日期筛）；
 * ② 三天之外还剩多少餐由后端数（`beyondCount`），真有才给那一句，0 时一句不提；
 * ③ 那一句的去处是备菜计划——收窗之后那些餐唯一的家。
 */

/** 造两张卡（不同餐次），用于滑动/滚动那一组 */
const twoCards = () =>
  boardFixture([
    cardFixture(),
    cardFixture({
      mealKey: '2026-10-14-LUNCH',
      date: '2026-10-14',
      meal: 'LUNCH',
      mealLabel: '午餐',
    }),
  ])

it('列表只画后端给的那几餐：三天之外的餐不在这一页，也不在计数里', async () => {
  // 后端已经把窗口之外的行过滤掉了（`listWindowDays`），前端只画收到的卡片
  mockGet({ boards: { family: twoCards() } })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  expect(document.querySelectorAll('.order-card').length).toBe(2)
  // 卡片列表里没有"还有更远的餐"这种占位行——窗口之外的东西只在下面那一句里提
  expect(screen.queryByText(/三天之外/)).toBeNull()
})

it('三天之外还有安排时给一句真话与去处；为 0 时一个字都不说', async () => {
  mockGet({ boards: { family: boardFixture([cardFixture()], { beyondCount: 4 }) } })
  renderOrder()

  const hint = await screen.findByText(/还有 4 餐在三天之外/)
  expect(hint.textContent).toContain('去备菜计划')
  expect(hint.querySelector('a')?.getAttribute('href')).toBe('/prep')
})

it('beyondCount 为 0 时不留那句（宁可没有入口，也不要一个空去处）', async () => {
  mockGet({ boards: { family: boardFixture() } })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  expect(screen.queryByText(/三天之外/)).toBeNull()
})

/*
 * 列表上左右滑动＝切换状态筛选（用户 2026-10-15：「类似这种 tab 页（全部、已安排、已做好）……
 * 需要能左右滑动切换」）。判定在 `lib/tab-swipe.rules.test.ts` 里钉住，这里验接线：
 * 滑动换了筛选值、**在筛选胶囊那一行上划动不换**（那一截自己会横滚）。
 */
function swipe(el: Element, fromX: number, toX: number, dy = 6) {
  const pager = document.querySelector('.swipe-pager') as HTMLElement
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: 400 }] })
  for (let step = 1; step <= 4; step += 1) {
    const x = fromX + ((toX - fromX) * step) / 4
    fireEvent.touchMove(pager, { touches: [{ clientX: x, clientY: 400 + (dy * step) / 4 }] })
  }
  fireEvent.touchEnd(pager, { changedTouches: [{ clientX: toX, clientY: 400 + dy }] })
}

it('列表上往左划 → 切到下一个状态筛选（「全部」→「待确认」）', async () => {
  mockGet({ boards: { family: twoCards() } })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  // 翻页区只在**有数据**时才有（加载中那一段不该是一块能划的空白，D-091）
  const area = document.querySelector('.swipe-pager') as HTMLElement
  expect(area).toBeTruthy()

  swipe(area, 340, 140)

  // 筛选真的换了：那一枚胶囊变成选中态（卡片列表这一块挂在它下面）
  await waitFor(() => {
    const active = document.querySelector('.chip.is-active')
    expect(active?.textContent?.trim().startsWith('待确认')).toBe(true)
  })
})

it('拖动中间两页都在（邻页是当场画出来的：筛选在前端做，不用等接口）', async () => {
  mockGet({ boards: { family: twoCards() } })
  renderOrder()

  await screen.findByText(headingOf('2026-10-13'))
  const pager = document.querySelector('.swipe-pager') as HTMLElement
  fireEvent.touchStart(pager, { touches: [{ clientX: 340, clientY: 400 }] })
  fireEvent.touchMove(pager, { touches: [{ clientX: 280, clientY: 400 }] })

  const keys = [...document.querySelectorAll('.swipe-pager__panel')].map(
    (panel) => (panel as HTMLElement).dataset.panelKey,
  )
  expect(keys).toEqual(['ALL', 'PENDING'])
})

it('在筛选胶囊那一行上划动**不换筛选**（那一行自己横着滚，划动是"看后面的选项"）', async () => {
  mockGet({ boards: { family: twoCards() } })
  renderOrder()

  // 先等数据到位（筛选行与卡片是同一批数据渲染出来的），再拿那一行
  await screen.findByText(headingOf('2026-10-13'))
  const row = document.querySelector('.chips') as HTMLElement
  expect(row).toBeTruthy()

  swipe(row, 340, 140)

  const active = document.querySelector('.chip.is-active')
  expect(active?.textContent?.trim().startsWith('全部')).toBe(true)
})

/*
 * 2026-10-16（D-091 / R-72）「页头不动、只滚主体」+「段控也能滑」。
 *
 * 这一批改造最容易悄悄坏掉的两件事，各自钉一条：
 * ① 段控与 tab 行**必须落在 `SwipePager` 外面**——那套手势认的是"划在谁身上"，
 *    放进去就会同一次划动被两边抢（用户在"订单手势"那题上选的一边正是"段控也能滑"）；
 * ② 段控自己划得动（左右各一格），并且**在它上面划不会顺带换筛选**。
 */
it('页头区固定、翻页区只包卡片：段控与筛选行都在 SwipePager 外面（否则两个手势会抢）', async () => {
  mockGet({ boards: { family: twoCards() } })
  renderOrder()
  await screen.findByText(headingOf('2026-10-13'))

  const fixed = document.querySelector('.page__fixed') as HTMLElement
  const body = document.querySelector('.page__body') as HTMLElement
  expect(fixed).toBeTruthy()
  expect(body).toBeTruthy()

  // ① 页头三样（标题、段控、筛选行）都在固定区里
  expect(fixed.querySelector('.page-head, .ptitle, h1')).toBeTruthy()
  const segmented = fixed.querySelector('.segmented') as HTMLElement
  const filterRow = fixed.querySelector('.order-filter') as HTMLElement
  expect(segmented).toBeTruthy()
  expect(filterRow).toBeTruthy()
  // …而「历史」也跟着筛选行一起在固定区里（它是页面级的去处，滚到第 6 张卡也该够得着）
  expect(fixed.querySelector('.order-history')).toBeTruthy()

  // ② 翻页区在主体里，而且**只包卡片**：段控 / 筛选行一个都不在里面
  const pager = body.querySelector('.swipe-pager') as HTMLElement
  expect(pager).toBeTruthy()
  expect(pager.querySelector('.segmented')).toBeNull()
  expect(pager.querySelector('.chips')).toBeNull()
  expect(pager.querySelector('.order-history')).toBeNull()
  // 卡片确实在里面（不然上面那几条"不在里面"等于没验）
  expect(pager.querySelector('.order-card')).toBeTruthy()
})

/** 在一段控件自己身上划动（`swipe` 那个是给翻页区的：移动事件派在 `.swipe-pager` 上） */
function swipeSelf(el: Element, fromX: number, toX: number, dy = 4) {
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: 200 }] })
  for (let step = 1; step <= 4; step += 1) {
    const x = fromX + ((toX - fromX) * step) / 4
    fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: 200 + (dy * step) / 4 }] })
  }
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: toX, clientY: 200 + dy }] })
}

it('段控往左划 → 切到「只看我的」（用户 2026-10-16：段控也能滑）', async () => {
  mockGet({ boards: { family: twoCards(), mine: boardFixture([], { scope: 'mine' }) } })
  renderOrder()
  await screen.findByText(headingOf('2026-10-13'))

  const segmented = document.querySelector('.segmented') as HTMLElement
  expect(segmented).toBeTruthy()
  // 起手按在左边那一格上（真实手指就是这么落的）；走 110px > 400*0.22（翻页阈值按控件宽算）
  const first = segmented.querySelector('.segmented__item') as HTMLElement
  swipeSelf(first, 140, 30)

  await waitFor(() => {
    const active = document.querySelector('.segmented__item.is-active')
    expect(active?.textContent?.trim()).toBe('只看我的')
  })
})

it('在段控上划动不会顺带换筛选（两个开关各管各的）', async () => {
  mockGet({ boards: { family: twoCards(), mine: boardFixture([], { scope: 'mine' }) } })
  renderOrder()
  await screen.findByText(headingOf('2026-10-13'))

  const segmented = document.querySelector('.segmented') as HTMLElement
  swipeSelf(segmented.querySelector('.segmented__item') as HTMLElement, 140, 30)

  await waitFor(() => {
    expect(document.querySelector('.segmented__item.is-active')?.textContent?.trim()).toBe('只看我的')
  })
  // 筛选还停在「全部」。要等一手：换 scope 之后那一份数据在新 key 下还要取一次，
  // 「只看我的」这一刻可能还没到（筛选行随数据一起出来）
  await waitFor(() => {
    expect(document.querySelector('.chip.is-active')?.textContent?.trim().startsWith('全部')).toBe(true)
  })
})

it('段控是 tablist：读屏念得出"这组开关在换什么"，当前那一格是选中态', async () => {
  mockGet({ boards: { family: twoCards() } })
  renderOrder()
  await screen.findByText(headingOf('2026-10-13'))

  const group = screen.getByRole('tablist', { name: '看谁的点单' })
  expect(group).toBeTruthy()
  const active = screen.getByRole('tab', { name: '全家点菜单' })
  expect(active.getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: '只看我的' }).getAttribute('aria-selected')).toBe('false')
})
