// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { TodayBoard } from '@/api/orders'
import { useAuth } from '@/stores/auth'
import TodayMeals from './TodayMeals'

// 厨房页的今日安排（M4 / F4-01）。这块以前是 M0 的假数据（含"早餐：小米南瓜粥"这种编的菜），
// 现在接真实点单。要盯住的三件事：
// ① 没点菜的那一餐**也要占一行**（首页要看得出"晚饭还没人点"），且**不编菜名**；
// ② 有菜的行整行可点，落到点菜单；
// ③ 就餐人数没定时说"还没定"，不是显示 0 个人吃。

const clients: QueryClient[] = []

function renderToday() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TodayMeals />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: [], members: [],
}

function row(overrides: Partial<TodayBoard['rows'][number]> = {}): TodayBoard['rows'][number] {
  return {
    meal: 'LUNCH', label: '午餐', state: 'open', status: 'PENDING', statusLabel: '待确认',
    dishes: ['番茄炒蛋'], dishCount: 1, ordererCount: 1, dinerCount: null,
    mealKey: '2026-10-12-LUNCH', photoCount: 0, canAdd: true,
    ...overrides,
  }
}

function mockGet({ family = FAMILY as unknown, today }: { family?: unknown; today?: TodayBoard | null } = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/orders/today') {
      if (today === null) return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: today ?? { date: '2026-10-12', rows: [] } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 'test-token', refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('两餐都显示：有菜的那餐给菜名与状态，没点菜的那餐明说"还没人点"', async () => {
  mockGet({
    today: {
      date: '2026-10-12',
      rows: [
        row({ meal: 'LUNCH', label: '午餐', dishes: ['番茄炒蛋', '米饭'], dishCount: 2, statusLabel: '待确认' }),
        row({ meal: 'DINNER', label: '晚餐', state: 'none', status: null, statusLabel: '还没人点', dishes: [], dishCount: 0, ordererCount: 0 }),
      ],
    },
  })
  renderToday()

  expect(await screen.findByText('番茄炒蛋 · 米饭')).toBeTruthy()
  // 没点菜的那行要在，且不编内容
  expect(screen.getByText('晚餐')).toBeTruthy()
  /*
   * 「还没人点」这句话在这两处都要出现：菜品那一格（说清没内容）与状态那一行
   * （说清为什么）——所以是 `getAllBy` 而不是 `getBy`。
   * 从前这里能写 `getByText` 只是因为状态行前面有个文字 `●` 把它撑成了"● 还没人点"，
   * 那个点现在是图（2026-10-16），那层偶然的区分也就没了。
   */
  const said = screen.getAllByText('还没人点')
  expect(said.length).toBe(2)
  // 状态行那颗点图要真的在（它承担的可读性信息是"这一餐还没开始"）
  const status = document.querySelector('.today-meals__status.is-none')
  expect(status?.querySelector('img')?.getAttribute('src')).toBe('/img/icons/dot-none.png')
})

it('菜不编造：没有菜的那餐不会出现任何菜名（假数据时代这里是"小米南瓜粥"）', async () => {
  mockGet({
    today: {
      date: '2026-10-12',
      rows: [row({ meal: 'DINNER', label: '晚餐', state: 'none', status: null, statusLabel: '还没人点', dishes: [], dishCount: 0, ordererCount: 0 })],
    },
  })
  renderToday()

  expect(await screen.findByText('晚餐')).toBeTruthy()
  for (const fake of ['小米南瓜粥', '水煮蛋', '红烧排骨', '番茄炒蛋']) {
    expect(screen.queryByText(fake)).toBeNull()
  }
  expect(screen.queryByText('菜单功能待开放')).toBeNull()
  expect(screen.queryByText(/示例/)).toBeNull()
})

it('就餐人数没定时说"还没定"，不显示 0 个人吃', async () => {
  mockGet({ today: { date: '2026-10-12', rows: [row({ dinerCount: null })] } })
  renderToday()

  const status = await screen.findByText(/人数还没定/)
  expect(status.textContent).toContain('待确认')
  expect(screen.queryByText(/0 人吃/)).toBeNull()
})

it('定了人数就显示人数（含没点菜只吃饭的家人，与"几人点了"不是一回事）', async () => {
  mockGet({ today: { date: '2026-10-12', rows: [row({ dinerCount: 4, ordererCount: 1 })] } })
  renderToday()

  expect(await screen.findByText(/4 人吃/)).toBeTruthy()
})

it('有菜的那行整行可点，落到点菜单；没菜的那行不可点（点进去也没东西）', async () => {
  mockGet({
    today: {
      date: '2026-10-12',
      rows: [
        row({ meal: 'LUNCH', label: '午餐' }),
        row({ meal: 'DINNER', label: '晚餐', state: 'none', status: null, statusLabel: '还没人点', dishes: [], dishCount: 0, ordererCount: 0 }),
      ],
    },
  })
  renderToday()

  // 先等数据到位：findAllByRole 会在"顶部的去点菜单 →"出现时就返回，那时行还没渲染出来
  await screen.findByText('番茄炒蛋')
  const links = screen.getAllByRole('link')
  // 有菜的那一行 + 顶部「去点菜单 →」，一共两个；没菜的行不是链接
  expect(links.filter((link) => link.getAttribute('href') === '/order')).toHaveLength(2)
  expect(screen.getByText('晚餐').closest('a')).toBeNull()
  expect(screen.getByText('番茄炒蛋').closest('a')).not.toBeNull()
})

it('成品照张数跟着那一餐显示（F9-08 在这个入口也看得到）', async () => {
  mockGet({ today: { date: '2026-10-12', rows: [row({ status: 'DONE', state: 'settled', statusLabel: '已做好', photoCount: 3 })] } })
  renderToday()

  expect(await screen.findByText(/成品照 3 张/)).toBeTruthy()
})

it('还没加入家庭时给引导，并且不请求今日安排', async () => {
  mockGet({ family: null })
  renderToday()

  expect(await screen.findByText(/建个家、把家里人拉进来/)).toBeTruthy()
  expect(screen.getByRole('link', { name: /去创建或加入家庭/ })).toBeTruthy()
  const get = apiClient.get as unknown as { mock: { calls: unknown[][] } }
  expect(get.mock.calls.some((call) => call[0] === '/orders/today')).toBe(false)
})

it('接口失败时给可重试的提示，不是一片空白', async () => {
  mockGet({ today: null })
  renderToday()

  expect(await screen.findByText('今天的安排暂时打不开')).toBeTruthy()
})
