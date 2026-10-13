// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { MealCard } from '@/api/orders'
import type { MealPreview } from '@/api/shopping'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import ConfirmMenuSheet from './ConfirmMenuSheet'

/**
 * 「这一餐要买什么」（F7-06，用户 2026-10-14 报的第二件事）。
 *
 * 用户的原话：「订单那边如果冰箱中配料不齐给个提示，是否加入采购清单这样的，
 * 不要直接加到清单中」。三件事要钉死：
 *
 * ① 缺口**要在定这一餐之前**看得见（原来只能定完再去清单页翻——而那时菜单已经锁了）；
 * ② **只提示，不写库**：这一屏一个写请求都不该发（"要不要买"是用户自己的事）；
 * ③ 拿不到预览不能拦住"就这些，定了"——那一块只是顺带看一眼的信息。
 */

const clients: QueryClient[] = []

function cardFixture(overrides: Partial<MealCard> = {}): MealCard {
  return {
    mealKey: '2026-10-14-DINNER',
    date: '2026-10-14',
    meal: 'DINNER',
    mealLabel: '晚餐',
    status: 'PENDING',
    statusLabel: '待确认',
    orderers: ['妈妈'],
    ordererCount: 1,
    dishCount: 1,
    dishes: [{ recipeId: 'r1', name: '鱼香肉丝', image: null, count: 1, notes: [], mineItemIds: [] }],
    items: [],
    mineCount: 1,
    dinerCount: 2,
    photoCount: 0,
    confirmedBy: null,
    confirmedAt: null,
    canRepeat: false,
    nextActions: [],
    submittedAt: new Date().toISOString(),
    ...overrides,
  }
}

function previewFixture(overrides: Partial<MealPreview> = {}): MealPreview {
  return {
    mealKey: '2026-10-14-DINNER',
    date: '2026-10-14',
    meal: 'DINNER',
    mealLabel: '晚餐',
    status: 'PENDING',
    dishCount: 1,
    missing: [],
    toBuy: [
      { name: '青辣椒', amount: '2个', stockLabel: null },
      { name: '猪里脊', amount: '200g', stockLabel: null },
    ],
    covered: [{ name: '生抽', amount: '适量', stockLabel: '家里有 半瓶，够不够看一眼' }],
    toBuyCount: 2,
    coveredCount: 1,
    unsureCount: 1,
    stockEmpty: false,
    ...overrides,
  }
}

/** 记录下这一屏发过的所有请求，用来断言"只读、不写" */
function mockApi(preview: MealPreview | 'error') {
  const calls: { method: string; url: string }[] = []
  for (const method of ['get', 'post', 'patch', 'delete'] as const) {
    vi.spyOn(apiClient, method).mockImplementation((url: string) => {
      calls.push({ method, url })
      if (url === '/shopping-list/preview') {
        return preview === 'error'
          ? Promise.reject(new Error('这一餐还没有人点菜'))
          : Promise.resolve({ data: preview } as never)
      }
      // 真的点「就这些，定了」时才该走到这里
      if (url.includes('/status')) return Promise.resolve({ data: cardFixture({ status: 'PLANNED' }) } as never)
      throw new Error(`未预期的请求：${method} ${url}`)
    })
  }
  return calls
}

let lastPath = ''

function PathSpy() {
  const location = useLocation()
  lastPath = `${location.pathname}`
  return null
}

function renderSheet(card = cardFixture(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={['/order']}>
        {/* PathSpy 挂在 Routes **外面**：挂在 /order 里的话，一跳到 /shopping 它就卸载了，
            记下的永远是离开前那一页——第一版就是这么写的，断言「expected '/order' to be '/shopping'」 */}
        <PathSpy />
        <Routes>
          <Route
            path="/order"
            element={<ConfirmMenuSheet card={card} onClose={onClose} onAdjustDiners={vi.fn()} />}
          />
          <Route path="/shopping" element={<h1>采购清单页</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  lastPath = ''
  useToasts.setState({ items: [] })
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

it('汇总页上就能看到这一餐要买什么（不用先定下来才知道）', async () => {
  mockApi(previewFixture())
  renderSheet()

  expect(await screen.findByText('这一餐要买')).toBeTruthy()
  expect(screen.getByText('2 样')).toBeTruthy()
  expect(screen.getByText(/青辣椒/)).toBeTruthy()
  expect(screen.getByText(/猪里脊/)).toBeTruthy()
  // 家里已经有的那几样要说出来（否则用户以为全都要买）
  expect(screen.getByText(/家里已有 1 样/)).toBeTruthy()
})

it('**只提示，不写库**：打开这一屏不该有任何写请求', async () => {
  const calls = mockApi(previewFixture())
  renderSheet()

  await screen.findByText('这一餐要买')
  // 只读一次预览，别的什么都没发——"要不要买"是用户自己的决定（D-039）
  expect(calls.filter((call) => call.method !== 'get')).toEqual([])
  expect(calls.filter((call) => call.url === '/shopping-list/preview')).toHaveLength(1)
})

it('冰箱里一条都没记时说清原因（否则"不用买"看着像功能没用）', async () => {
  mockApi(previewFixture({ stockEmpty: true, covered: [], coveredCount: 0, unsureCount: 0 }))
  renderSheet()

  expect(await screen.findByText(/记一下冰箱里有什么/)).toBeTruthy()
})

it('都有就不用买，也要说一句（而不是画一个空块）', async () => {
  mockApi(previewFixture({ toBuy: [], toBuyCount: 0, coveredCount: 3, unsureCount: 0 }))
  renderSheet()

  expect(await screen.findByText('不用买')).toBeTruthy()
  expect(screen.getByText('冰箱里都有，直接做就行。')).toBeTruthy()
})

it('算不出配料表的菜要说出来（否则用户以为"要买的就是这些"）', async () => {
  mockApi(previewFixture({ missing: ['自由菜品：昨天的乱炖'] }))
  renderSheet()

  expect(await screen.findByText(/没写配料表/)).toBeTruthy()
  expect(screen.getByText(/昨天的乱炖/)).toBeTruthy()
})

it('拿不到预览时不画那一块，也不拦住「就这些，定了」', async () => {
  mockApi('error')
  renderSheet()

  // 主流程那个按钮必须在、必须能点（这只是一块顺带看的信息）
  const submit = await screen.findByRole('button', { name: '就这些，定了' })
  expect(screen.queryByText('这一餐要买')).toBeNull()
  fireEvent.click(submit)
  await waitFor(() => expect(apiClient.post).toHaveBeenCalled())
})

it('「去采购清单看看」把人送到清单页（不去别处）', async () => {
  mockApi(previewFixture())
  renderSheet()

  fireEvent.click(await screen.findByRole('button', { name: /去采购清单看看/ }))
  await waitFor(() => expect(lastPath).toBe('/shopping'))
})
