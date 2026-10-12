// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { Family } from '@/api/family'
import type { MealCard } from '@/api/orders'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import OrderDishSheet from './OrderDishSheet'

// 点菜抽屉（F3-01/05）：把菜加进「某天某餐」。
// 要点：日期/餐次由后端下发（前端不硬编码）、默认选下一餐、没家庭时给引导而不是失败。

const clients: QueryClient[] = []

function renderSheet(preset?: { date: string; meal: 'LUNCH' | 'DINNER'; label: string } | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <OrderDishSheet visible recipeId="r1" recipeName="番茄炒蛋" preset={preset} onClose={() => {}} />
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
    myRole: 'EATER',
    myCapabilities: ['order.create'],
    members: [],
    ...overrides,
  }
}

function mockGet(family: Family | null) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
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
  vi.useRealTimers()
})

it('日期与餐次选项来自接口（前端不硬编码），默认选中下一餐', async () => {
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  renderSheet()

  expect(await screen.findByRole('button', { name: '今天' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '明天' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '午餐' })).toBeTruthy()
  // 上午 10 点 → 下一餐是今天的晚饭
  const dinner = screen.getByRole('button', { name: '晚餐' })
  expect(dinner.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '今天' }).getAttribute('aria-pressed')).toBe('true')
})

it('提交把菜谱、日期、餐次与备注一起发给后端，并提示加到了哪一餐', async () => {
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: {
      mealKey: '2026-10-12-DINNER',
      date: '2026-10-12',
      mealLabel: '晚餐',
    } as unknown as MealCard,
  } as never)
  renderSheet()

  fireEvent.change(await screen.findByPlaceholderText('如：小满那份不要辣'), {
    target: { value: '小满那份不要辣' },
  })
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/items', {
      recipeId: 'r1',
      mealDate: '2026-10-12',
      meal: 'DINNER',
      note: '小满那份不要辣',
    }),
  )
  expect(await screen.findByText('已加入今天晚餐，等掌勺人安排')).toBeTruthy()
})

it('备注留空时不传 note（后端按"没填"处理，而不是存一个空串）', async () => {
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: {
      mealKey: '2026-10-12-DINNER',
      date: '2026-10-12',
      mealLabel: '晚餐',
    } as unknown as MealCard,
  } as never)
  renderSheet()

  fireEvent.click(await screen.findByRole('button', { name: '加进点菜单' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/orders/items',
      expect.objectContaining({ note: undefined }),
    ),
  )
})

it('换一天/换一餐时按新选择提交', async () => {
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: {
      mealKey: '2026-10-13-LUNCH',
      date: '2026-10-13',
      mealLabel: '午餐',
    } as unknown as MealCard,
  } as never)
  renderSheet()

  fireEvent.click(await screen.findByRole('button', { name: '明天' }))
  fireEvent.click(screen.getByRole('button', { name: '午餐' }))
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/orders/items',
      expect.objectContaining({ mealDate: '2026-10-13', meal: 'LUNCH' }),
    ),
  )
  expect(await screen.findByText('已加入明天午餐，等掌勺人安排')).toBeTruthy()
})

it('没加入家庭时给引导，不显示提交按钮（不让人点下去撞错误）', async () => {
  mockGet(null)
  renderSheet()

  expect(
    await screen.findByText('点菜是给家里人看的。先创建家庭或用邀请码加入，再回来点这道菜。'),
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: '加进点菜单' })).toBeNull()
})

it('后端拒绝时把话术显示出来（如这餐已安排、备注超长）', async () => {
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true,
    response: { status: 409, data: { message: '这餐已经「已安排」了，想加菜先取消这餐' } },
  } as never)
  renderSheet()

  fireEvent.click(await screen.findByRole('button', { name: '加进点菜单' }))
  expect(await screen.findByText('这餐已经「已安排」了，想加菜先取消这餐')).toBeTruthy()
})

// ---------- 从本周菜单来（F4-02）：preset 预设 ----------

it('本周菜单带的 preset 会预选到那一餐（哪怕当前时间默认是别的餐次）', async () => {
  // 上午 10 点，默认下一餐是"今天晚餐"；preset 指定明天午餐，必须盖过默认值
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  renderSheet({ date: '2026-10-13', meal: 'LUNCH', label: '明天午餐' })

  expect(await screen.findByRole('button', { name: '明天' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '明天' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '午餐' }).getAttribute('aria-pressed')).toBe('true')
  // 说明从哪来，别让人以为默认值错了
  expect(screen.getByText(/从「本周菜单」来的/)).toBeTruthy()
})

it('preset 的日期已过期（不在当下可选范围）时，回落到"下一餐"默认，不预选一个提交必被拒的日期', async () => {
  // 场景：昨天在后天那一行点了「去安排」，今天才点「想吃这道」——那时 target.date 已经过期
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  renderSheet({ date: '2026-10-11', meal: 'LUNCH', label: '昨天午餐' })

  expect(await screen.findByRole('button', { name: '今天' })).toBeTruthy()
  // 过期的那天不在选项里，预选必须落回默认（上午 10 点 → 今天晚餐）
  expect(screen.getByRole('button', { name: '今天' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '晚餐' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByText(/从「本周菜单」来的/)).toBeNull()

  // 而且提交出去的日期是当下有效的那个（不是过期日期）
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { mealKey: 'x', date: '2026-10-12', mealLabel: '晚餐' } as unknown as MealCard } as never)
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/items', expect.objectContaining({ mealDate: '2026-10-12', meal: 'DINNER' })),
  )
})

it('preset 之后用户仍能改到别的餐次（预选只是默认值，不是锁死）', async () => {
  vi.setSystemTime(new Date('2026-10-12T10:00:00'))
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: { mealKey: '2026-10-12-DINNER', date: '2026-10-12', mealLabel: '晚餐' } as unknown as MealCard,
  } as never)
  renderSheet({ date: '2026-10-13', meal: 'LUNCH', label: '明天午餐' })

  fireEvent.click(await screen.findByRole('button', { name: '今天' }))
  fireEvent.click(screen.getByRole('button', { name: '晚餐' }))
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/items', expect.objectContaining({ mealDate: '2026-10-12', meal: 'DINNER' })),
  )
})
