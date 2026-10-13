/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AxiosError, type AxiosRequestConfig } from 'axios'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { RecipeSummary } from '@/api/recipes'
import { useRecipeFilters } from '@/stores/recipe-filters'
import RecipeListPage from './RecipeListPage'
import RecipeDetailPage from './RecipeDetailPage'

vi.mock('@/components/ui/FilterTabs', () => ({
  default: ({ items, activeKey, onChange }: { items: { key: string; title: string }[]; activeKey: string; onChange: (key: string) => void }) =>
    <div>{items.map((item) => <button key={item.key} aria-pressed={activeKey === item.key} onClick={() => onChange(item.key)}>{item.title}</button>)}</div>,
}))

const dish: RecipeSummary = { id: 'tomato', name: '番茄炒蛋', image: null, category: '素菜', cuisine: '家常', tags: ['快手'], calories: null, caloriesEstimated: false }
const filters = { categories: ['素菜', '荤菜'], cuisines: ['家常', '川菜'] }
const clients: QueryClient[] = []

function requestParams(config: AxiosRequestConfig | undefined): Record<string, unknown> {
  return (config?.params ?? {}) as Record<string, unknown>
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function mount(entry = '/recipes') {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/recipes" element={<RecipeListPage />} />
    <Route path="/recipes/:id" element={<RecipeDetailPage />} />
  </Routes><LocationProbe /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useRecipeFilters.getState().reset()
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()) })

function mockList(items: RecipeSummary[] = [dish], total = items.length) {
  return vi.spyOn(apiClient, 'get').mockImplementation(async (url) => ({
    data: url === '/recipes/filters' ? filters : { items, total, page: 1, pageSize: 12 },
  }))
}

