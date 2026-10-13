// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { Family } from '@/api/family'
import { useAuth } from '@/stores/auth'
import { Toaster, useToasts } from '@/components/ui/toast'
import DishCard from './DishCard'

/**
 * 菜谱卡上的「点这道」（F1-10）。判定围绕三件事：
 * ① **一次点击就落进某一餐**，而且要落对——带着「去安排」的目标来就进那一餐，
 *    否则进"下一餐"（不然用户在排后天晚餐，菜却进了今天）；
 * ② **加过就置灰**，同一张卡连点两次不会变成两份；
 * ③ **不能点菜时不画按钮**（没家庭 / 角色没有 order.create），别让人白点一次再收 403。
 */

const clients: QueryClient[] = []

const dish = {
  id: 'tomato', name: '番茄炒蛋', image: null, category: '素菜', cuisine: '家常',
  tags: ['快手'], calories: null, caloriesEstimated: false,
  origin: 'howtocook', sourceLabel: 'HowToCook', mine: false,
}

function familyFixture(overrides: Partial<Family> = {}): Family {
  return {
    id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
    myRole: 'OWNER', myCapabilities: ['order.create', 'menu.manage'], members: [],
    ...overrides,
  }
}

function mount(family: Family | null = familyFixture(), entry: string | { pathname: string; state: unknown } = '/recipes') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/orders/options') {
      return Promise.resolve({
        data: {
          meals: [{ value: 'LUNCH', label: '午餐' }, { value: 'DINNER', label: '晚餐' }],
          statuses: [],
          dayOptions: [
            { value: '2026-10-13', label: '今天' },
            { value: '2026-10-14', label: '明天' },
            { value: '2026-10-15', label: '后天' },
          ],
        },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[entry]}>
        <DishCard dish={dish} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
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

it('一次点击就把菜落进"下一餐"，并说清落到了哪一餐', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: { mealKey: '2026-10-13-DINNER', date: '2026-10-13', meal: 'DINNER', mealLabel: '晚餐' },
  } as never)
  mount()

  fireEvent.click(await screen.findByRole('button', { name: '点这道' }))

  await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/items', expect.objectContaining({ recipeId: 'tomato' })))
  /*
   * 默认落到"下一餐"由 nextMealDefaults 按当前钟点决定（15 点前今晚、之后明天午饭），
   * 所以这里**只断言"日期与餐次都取自后端下发的选项"**，不钉具体是哪一个——
   * 钉了就会在下午变红（R-027 踩过同一个坑）。目标是"一次点击落进某个真实可点的餐次"。
   */
  const sent = post.mock.calls[0][1] as { mealDate: string; meal: string }
  expect(['2026-10-13', '2026-10-14']).toContain(sent.mealDate)
  expect(['LUNCH', 'DINNER']).toContain(sent.meal)
  // 一次点击就写完的动作，必须说清写到哪一餐（否则用户不知道刚才那一下干了什么）
  await waitFor(() => expect(useToasts.getState().items.some((item) => /已加入.*等掌勺人安排/.test(item.text))).toBe(true))
})

it('带着「去安排」的目标进来时，点这道进的是**那一餐**（不是默认的下一餐）', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: { mealKey: '2026-10-15-DINNER', date: '2026-10-15', meal: 'DINNER', mealLabel: '晚餐' },
  } as never)
  // 与本周菜单「去安排」同一条路：路由 state 里带着 plan
  mount(familyFixture(), { pathname: '/recipes', state: { plan: { date: '2026-10-15', meal: 'DINNER', label: '后天晚餐' } } })

  fireEvent.click(await screen.findByRole('button', { name: '点这道' }))

  await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/items', {
    recipeId: 'tomato', mealDate: '2026-10-15', meal: 'DINNER',
  }))
})

it('加过之后变成"已加入"，同一张卡点不了第二次（避免误触变成两份）', async () => {
  vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: { mealKey: '2026-10-13-DINNER', date: '2026-10-13', meal: 'DINNER', mealLabel: '晚餐' },
  } as never)
  mount()

  fireEvent.click(await screen.findByRole('button', { name: '点这道' }))

  expect(await screen.findByText('已加入')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '点这道' })).toBeNull()
})

it('没加入家庭时不画「点这道」（别让人白点一次再收 403）', async () => {
  mount(null)

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '点这道' })).toBeNull()
})

it('角色不能点菜时也不画按钮（能力由后端下发，前端不自己算角色）', async () => {
  mount(familyFixture({ myRole: 'EATER', myCapabilities: [] }))

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '点这道' })).toBeNull()
})

it('失败时报错、且**不**置灰（那一下没成功，用户该能再点一次）', async () => {
  vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('网络断了') as never)
  mount()

  fireEvent.click(await screen.findByRole('button', { name: '点这道' }))

  await waitFor(() => expect(useToasts.getState().items.length).toBeGreaterThan(0))
  expect(screen.getByRole('button', { name: '点这道' })).toBeTruthy()
  expect(screen.queryByText('已加入')).toBeNull()
})

it('卡片本身仍是进详情的链接（加了按钮不该把原来的路挡掉）', async () => {
  mount()

  const link = await screen.findByRole('link', { name: /查看番茄炒蛋菜谱/ })
  expect(link.getAttribute('href')).toBe('/recipes/tomato')
})

/*
 * 那颗心（M1 / F1-09）。卡片自己**不查状态**——状态由父级批量查一次给下来，
 * 所以这里直接以 props 驱动，验"画不画、亮不亮、点了回调没有"。
 */

it('给了收藏回调才画心（没登录时父级不传，别让用户白点一次再收 401）', async () => {
  mount()
  // 上面那些用例没传 onToggleFavorite → 不该有心
  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /收藏/ })).toBeNull()
})

it('已收藏是实心红心、未收藏是空心，且都在链接之外（点了不会进详情页）', async () => {
  const onToggle = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
    if (url === '/family') return Promise.resolve({ data: familyFixture() } as never)
    if (url === '/orders/options') return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [] } } as never)
    throw new Error(`未预期的请求：${url}`)
  }) as never)
  render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <DishCard dish={dish} favorited onToggleFavorite={onToggle} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const heart = await screen.findByRole('button', { name: '取消收藏番茄炒蛋' })
  expect(heart.textContent).toBe('❤')
  expect(heart.getAttribute('aria-pressed')).toBe('true')
  // 心在 <a> 之外：放进去点击会冒泡到链接上，变成"想收藏却进了详情页"
  expect(heart.closest('a')).toBeNull()

  fireEvent.click(heart)
  expect(onToggle).toHaveBeenCalledTimes(1)
})

it('未收藏时是空心 ♡（同一个按钮的两种状态）', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  vi.spyOn(apiClient, 'get').mockImplementation((() => Promise.resolve({ data: null } as never)) as never)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DishCard dish={dish} favorited={false} onToggleFavorite={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const heart = await screen.findByRole('button', { name: '收藏番茄炒蛋' })
  expect(heart.textContent).toBe('♡')
  expect(heart.getAttribute('aria-pressed')).toBe('false')
})
