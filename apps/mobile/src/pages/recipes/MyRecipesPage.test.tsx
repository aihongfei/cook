// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AxiosError, type AxiosRequestConfig } from 'axios'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { RecipeSummary } from '@/api/recipes'
import { useAuth } from '@/stores/auth'
import MyRecipesPage from './MyRecipesPage'

/**
 * 我的菜谱（F1-12）。要盯住的事：
 * ① **只问自己家的**——列表请求必须带 `mine=1`（不带就把整个库拉回来了）；
 * ② 卡片上认得出"这是自己上传的"（与库里导入的区分开，这正是用户提的那句）；
 * ③ 一条都没有时**给下一步**（这一页的价值就是往里加第一道菜），不是一片空白；
 * ④ 打不开时能重试。
 */

const clients: QueryClient[] = []

const own: RecipeSummary = {
  id: 'own-1', name: '外婆的红烧肉', image: null, category: '荤菜', cuisine: '家常',
  tags: ['下饭'], calories: 480, caloriesEstimated: false,
  origin: 'user', sourceLabel: '自己上传', mine: true,
}

function requestParams(config: AxiosRequestConfig | undefined): Record<string, unknown> {
  return (config?.params ?? {}) as Record<string, unknown>
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
          <Route path="/recipes/new" element={<div data-testid="form-page" />} />
          <Route path="/recipes/:id" element={<div data-testid="detail-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 菜谱接口之外的请求（卡片里的家庭/点餐选项）也得有回应，否则 hook 会吃着垃圾跑 */
function mockGet(items: RecipeSummary[] | null, total = items?.length ?? 0) {
  return vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    if (url === '/recipes') {
      if (items === null) throw new AxiosError('offline', 'ERR_NETWORK')
      return { data: { items, total, page: 1, pageSize: 12 } }
    }
    if (url === '/orders/options') return { data: { meals: [], statuses: [], dayOptions: [] } }
    if (url === '/family') return { data: null }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useAuth.getState().clear()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('只拉自己家上传的那些（请求带 mine=1），并把「自己上传」标在卡片上', async () => {
  const get = mockGet([own])
  mount()

  expect(await screen.findByText('外婆的红烧肉')).toBeTruthy()
  expect(get.mock.calls.some(([url, config]) => url === '/recipes' && requestParams(config).mine === 1)).toBe(true)
  expect(screen.getByText('自己上传').className).toContain('origin-badge--mine')
  expect(screen.getByText('共 1 道')).toBeTruthy()
})

it('卡片点进详情', async () => {
  mockGet([own])
  mount()

  fireEvent.click(await screen.findByText('外婆的红烧肉'))
  expect(screen.getByTestId('detail-page')).toBeTruthy()
})

it('顶部「＋ 新建菜谱」与空态里的入口都去 `/recipes/new`', async () => {
  mockGet([])
  mount()

  expect(await screen.findByText('还没有自己上传的菜谱')).toBeTruthy()
  expect(screen.getByText('共 0 道')).toBeTruthy()
  // 顶部那个入口在列表为空时也得在（不能因为空了就找不到入口）
  expect(screen.getByRole('link', { name: '＋ 新建菜谱' }).getAttribute('href')).toBe('/recipes/new')
  // 空态自己那条同时给出"下一步"
  fireEvent.click(screen.getByRole('link', { name: '写下第一道菜' }))
  expect(screen.getByTestId('form-page')).toBeTruthy()
})

it('取回来之前先说一声"正在找"，不闪一个"还没有自己上传的菜谱"（那是假空态）', async () => {
  let resolve!: (value: unknown) => void
  vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    if (url === '/recipes') return new Promise((done) => { resolve = done })
    if (url === '/orders/options') return { data: { meals: [], statuses: [], dayOptions: [] } }
    if (url === '/family') return { data: null }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
  mount()

  expect(screen.getByText('正在找你自己传的菜…')).toBeTruthy()
  expect(screen.queryByText('还没有自己上传的菜谱')).toBeNull()

  resolve({ data: { items: [own], total: 1, page: 1, pageSize: 12 } })
  expect(await screen.findByText('外婆的红烧肉')).toBeTruthy()
  expect(screen.queryByText('正在找你自己传的菜…')).toBeNull()
})

it('打不开时报错并能重试（重试后拿到真数据）', async () => {
  let broken = true
  vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    if (url === '/recipes') {
      if (broken) throw new AxiosError('offline', 'ERR_NETWORK')
      return { data: { items: [own], total: 1, page: 1, pageSize: 12 } }
    }
    if (url === '/orders/options') return { data: { meals: [], statuses: [], dayOptions: [] } }
    if (url === '/family') return { data: null }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
  mount()

  expect(await screen.findByText('暂时连不上厨房，请检查网络后重试。')).toBeTruthy()
  broken = false
  fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
  expect(await screen.findByText('外婆的红烧肉')).toBeTruthy()
})

it('顶部「＋ 新建菜谱」始终在（不能因为列表空了/加载中就找不到入口）', async () => {
  mockGet([])
  mount()

  const link = screen.getByRole('link', { name: '＋ 新建菜谱' })
  expect(link.getAttribute('href')).toBe('/recipes/new')
  fireEvent.click(link)
  await waitFor(() => expect(screen.getByTestId('form-page')).toBeTruthy())
})
