// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig } from 'axios'
import { apiClient } from '@/api/client'
import type { PlanBoard } from '@/api/orders'
import { useAuth } from '@/stores/auth'
import PrepPage from './PrepPage'

/**
 * 备菜计划（M4 / F4-03）。要盯住的事，每一条都是"看起来对、其实是坑"的地方：
 * ① 看的是**7 天**（接口参数）；只看 3 天的话第 4～7 天根本没有行，等于半个功能；
 * ② 每一行的「加菜」要**带着这一天的日期与餐次**走——不然挑完菜点「想吃这道」时
 *    抽屉默认到"下一餐"，用户以为在排周四、结果加到了今天；
 * ③ `canAdd=false` 的行**不能有「加菜」按钮**：已做好/已取消的餐加不进去，
 *    给个按钮等于让用户白点一次（点下去拿到 400）。
 */

const clients: QueryClient[] = []

/** 把 /recipes 的目的地渲染出来：路由 state 是断言"目标带没带对"的唯一办法 */
function RecipesProbe() {
  const location = useLocation()
  const plan = (location.state as { plan?: { date: string; meal: string; label: string } } | null)?.plan
  return <div data-testid="probe">{plan ? `${plan.date}|${plan.meal}|${plan.label}` : 'no-plan'}</div>
}

function renderPrep() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/prep', state: { from: '/discover' } }]}>
        <Routes>
          <Route path="/prep" element={<PrepPage />} />
          <Route path="/recipes" element={<RecipesProbe />} />
          <Route path="/order" element={<div data-testid="order-page" />} />
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

/** 一行菜（默认是"空着的午餐"，各用例只覆盖自己关心的字段） */
function row(overrides: Partial<PlanBoard['days'][number]['meals'][number]> = {}) {
  return {
    meal: 'LUNCH' as const, label: '午餐', state: 'none' as const, status: null, statusLabel: '还没安排',
    dishes: [], dishCount: 0, ordererCount: 0, dinerCount: null, mealKey: 'x-LUNCH', photoCount: 0, canAdd: true,
    ...overrides,
  }
}

/** 7 天（今天~周日）：只挑几天放内容，其余空着——正是"备菜"要看的形状 */
function planFixture(): PlanBoard {
  return {
    scope: 'family',
    days: [
      {
        date: '2026-10-12', label: '今天', weekday: '周一',
        meals: [
          row({
            meal: 'DINNER', label: '晚餐', state: 'open', status: 'PENDING', statusLabel: '待确认',
            dishes: ['番茄炒蛋', '蒜蓉粉丝蒸虾'], dishCount: 2, ordererCount: 2, dinerCount: 4,
            mealKey: '2026-10-12-DINNER',
          }),
          // 已做好的那一餐**必然留有点单**（不可能是一道菜都没有的"已做好"）——fixture 也照这个来
          row({
            meal: 'LUNCH', label: '午餐', state: 'settled', status: 'DONE', statusLabel: '已做好',
            dishes: ['青菜豆腐汤'], dishCount: 1, ordererCount: 1, mealKey: '2026-10-12-LUNCH', canAdd: false,
          }),
        ],
      },
      {
        date: '2026-10-13', label: '明天', weekday: '周二',
        meals: [row({ mealKey: '2026-10-13-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-13-DINNER' })],
      },
      {
        date: '2026-10-14', label: '后天', weekday: '周三',
        meals: [row({ mealKey: '2026-10-14-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-14-DINNER' })],
      },
      {
        date: '2026-10-15', label: '周四', weekday: '周四',
        meals: [
          row({ mealKey: '2026-10-15-LUNCH' }),
          // 取消的餐同理：先有人点过才会被取消（空餐没法取消）
          row({
            meal: 'DINNER', label: '晚餐', state: 'settled', status: 'CANCELED', statusLabel: '已取消',
            dishes: ['红烧肉'], dishCount: 1, ordererCount: 1, mealKey: '2026-10-15-DINNER', canAdd: false,
          }),
        ],
      },
      { date: '2026-10-16', label: '周五', weekday: '周五', meals: [row({ mealKey: '2026-10-16-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-16-DINNER' })] },
      { date: '2026-10-17', label: '周六', weekday: '周六', meals: [row({ mealKey: '2026-10-17-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-17-DINNER' })] },
      { date: '2026-10-18', label: '周日', weekday: '周日', meals: [row({ mealKey: '2026-10-18-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-18-DINNER' })] },
    ],
  }
}

