// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { MealCard } from '@/api/orders'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import DinerCountSheet from './DinerCountSheet'

// 就餐人数（M4 / F4-05）。三个要点：
// ① 初值合理（没定过就用"几人点了"起底，不用让人从 0 开始按）；
// ② 不产生 0 人（0 个人吃饭没有意义，改不了就用"清除"）；
// ③ 清除走 null，不是 0（后端也这样约定）。

const clients: QueryClient[] = []

function cardFixture(overrides: Partial<MealCard> = {}): MealCard {
  return {
    mealKey: '2026-10-12-DINNER',
    date: '2026-10-12',
    meal: 'DINNER',
    mealLabel: '晚餐',
    status: 'PENDING',
    statusLabel: '待确认',
    orderers: ['妈妈', '小满'],
    ordererCount: 2,
    dishCount: 3,
    dishes: [],
    items: [],
    mineCount: 1,
    dinerCount: null,
    photoCount: 0,
    confirmedBy: null,
    confirmedAt: null,
    canRepeat: false,
    nextActions: [],
    submittedAt: new Date().toISOString(),
    ...overrides,
  }
}

function renderSheet(card = cardFixture(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <DinerCountSheet card={card} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { view, onClose }
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
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

it('没定过人数时用"几人点了"当初值（多数家庭直接确认就行）', () => {
  renderSheet(cardFixture({ dinerCount: null, ordererCount: 2 }))
  expect((screen.getByLabelText('就餐人数') as HTMLInputElement).value).toBe('2')
})

it('定过人数就显示当前值，并且给"清除设定"的入口', () => {
  renderSheet(cardFixture({ dinerCount: 5 }))
  expect((screen.getByLabelText('就餐人数') as HTMLInputElement).value).toBe('5')
  expect(screen.getByRole('button', { name: '清除人数设定' })).toBeTruthy()
})

it('没定过时不出现"清除"（没有东西可清，多一个按钮只会让人犹豫）', () => {
  renderSheet(cardFixture({ dinerCount: null }))
  expect(screen.queryByRole('button', { name: '清除人数设定' })).toBeNull()
})

it('加减按钮能改人数，且减不到 0（0 个人吃饭没有意义）', () => {
  renderSheet(cardFixture({ dinerCount: 1 }))
  const minus = screen.getByRole('button', { name: '少一个人' }) as HTMLButtonElement
  expect(minus.disabled).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: '多一个人' }))
  expect((screen.getByLabelText('就餐人数') as HTMLInputElement).value).toBe('2')
  expect(minus.disabled).toBe(false)

  fireEvent.click(minus)
  expect((screen.getByLabelText('就餐人数') as HTMLInputElement).value).toBe('1')
  expect(minus.disabled).toBe(true)
})

it('手输非数字被过滤掉，且 0 或超上限时提交键禁用并给出理由', () => {
  renderSheet()
  const input = screen.getByLabelText('就餐人数') as HTMLInputElement

  fireEvent.change(input, { target: { value: '3人' } })
  expect(input.value).toBe('3')

  fireEvent.change(input, { target: { value: '0' } })
  expect((screen.getByRole('button', { name: '就这么多人' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('填 1～50 之间的整数')).toBeTruthy()

  fireEvent.change(input, { target: { value: '999' } })
  expect((screen.getByRole('button', { name: '就这么多人' }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.change(input, { target: { value: '6' } })
  expect((screen.getByRole('button', { name: '就这么多人' }) as HTMLButtonElement).disabled).toBe(false)
})

it('提交把人数发到那一餐的接口，成功后提示并关抽屉', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture({ dinerCount: 6 }) } as never)
  const { onClose } = renderSheet()

  fireEvent.change(screen.getByLabelText('就餐人数'), { target: { value: '6' } })
  fireEvent.click(screen.getByRole('button', { name: '就这么多人' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-12-DINNER/diners', { dinerCount: 6 }),
  )
  expect(await screen.findByText('这餐按 6 人算')).toBeTruthy()
  // onClose 要**等**：现在收起会先播完退场动画（见 BottomSheet），不是点完立刻回调。
  // 直接断言的话是"跑得快就绿"的竞态（并行跑全量时真红过一次）
  await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 })
})

it('清除发 null 而不是 0（0 会被后端拒，也容易被误当成"0 个人"）', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: cardFixture({ dinerCount: null }) } as never)
  renderSheet(cardFixture({ dinerCount: 4 }))

  fireEvent.click(screen.getByRole('button', { name: '清除人数设定' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/orders/meals/2026-10-12-DINNER/diners', { dinerCount: null }),
  )
  expect(await screen.findByText('已清除人数设定')).toBeTruthy()
})

it('后端拒绝时把话术显示出来（如人数超限），抽屉不关', async () => {
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true,
    response: { status: 400, data: { message: '就餐人数要在 1～50 之间' } },
  } as never)
  const { onClose } = renderSheet()

  fireEvent.click(screen.getByRole('button', { name: '就这么多人' }))

  expect(await screen.findByText('就餐人数要在 1～50 之间')).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
})

/*
 * 连点两次「＋」要加 2。
 *
 * 这条必须把两次点击放进**同一个 `act()`**：testing-library 的 `fireEvent` 每次都会 flush，
 * 分开写的话闭包值已经是新的，测试会假绿（我第一版就是这么写的，反证时没变红才发现）。
 * 同一个 act 里两次点击等于 React 的一批更新——这正是闭包写法出错的地方
 * （第二次读到的是上一次的 parsed，结果只加 1）。真机上手快连点也是这个形状。
 */
it('同一批里连点两次「＋」要加 2（闭包写法只会加 1）', () => {
  renderSheet(cardFixture({ dinerCount: 1 }))
  const plus = screen.getByRole('button', { name: '多一个人' }) as HTMLButtonElement

  act(() => {
    plus.click()
    plus.click()
  })

  expect((screen.getByLabelText('就餐人数') as HTMLInputElement).value).toBe('3')
})

it('同一批里连点两次「−」减 2，且停在 1 不会变 0', () => {
  renderSheet(cardFixture({ dinerCount: 3 }))
  const minus = screen.getByRole('button', { name: '少一个人' }) as HTMLButtonElement

  act(() => {
    minus.click()
    minus.click()
  })

  expect((screen.getByLabelText('就餐人数') as HTMLInputElement).value).toBe('1')
})

