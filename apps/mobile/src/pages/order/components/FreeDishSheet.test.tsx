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
import FreeDishSheet from './FreeDishSheet'

// 「自己写一道」（F3-10）：菜谱库里没有的菜也能点。
// 要点：只发 dishName（不发 recipeId——两个都给后端会 400）、菜名去空格后才提交、
// 空菜名时按钮不可点、日期/餐次仍来自后端下发的选项。

const clients: QueryClient[] = []

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <FreeDishSheet visible onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function familyFixture(overrides: Partial<Family> = {}): Family {
  return {
    id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
    myRole: 'EATER', myCapabilities: ['order.create'], members: [],
    ...overrides,
  }
}

function mockGet(family: Family | null) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/orders/options') {
      return Promise.resolve({
        data: {
          meals: [{ value: 'LUNCH', label: '午餐' }, { value: 'DINNER', label: '晚餐' }],
          statuses: [{ value: 'PENDING', label: '待确认' }],
          dayOptions: [
            { value: '2026-10-12', label: '今天' },
            { value: '2026-10-13', label: '明天' },
            { value: '2026-10-14', label: '后天' },
          ],
        },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

function cardFixture(): MealCard {
  return {
    mealKey: '2026-10-12-LUNCH', date: '2026-10-12', meal: 'LUNCH', mealLabel: '午餐',
    status: 'PENDING', statusLabel: '待确认', orderers: ['妈妈'], ordererCount: 1, dishCount: 1,
    dishes: [], items: [], mineCount: 1, dinerCount: null, photoCount: 0,
    confirmedBy: null, confirmedAt: null, canRepeat: false, nextActions: [],
    submittedAt: new Date().toISOString(),
  }
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

it('填菜名提交：只发 dishName（不发 recipeId），日期餐次用选中的', async () => {
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture() } as never)
  renderSheet()

  fireEvent.change(await screen.findByPlaceholderText('如：外婆的糖醋小排'), {
    target: { value: '外婆的糖醋小排' },
  })
  fireEvent.change(screen.getByPlaceholderText('如：小满那份不要辣'), { target: { value: '少放糖' } })
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/items', {
      dishName: '外婆的糖醋小排',
      mealDate: '2026-10-12',
      meal: 'LUNCH',
      note: '少放糖',
    }),
  )
  // 关键：请求体里**不能有 recipeId**（两个都给后端 400，见 orders.rules 的 parseItemTarget）
  const body = (post.mock.calls[0][1] as Record<string, unknown>)
  expect('recipeId' in body).toBe(false)
  expect(await screen.findByText('已把「外婆的糖醋小排」加进今天午餐')).toBeTruthy()
})

it('菜名去首尾空格后才提交（免得"  红烧肉 "在卡片上带着空格）', async () => {
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture() } as never)
  renderSheet()

  fireEvent.change(await screen.findByPlaceholderText('如：外婆的糖醋小排'), {
    target: { value: '  外婆的糖醋小排  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/items', expect.objectContaining({ dishName: '外婆的糖醋小排' })),
  )
})

it('菜名为空或只有空白时按钮不可点（不让用户提交一个注定被拒的请求）', async () => {
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture() } as never)
  renderSheet()

  const submit = (await screen.findByRole('button', { name: '加进点菜单' })) as HTMLButtonElement
  expect(submit.disabled).toBe(true)

  fireEvent.change(screen.getByPlaceholderText('如：外婆的糖醋小排'), { target: { value: '   ' } })
  expect(submit.disabled).toBe(true)
  expect(post).not.toHaveBeenCalled()

  fireEvent.change(screen.getByPlaceholderText('如：外婆的糖醋小排'), { target: { value: '蛋炒饭' } })
  expect(submit.disabled).toBe(false)
})

it('换一天换一餐按新选择提交（选项来自后端下发，不是硬编码）', async () => {
  mockGet(familyFixture())
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture() } as never)
  renderSheet()

  await screen.findByPlaceholderText('如：外婆的糖醋小排')
  expect(screen.getByRole('button', { name: '后天' })).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('如：外婆的糖醋小排'), { target: { value: '番茄鸡蛋面' } })
  fireEvent.click(screen.getByRole('button', { name: '后天' }))
  fireEvent.click(screen.getByRole('button', { name: '晚餐' }))
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/orders/items',
      expect.objectContaining({ dishName: '番茄鸡蛋面', mealDate: '2026-10-14', meal: 'DINNER' }),
    ),
  )
})

it('没加入家庭时给引导，不显示填写表单', async () => {
  mockGet(null)
  renderSheet()

  expect(await screen.findByText('点菜是给家里人看的。先创建家庭或用邀请码加入，再写这道菜。')).toBeTruthy()
  expect(screen.queryByPlaceholderText('如：外婆的糖醋小排')).toBeNull()
})

it('角色不能点菜时说清楚（后端同样会 403，前端只是提前告知）', async () => {
  mockGet(familyFixture({ myCapabilities: [] }))
  renderSheet()

  expect(await screen.findByText('你在家里的角色暂时不能点菜，让掌勺人看看你的角色。')).toBeTruthy()
})

it('后端拒绝时把话术显示出来（如菜名超长、这餐已安排）', async () => {
  mockGet(familyFixture())
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true,
    response: { status: 400, data: { message: '菜名最多 30 个字' } },
  } as never)
  renderSheet()

  fireEvent.change(await screen.findByPlaceholderText('如：外婆的糖醋小排'), { target: { value: '蛋炒饭' } })
  fireEvent.click(screen.getByRole('button', { name: '加进点菜单' }))
  expect(await screen.findByText('菜名最多 30 个字')).toBeTruthy()
})