describe('recipe browsing states', () => {
  it('debounces typing, retains focus and both filters, and never persists the keyword', async () => {
    const get = mockList()
    mount('/recipes?category=素菜&cuisine=家常')
    await screen.findByText('番茄炒蛋')
    const input = screen.getByRole('searchbox') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '鸡蛋 & 葱' } })
    expect(document.activeElement).toBe(input)
    expect(get.mock.calls.some(([, config]) => requestParams(config)?.q)).toBe(false)
    await waitFor(() => expect(get.mock.calls.some(([, config]) => requestParams(config)?.q === '鸡蛋 & 葱')).toBe(true))
    expect(document.activeElement).toBe(input)
    const location = new URL(screen.getByTestId('location').textContent!, 'http://localhost')
    expect(location.searchParams.get('category')).toBe('素菜')
    expect(location.searchParams.get('cuisine')).toBe('家常')
    expect(localStorage.getItem('yushan-recipe-filters')).not.toContain('鸡蛋')
    expect(await screen.findByText('热量暂无')).toBeTruthy()
    expect(screen.getByRole('img', { name: '番茄炒蛋暂无图片' })).toBeTruthy()
    expect(screen.queryByText('+ 加菜')).toBeNull()
  })

  it('recovers saved preferences on refresh, lets URL override them, and clears URL plus storage', async () => {
    const get = mockList()
    localStorage.setItem('yushan-recipe-filters', JSON.stringify({ state: { category: '荤菜', cuisine: '川菜' }, version: 1 }))
    await useRecipeFilters.persist.rehydrate()
    mount()
    await screen.findByText('番茄炒蛋')
    expect(get.mock.calls.some(([, config]) => requestParams(config)?.category === '荤菜' && requestParams(config)?.cuisine === '川菜')).toBe(true)
    cleanup()
    mount('/recipes?q=鸡蛋&category=素菜&cuisine=家常')
    await screen.findByText('番茄炒蛋')
    expect(useRecipeFilters.getState().category).toBe('素菜')
    expect(useRecipeFilters.getState().cuisine).toBe('家常')
    fireEvent.click(screen.getByRole('button', { name: '清除搜索与筛选' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes'))
    expect(useRecipeFilters.getState().category).toBe('')
    expect(useRecipeFilters.getState().cuisine).toBe('')
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    const saved = JSON.parse(localStorage.getItem('yushan-recipe-filters')!)
    expect(saved.state).toEqual({ category: '', cuisine: '' })
  })

  it('shows loading and an empty result with a clear displayed count', async () => {
    let resolve!: (value: unknown) => void
    vi.spyOn(apiClient, 'get').mockImplementation((url) => url === '/recipes/filters'
      ? Promise.resolve({ data: filters }) : new Promise((done) => { resolve = done }))
    mount('/recipes?q=不存在的菜')
    expect(screen.getByText('正在取回菜谱…')).toBeTruthy()
    resolve({ data: { items: [], total: 0, page: 1, pageSize: 12 } })
    expect(await screen.findByText('还没有找到这道味道')).toBeTruthy()
    expect(screen.getByText('共 0 道（已显示 0）')).toBeTruthy()
  })

  it('shows network failure and allows a real retry', async () => {
    let failed = true
    vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url === '/recipes/filters') return { data: filters }
      if (failed) throw new AxiosError('offline', 'ERR_NETWORK')
      return { data: { items: [dish], total: 1, page: 1, pageSize: 12 } }
    })
    mount()
    expect(await screen.findByText('暂时连不上厨房，请检查网络后重试。')).toBeTruthy()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
    expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  })

  it('loads the next API page, retains first-page cards, and reports total versus shown', async () => {
    const first = Array.from({ length: 12 }, (_, index) => ({ ...dish, id: `dish-${index}`, name: `菜谱${index}` }))
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url, config) => {
      if (url === '/recipes/filters') return { data: filters }
      const page = requestParams(config)?.page || 1
      return { data: { items: page === 1 ? first : [dish], total: 13, page, pageSize: 12 } }
    })
    mount()
    await screen.findByText('共 13 道（已显示 12）')
    fireEvent.click(screen.getByRole('button', { name: '再翻一页' }))
    await screen.findByText('共 13 道（已显示 13）')
    expect(get.mock.calls.some(([, config]) => requestParams(config)?.page === 2)).toBe(true)
    expect(screen.getByText('菜谱0')).toBeTruthy()
    expect(screen.getByText('番茄炒蛋')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '再翻一页' })).toBeNull()
  })

  it('waits for Chinese input composition before sending search', async () => {
    const get = mockList()
    mount()
    await screen.findByText('番茄炒蛋')
    const input = screen.getByRole('searchbox')
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '番茄' } })
    await new Promise((resolve) => window.setTimeout(resolve, 400))
    expect(get.mock.calls.some(([, config]) => requestParams(config).q === '番茄')).toBe(false)
    fireEvent.compositionEnd(input)
    await waitFor(() => expect(get.mock.calls.some(([, config]) => requestParams(config).q === '番茄')).toBe(true))
  })

  it('keeps loaded cards visible when a later page fails, then retries that page', async () => {
    let failNext = true
    const first = Array.from({ length: 12 }, (_, index) => ({ ...dish, id: `dish-${index}`, name: `菜谱${index}` }))
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url, config) => {
      if (url === '/recipes/filters') return { data: filters }
      const page = requestParams(config).page || 1
      if (page === 2 && failNext) throw new AxiosError('offline', 'ERR_NETWORK')
      return { data: { items: page === 1 ? first : [dish], total: 13, page, pageSize: 12 } }
    })
    mount()
    await screen.findByText('共 13 道（已显示 12）')
    fireEvent.click(screen.getByRole('button', { name: '再翻一页' }))
    await screen.findByText('后面的菜谱加载失败')
    expect(screen.getByText('菜谱0')).toBeTruthy()
    expect(screen.getByText('共 13 道（已显示 12）')).toBeTruthy()
    failNext = false
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
    await screen.findByText('共 13 道（已显示 13）')
    expect(get.mock.calls.filter(([, config]) => requestParams(config).page === 2)).toHaveLength(3)
  })

  it('renders actual detail fields and source, and leaves an absent video as text', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: {
      ...dish, aliases: ['木须番茄'], spiciness: 0,
      ingredients: [{ name: '鸡蛋', amount: '两个' }], steps: ['先打散鸡蛋。', '翻炒番茄后混合。'], notes: ['小火收汁。'],
      videoUrl: null, source: { name: 'HowToCook', url: 'https://example.com/recipe', license: 'Unlicense', commit: 'abc123' },
    } })
    mount('/recipes/tomato')
    await screen.findByRole('heading', { name: '番茄炒蛋' })
    for (const text of ['鸡蛋', '两个', '先打散鸡蛋。', '小火收汁。', 'HowToCook', 'Unlicense', 'abc123', '暂无视频，先跟着文字步骤做吧']) expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByRole('link', { name: '查看原始菜谱 ↗' }).getAttribute('href')).toBe('https://example.com/recipe')
    expect(document.querySelector('video')).toBeNull()
  })
})

/*
 * 标题带的上间距要和别的页面一致（用户 2026-10-13：「菜谱那页的标题距离上方有点大」）。
 *
 * 实测过改前：`h1` 是 `margin: 12px 0 8px`，而它紧跟在 `.page-back`（「← 厨房」）后面——
 * 其它页面的 `.ptitle` 到返回链接是 0px，只有本页 12px。所以这条守 `h1` 的**上边距为 0**。
 * jsdom 算不了布局，守规则（与 corner-art.test / DiscoverPage.test 同一手法）。
 */
describe('标题带', () => {
  it('h1 的上边距为 0，与其它页面的标题位置一致', () => {
    const css = readFileSync(join(__dirname, 'recipes.scss'), 'utf8')
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')
    const h1 = strip(css).match(/\bh1\s*\{[^}]*\}/)?.[0] ?? ''
    expect(h1, '没读到 .recipes-heading 里的 h1 规则').toBeTruthy()
    expect(h1, 'h1 的上边距必须是 0（否则标题离返回链接空出 12px，与别的页面不一致）')
      .toMatch(/margin\s*:\s*0\s/)
  })
})
