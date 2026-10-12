// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { FavoriteBoard } from '@/api/favorites'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import FavoritesPage from './FavoritesPage'

/**
 * 我收藏的菜（M1 / F1-09）。要盯住的事：
 * ① **收藏是私人的**：这一页不要求加入家庭（与点单/打卡不同）——没家庭的人也该能看自己的收藏；
 * ② **取消收藏就地做掉 + 给一句提示**（不弹二次确认：成本对称，再点一下就能收回来）；
 * ③ **到上限要说清楚**，别让用户点到失败才知道。
 */

const clients: QueryClient[] = []

function board(overrides: Partial<FavoriteBoard> = {}): FavoriteBoard {
  return {
    items: [
      {
        id: 'tomato', name: '番茄炒蛋', image: null, category: '素菜', cuisine: '家常',
        tags: [], calories: 180, caloriesEstimated: true, favoritedAt: new Date().toISOString(),
      },
      {
        id: 'ribs', name: '红烧排骨', image: null, category: '荤菜', cuisine: '家常',
        tags: [], calories: null, caloriesEstimated: false, favoritedAt: new Date().toISOString(),
      },
    ],
    total: 2,
    limit: 200,
    ...overrides,
  }
}

function mount(data: FavoriteBoard = board()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data } as never)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[{ pathname: '/favorites', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/recipes" element={<div data-testid="recipes-page" />} />
          <Route path="/recipes/:id" element={<div data-testid="detail-page" />} />
        </Routes>
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

it('列出收藏的菜与总数', async () => {
  mount()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.getByText('红烧排骨')).toBeTruthy()
  expect(screen.getByText(/共 2 道/)).toBeTruthy()
  // 热量口径与菜谱卡一致（估算要标出来，没有的不造数）
  expect(screen.getByText('约 180 千卡（估算）')).toBeTruthy()
  expect(screen.getByText('热量暂无')).toBeTruthy()
})

it('取消收藏就地做掉：点一下发请求并提示，不弹二次确认', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { favorited: false, total: 1 } } as never)
  mount()

  fireEvent.click(await screen.findByRole('button', { name: '取消收藏番茄炒蛋' }))

  await waitFor(() => expect(post).toHaveBeenCalledWith('/favorites/toggle', { recipeId: 'tomato' }))
  await waitFor(() => expect(useToasts.getState().items.some((item) => /已取消收藏「番茄炒蛋」/.test(item.text))).toBe(true))
  // 没有确认弹窗（dialog 不该出现）
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('点卡片进详情（收藏页的用途是"想起来做什么"）', async () => {
  mount()

  fireEvent.click(await screen.findByText('番茄炒蛋'))
  expect(screen.getByTestId('detail-page')).toBeTruthy()
})

it('一条都没有时给空态与去路（而不是一片空白）', async () => {
  mount(board({ items: [], total: 0 }))

  expect(await screen.findByText('还没有收藏的菜')).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: '去菜谱小书看看' }))
  expect(screen.getByTestId('recipes-page')).toBeTruthy()
})

it('收藏满了要说清楚"想收新的先取消一道"（别让人点到失败才知道）', async () => {
  mount(board({ limit: 2 }))

  expect(await screen.findByText(/收藏满了，想收新的先取消一道/)).toBeTruthy()
})

it('这一页**不要求加入家庭**（收藏是私人偏好，与家庭共享无关）', async () => {
  mount()

  // 没有任何"去创建家庭"的引导，菜直接显示出来
  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.queryByText(/先创建家庭/)).toBeNull()
})
