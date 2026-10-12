// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { OrderHistory } from '@/api/orders'
import { useAuth } from '@/stores/auth'
import HistoryPage from './HistoryPage'

/**
 * 点单历史与美食日记（F3-09）。它是为 `RISKS.md` R-19 做的：列表只看得到最近 60 张卡
 * （约一个月），更早的点单数据还在库里、界面上看不到。所以这里要盯住：
 * ① **确实按日期区间往前翻**（不是再给一份有上限的列表）；
 * ② 翻下一页时**不能与上一页重叠**（游标挪错一天就会出现重复的日子）；
 * ③ 到头了要说"再往前没有记录了"，而不是让按钮消失得莫名其妙。
 */

const clients: QueryClient[] = []

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/order/history', state: { from: '/order' } }]}>
        <Routes>
          <Route path="/order/history" element={<HistoryPage />} />
          <Route path="/order" element={<div data-testid="order-page" />} />
          <Route path="/family" element={<div data-testid="family-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: ['menu.manage'], members: [],
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    meal: 'LUNCH' as const, label: '午餐', state: 'none' as const, status: null, statusLabel: '没有安排',
    dishes: [], dishCount: 0, ordererCount: 0, dinerCount: null, mealKey: 'x-LUNCH', photoCount: 0, canAdd: true,
    ...overrides,
  }
}

function page(overrides: Partial<OrderHistory> = {}): OrderHistory {
  return {
    scope: 'family',
    from: '2026-09-13',
    to: '2026-10-13',
    pageSize: 31,
    hasMore: false,
    days: [
      {
        date: '2026-10-13', weekday: '周二',
        meals: [
          row({
            meal: 'DINNER', label: '晚餐', state: 'settled', status: 'DONE', statusLabel: '已做好',
            dishes: ['番茄炒蛋'], dishCount: 1, ordererCount: 1, dinerCount: 3,
            mealKey: '2026-10-13-DINNER',
          }),
          row({ mealKey: '2026-10-13-LUNCH' }),
        ],
      },
      {
        date: '2026-10-12', weekday: '周一',
        meals: [row({ mealKey: '2026-10-12-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-12-DINNER' })],
      },
    ],
    ...overrides,
  }
}

function mockGet(handler: (url: string, params?: Record<string, unknown>) => unknown) {
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/family') return Promise.resolve({ data: FAMILY } as never)
    return Promise.resolve({ data: handler(url, config?.params) } as never)
  }) as never)
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 'test-token',
    refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('按天铺开：有记录的那一餐显示菜名、人数与状态，没安排的那格明说"没有安排"', async () => {
  mockGet(() => page())
  renderHistory()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.getByText('3 人吃')).toBeTruthy()
  expect(screen.getByText('已做好')).toBeTruthy()
  // 没安排的那几格也要在（"那天没张罗"本身就是回看时要看的信息）
  expect(screen.getAllByText('没有安排').length).toBeGreaterThan(0)
})

it('页头说清这一页看的是哪一段，并给出有记录的天数', async () => {
  mockGet(() => page())
  renderHistory()

  expect(await screen.findByText(/09-13 ～ 10-13/)).toBeTruthy()
  expect(screen.getByText(/2 天，有记录 1 天/)).toBeTruthy()
})

it('能往前翻：点「再往前一页」要带上一页第一天的**前一天**当新的结束日', async () => {
  const seen: (Record<string, unknown> | undefined)[] = []
  mockGet((_url, params) => {
    seen.push(params)
    if (seen.length === 1) return page({ hasMore: true })
    return page({ from: '2026-08-13', to: '2026-09-12', hasMore: false })
  })
  renderHistory()

  const more = await screen.findByRole('button', { name: /再往前一页/ })
  fireEvent.click(more)

  await waitFor(() => expect(seen.length).toBe(2))
  // 第一页 from=09-13 → 下一页的 to 必须是 09-12（挪一天），否则两页会**重叠一天**
  expect(seen[1]?.to).toBe('2026-09-12')
})

it('翻到第二页会把两页的日子接在一起（不覆盖、不重复）', async () => {
  let call = 0
  mockGet(() => {
    call += 1
    return call === 1
      ? page({ hasMore: true })
      : page({ from: '2026-09-11', to: '2026-09-12', hasMore: false, days: [{ date: '2026-09-12', weekday: '周六', meals: [row({ mealKey: '2026-09-12-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-09-12-DINNER' })] }] })
  })
  renderHistory()

  fireEvent.click(await screen.findByRole('button', { name: /再往前一页/ }))

  // 第一页的 10-13 与第二页的 09-12 都在
  expect(await screen.findByText('2026-09-12')).toBeTruthy()
  expect(screen.getByText('2026-10-13')).toBeTruthy()
})

it('到头了说"再往前没有记录了"，不给一个点不动的按钮', async () => {
  mockGet(() => page({ hasMore: false }))
  renderHistory()

  expect(await screen.findByText('再往前没有记录了。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /再往前一页/ })).toBeNull()
})

it('一条记录都没有：说清楚是"还没有点单记录"，不是页面坏了', async () => {
  mockGet(() => page({ days: [], hasMore: false }))
  renderHistory()

  expect(await screen.findByText('还没有点单记录。')).toBeTruthy()
})

it('有内容的那一格落到点菜单（改状态、看成品照、再点一次都在那边）', async () => {
  mockGet(() => page())
  renderHistory()

  fireEvent.click(await screen.findByText('番茄炒蛋'))
  expect(screen.getByTestId('order-page')).toBeTruthy()
})

it('共享关闭时说明为什么看到的少（不能让人以为家里没张罗）', async () => {
  mockGet(() => page({ scope: 'mine' }))
  renderHistory()

  expect(await screen.findByText(/家里关了共享/)).toBeTruthy()
})

it('没有家庭时给引导，不去撞后端 404', async () => {
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
    if (url === '/family') return Promise.resolve({ data: null } as never)
    throw new Error(`没有家庭时不该请求：${url}`)
  }) as never)
  renderHistory()

  expect(await screen.findByText(/先创建家庭或用邀请码加入/)).toBeTruthy()
})