let planParams: Record<string, unknown> | undefined

/** 取 spy 期望的配置类型本身：自己手写一个更窄的（`{ params?: ... }`）tsc 会判"参数不兼容" */
type GetConfig = AxiosRequestConfig

function mockGet({ plan, family = FAMILY }: { plan: PlanBoard; family?: typeof FAMILY | null } = { plan: planFixture() }) {
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: GetConfig) => {
    if (url === '/family') {
      if (!family) return Promise.reject({ isAxiosError: true, response: { status: 404, data: { message: '还没有加入家庭' } } })
      return Promise.resolve({ data: family } as never)
    }
    if (url === '/orders/plan') {
      planParams = config?.params
      return Promise.resolve({ data: plan } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  planParams = undefined
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('看的是 7 天（只看 3 天的话第 4～7 天根本没有行）', async () => {
  mockGet()
  renderPrep()

  await waitFor(() => expect(planParams?.days).toBe(7))
  // 一天一张卡：7 天 7 张，14 行（不是只把参数发对）
  await waitFor(() => expect(document.querySelectorAll('.prep__day')).toHaveLength(7))
  expect(document.querySelectorAll('.prep__row')).toHaveLength(14)
  // 第 4 天起也真的画出来了（"周四"既是这一天的称呼也是它的星期，所以是两处）
  expect(screen.getAllByText('周四').length).toBe(2)
  expect(document.querySelectorAll('.prep__day-label')[6].textContent).toBe('周日')
})

it('每一行的「加菜」带着这一天的日期与餐次（否则挑完菜会加到"下一餐"去）', async () => {
  mockGet()
  renderPrep()

  // 等 14 行都画出来再点
  await waitFor(() => expect(document.querySelectorAll('.prep__row')).toHaveLength(14))
  const rows = [...document.querySelectorAll('.prep__row')]
  // 12 行能加，2 行不能（今天午餐已做好、周四晚餐已取消）
  expect(rows.filter((row) => row.querySelector('.prep__add'))).toHaveLength(12)

  // 点开「明天晚餐」那一行的「加菜」，落到菜谱页时应带着 2026-10-13 + DINNER
  const tomorrow = rows[3] // 今天 2 行 + 明天午餐 → 明天晚餐是第 4 行
  expect(tomorrow.querySelector('.prep__meal')?.textContent).toBe('晚餐')
  const link = tomorrow.querySelector('.prep__add') as HTMLAnchorElement
  link.click()

  const probe = await screen.findByTestId('probe')
  expect(probe.textContent).toBe('2026-10-13|DINNER|明天晚餐')
})

it('已做好 / 已取消的餐不给「加菜」（点了也是白点，接口会 400）', async () => {
  mockGet()
  renderPrep()

  await waitFor(() => expect(document.querySelectorAll('.prep__row')).toHaveLength(14))
  const locked = [...document.querySelectorAll('.prep__locked')]
  expect(locked).toHaveLength(2)
  // 不能加菜也照样显示状态戳：这一餐到哪一步了，比"能不能加菜"更该让人看见
  expect(locked.map((el) => el.previousElementSibling?.textContent)).toEqual(['已做好', '已取消'])
})

it('空着的行写「还没安排」，有内容的行把真实菜名与人数摆出来', async () => {
  mockGet()
  renderPrep()

  expect(await screen.findByText('番茄炒蛋 · 蒜蓉粉丝蒸虾')).toBeTruthy()
  expect(screen.getByText('4 人吃')).toBeTruthy()
  // 14 行里 3 行有内容（今天午/晚、周四晚），剩下 11 行是空的
  expect(screen.getAllByText('还没安排')).toHaveLength(11)
})

it('汇总说清还剩几餐空着（备菜就是要把这些填上）', async () => {
  mockGet()
  renderPrep()

  // 7 天 14 餐，其中 3 餐已有内容（今天午/晚、周四晚）→ 11 餐空着
  expect(await screen.findByText('7 天共 14 餐，还有 11 餐空着。')).toBeTruthy()
})

it('没加入家庭时给引导，并且不请求备菜接口', async () => {
  const get = mockGet({ plan: planFixture(), family: null })
  renderPrep()

  expect(await screen.findByText(/先创建家庭或用邀请码加入/)).toBeTruthy()
  expect(screen.getByText('去创建或加入家庭')).toBeTruthy()
  expect(get).not.toHaveBeenCalledWith('/orders/plan', expect.anything())
})
