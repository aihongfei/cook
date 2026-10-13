// 读样式文件做断言需要 node 类型：tsconfig.app 的 `types` 只放了 vite/client，
// 所以在文件里显式引入（与 corner-art.test 的写法一致，但不靠 tsconfig 全局包含）。
/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/*
 * 两侧要留出页面边距，且**与标题同一条竖线**（用户 2026-10-13：「我收藏的菜那页…两侧没有间隙」
 * → 修完第一版后又说「和下面的文案没对齐啊，所有页面要统一的」）。
 *
 * 先说清第一版错在哪：我给**容器**加了 `padding-inline`。而 `.pscreen` 里的标题块
 * `.ptitle`/`.psub` 自带 `padding-inline: var(--spacing-page)`，于是标题成了 32px、
 * 内容 16px——标题比正文多缩一格，看着就是"没对齐"。
 *
 * 这页的正确做法与本项目其它页面一致：**横向边距由块自己带**（`.card` 就是这么写的）。
 * 所以这条守住：摘要与网格各自带 `margin … var(--spacing-page)`，
 * 且容器上**没有**横向内边距（加了就会把标题推成双倍缩进）。
 */
it('摘要与网格各自带横向边距，容器不加内边距（否则标题会被推成双倍缩进）', () => {
  const css = readFileSync(join(__dirname, 'favorites.scss'), 'utf8')
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (name: string) => strip(css.match(new RegExp(`\\.${name}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? '')

  for (const name of ['favorites__summary', 'favorites__grid']) {
    const block = rule(name)
    expect(block, `没读到 .${name} 规则`).toBeTruthy()
    expect(block, `.${name} 要自带 var(--spacing-page) 的横向外边距，才能与标题同一条竖线`)
      .toMatch(/margin\s*:[^;]*var\(--spacing-page\)/)
  }

  /*
   * 容器必须**没有**横向内边距：`.ptitle`/`.psub` 已经自带一层，
   * 再给容器加一层就变成 32px（第一版就是这么错的）。
   */
  const page = rule('favorites-page')
  expect(page, '没读到 .favorites-page 规则').toBeTruthy()
  expect(page, '.favorites-page 不能加横向内边距——标题自带一层，加了会双倍缩进')
    .not.toMatch(/padding(-inline)?\s*:\s*[^;]*spacing-page/)
})
