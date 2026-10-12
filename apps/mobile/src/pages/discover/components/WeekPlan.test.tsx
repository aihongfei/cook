// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { PlanBoard } from '@/api/orders'
import { useAuth } from '@/stores/auth'
import WeekPlan from './WeekPlan'

// 发现页的本周菜单（M4 / F4-02）。要盯住的三件事：
// ① 没安排的餐**也要占一行**（写「还没安排」并给「去安排」）——这块的用处就是找缺口；
// ② 不编内容：真没安排才写「还没安排」，菜名只来自真实点单；
// ③ 「去安排」**带着日期与餐次走**（否则用户要再选一遍，选错了还以为系统记不住）。

const clients: QueryClient[] = []

/** 把 /recipes 的目的地渲染出来，好断言路由 state 真的带到了（只断言链接文字是测不出这个的） */
function RecipesProbe() {
  const location = useLocation()
  const plan = (location.state as { plan?: { date: string; meal: string } } | null)?.plan
  return <div data-testid="probe">{plan ? `${plan.date}|${plan.meal}` : 'no-plan'}</div>
}

function renderWeekPlan({ initial = '/' }: { initial?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<WeekPlan />} />
          <Route path="/recipes" element={<RecipesProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: [], members: [],
}

function mealRow(overrides: Partial<PlanBoard['days'][number]['meals'][number]> = {}) {
  return {
    meal: 'LUNCH' as const, label: '午餐', state: 'none' as const, status: null, statusLabel: '还没安排',
    dishes: [], dishCount: 0, ordererCount: 0, dinerCount: null, mealKey: '2026-10-12-LUNCH', photoCount: 0, canAdd: true,
    ...overrides,
  }
}

function planFixture(): PlanBoard {
  return {
    scope: 'family',
    days: [
      {
        date: '2026-10-12', label: '今天', weekday: '周一',
        meals: [
          mealRow({ meal: 'LUNCH', label: '午餐', state: 'open', status: 'PLANNED', statusLabel: '已安排', dishes: ['番茄炒蛋', '清炒菜心'], dishCount: 2, ordererCount: 1, dinerCount: 3 }),
          mealRow({ meal: 'DINNER', label: '晚餐' }),
        ],
      },
      {
        date: '2026-10-13', label: '明天', weekday: '周二',
        meals: [mealRow({ meal: 'LUNCH', label: '午餐' }), mealRow({ meal: 'DINNER', label: '晚餐' })],
      },
      {
        date: '2026-10-14', label: '后天', weekday: '周三',
        meals: [mealRow({ meal: 'LUNCH', label: '午餐' }), mealRow({ meal: 'DINNER', label: '晚餐' })],
      },
    ],
  }
}

function mockGet({ family = FAMILY as unknown, plan }: { family?: unknown; plan?: PlanBoard | null } = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/orders/plan') {
      if (plan === null) return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: plan ?? planFixture() } as never)
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

it('三天都在，每天午晚两行；没安排的写「还没安排」并给「去安排」', async () => {
  mockGet()
  renderWeekPlan()

  expect(await screen.findByText('番茄炒蛋 · 清炒菜心')).toBeTruthy()
  for (const day of ['今天', '明天', '后天']) expect(screen.getByText(day)).toBeTruthy()
  // 午餐/晚餐各三天 = 6 行
  expect(screen.getAllByText('午餐')).toHaveLength(3)
  expect(screen.getAllByText('晚餐')).toHaveLength(3)
  // 今天午餐有菜、其余 5 行没安排（含今天的晚餐）
  expect(screen.getAllByText('还没安排')).toHaveLength(5)
  expect(screen.getAllByRole('link', { name: '去安排' })).toHaveLength(5)
})

it('安排过的行显示菜名与状态戳，整行点到点菜单；不编假菜名', async () => {
  mockGet()
  renderWeekPlan()

  expect(await screen.findByText('番茄炒蛋 · 清炒菜心')).toBeTruthy()
  expect(screen.getByText('已安排')).toBeTruthy()
  expect(screen.getByText('3 人吃')).toBeTruthy()
  // M0 时代的示例菜（「番茄炒蛋 · 清炒菜心 · 家常米饭」）里的"家常米饭"不该出现：菜名只来自真实点单
  expect(screen.queryByText(/家常米饭/)).toBeNull()
  const planned = screen.getByText('番茄炒蛋 · 清炒菜心').closest('a')
  expect(planned?.getAttribute('href')).toBe('/order')
})

it('「去安排」把日期与餐次带到目的地（不是让用户再选一遍）', async () => {
  mockGet()
  const { container } = renderWeekPlan()
  await screen.findByText('番茄炒蛋 · 清炒菜心')

  // 找到"后天·晚餐"那一行的去安排：按 DOM 顺序第 6 个（今天午/晚、明天午/晚、后天午/晚）
  const links = screen.getAllByRole('link', { name: '去安排' })
  const last = links[links.length - 1] as HTMLAnchorElement
  expect(last.getAttribute('href')).toBe('/recipes')

  // 点它，让路由真的走一遍，看 /recipes 收到什么 state
  last.click()
  expect((await screen.findByTestId('probe')).textContent).toBe('2026-10-14|DINNER')
  expect(container.querySelector('[data-testid="probe"]')).toBeTruthy()
})

it('共享关闭时说明原因（scope=mine）：不然会以为家里真没安排而白安排一顿', async () => {
  mockGet({ plan: { scope: 'mine', days: planFixture().days } })
  renderWeekPlan()

  expect(await screen.findByText(/家里关了共享/)).toBeTruthy()
})

it('还没加入家庭时给引导，并且不请求菜单安排', async () => {
  mockGet({ family: null })
  renderWeekPlan()

  expect(await screen.findByText(/家里人一起点菜，这里就能看到/)).toBeTruthy()
  const get = apiClient.get as unknown as { mock: { calls: unknown[][] } }
  expect(get.mock.calls.some((call) => call[0] === '/orders/plan')).toBe(false)
})

it('接口失败时给可重试的提示，不是一片空白', async () => {
  mockGet({ plan: null })
  renderWeekPlan()

  expect(await screen.findByText('最近几天的安排暂时打不开')).toBeTruthy()
})

// 备菜计划入口（F4-03）：这张卡只看 3 天，排满一周得进备菜计划。
// 盯的是"两个入口都在、且各自指向对的地方"——只剩一个的话，要么排不了整周、
// 要么点了没反应（去点菜单也重要：改状态在那）。
it('卡头给两个出口：备菜计划（排满一周）与去点菜单（改状态）', async () => {
  mockGet()
  renderWeekPlan()

  const prep = await screen.findByRole('link', { name: /备菜计划/ })
  expect(prep.getAttribute('href')).toBe('/prep')
  expect(screen.getByRole('link', { name: /去点菜单/ }).getAttribute('href')).toBe('/order')
})
