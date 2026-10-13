// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { Recipe, RecipeSummary } from '@/api/recipes'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import { useRecipeFilters } from '@/stores/recipe-filters'
import RecipeDetailPage from './RecipeDetailPage'
import RecipeListPage from './RecipeListPage'

/**
 * 来源徽标与"能不能改"（F1-12，用户 2026-10-13：「自己上传的要和极速 api 的区分下」）。
 *
 * 三件事要盯住：
 * ① **文案用后端给的 sourceLabel**（前端不查表：查表那版会把新源显示成英文 key）；
 * ② **导入的菜弱、自建的醒目**——库里九成是导入的，每个都抢眼就等于没有重点；
 * ③ **编辑/删除只在 mine=true 时画**：公共菜谱是只读的，给了按钮再拿 403 拒绝比不给更糟。
 */

const clients: QueryClient[] = []

const imported: RecipeSummary = {
  id: 'tomato', name: '番茄炒蛋', image: null, category: '素菜', cuisine: '家常',
  tags: [], calories: 180, caloriesEstimated: true,
  origin: 'jisu', sourceLabel: '极速数据', mine: false,
}

const own: RecipeSummary = {
  id: 'own-1', name: '外婆的红烧肉', image: null, category: '荤菜', cuisine: '家常',
  tags: ['下饭'], calories: 480, caloriesEstimated: false,
  origin: 'user', sourceLabel: '自己上传', mine: true,
}

function detail(overrides: Partial<Recipe> = {}): Recipe {
  return {
    ...own, createdBy: '妈妈', aliases: [], spiciness: 0,
    ingredients: [{ name: '五花肉', amount: '500g' }], steps: ['切块焯水'], notes: [],
    videoUrl: null, source: { name: '自己上传', url: '', license: '用户原创', commit: '' },
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function mount(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/recipes" element={<RecipeListPage />} />
          <Route path="/recipes/mine" element={<div data-testid="my-recipes" />} />
          <Route path="/recipes/:id" element={<RecipeDetailPage />} />
          <Route path="/recipes/:id/edit" element={<div data-testid="edit-page" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 菜谱之外的接口（家庭/点餐选项）也得有回应：卡片里的 hook 会自己去取 */
function mockApi({ recipes = [] as RecipeSummary[], detailData = detail() as Recipe | null } = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    if (url === '/recipes/filters') return { data: { categories: ['素菜', '荤菜'], cuisines: ['家常'] } }
    if (url === '/recipes') return { data: { items: recipes, total: recipes.length, page: 1, pageSize: 12 } }
    if (url.startsWith('/recipes/')) return { data: detailData }
    if (url === '/orders/options') return { data: { meals: [], statuses: [], dayOptions: [] } }
    if (url === '/family') return { data: null }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useToasts.setState({ items: [] })
  useAuth.getState().clear()
  useRecipeFilters.getState().reset()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('列表页：导入的显示后端给的话、自建的额外标出「自己上传」', async () => {
  mockApi({ recipes: [imported, own] })
  mount('/recipes')

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  // 导入源的文案**照抄 sourceLabel**，界面上不该出现 'jisu' 这种机器值
  const badges = Array.from(document.querySelectorAll('.dish-card .origin-badge'))
  expect(badges.some((badge) => badge.textContent === '极速数据')).toBe(true)
  expect(document.body.textContent).not.toContain('jisu')
  expect(badges.some((badge) => badge.textContent === '自己上传')).toBe(true)
})

it('列表页：两枚徽标只靠修饰类区分轻重（导入的弱、自建的实色）', async () => {
  mockApi({ recipes: [imported, own] })
  mount('/recipes')

  await screen.findByText('番茄炒蛋')
  const badges = Array.from(document.querySelectorAll('.dish-card .origin-badge'))
  const importedBadge = badges.find((badge) => badge.textContent === '极速数据')!
  const ownBadge = badges.find((badge) => badge.textContent === '自己上传')!
  expect(importedBadge.className).toContain('origin-badge')
  expect(importedBadge.className).not.toContain('origin-badge--mine')
  expect(ownBadge.className).toContain('origin-badge--mine')
})

/*
 * jsdom 算不了样式，所以"轻重"这条守规则（与 recipes.test.tsx 里标题带那条同一手法）：
 * 自建的那枚必须用**主题色实底**，导入的不许碰 --color-brand ——否则两枚一样重，
 * 而库里九成是导入的，整页就没有重点了。
 */
it('「自己上传」用主题色实底，导入的只用弱色（不许自造新色值）', () => {
  const css = readFileSync(join(__dirname, 'recipes.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const mine = css.match(/\.origin-badge--mine\s*\{[^}]*\}/)?.[0] ?? ''
  const base = css.match(/\.origin-badge\s*\{[^}]*\}/)?.[0] ?? ''
  expect(mine, '没读到 .origin-badge--mine 规则').toBeTruthy()
  expect(mine, '自建的徽标要用主题色实底（--color-paper 字 + --color-brand 底）')
    .toMatch(/background:\s*var\(--color-brand\)/)
  expect(base, '没读到 .origin-badge 规则').toBeTruthy()
  expect(base, '导入那枚不许用主题色——它不抢眼是这条的全部意义')
    .not.toMatch(/var\(--color-brand\)/)
})

it('详情页：自建的标出来源与上传人，并给编辑/删除', async () => {
  mockApi({ detailData: detail() })
  mount('/recipes/own-1')

  expect(await screen.findByRole('heading', { name: '外婆的红烧肉' })).toBeTruthy()
  // 只看标题下那一行：底部的「这份菜谱从哪里来」里也有同样的字（那是许可信息，不是徽标）
  const originLine = document.querySelector('.recipe-detail__origin')!
  expect(originLine.textContent).toContain('自己上传')
  expect(originLine.textContent).toContain('妈妈 上传')
  expect(originLine.querySelector('.origin-badge--mine')).toBeTruthy()
  expect(screen.getByRole('link', { name: '编辑' }).getAttribute('href')).toBe('/recipes/own-1/edit')
  expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
})

it('详情页：mine=false 时**不画**编辑与删除（公共菜谱只能看）', async () => {
  mockApi({
    detailData: detail({
      ...imported, createdBy: null,
      source: { name: '极速数据', url: '', license: '许可说明', commit: 'abc' },
    }),
  })
  mount('/recipes/tomato')

  expect(await screen.findByRole('heading', { name: '番茄炒蛋' })).toBeTruthy()
  const originLine = document.querySelector('.recipe-detail__origin')!
  expect(originLine.textContent).toContain('极速数据')
  expect(originLine.querySelector('.origin-badge--mine')).toBeNull()
  // 没有按钮就要把原因说出来（否则用户只会觉得"为什么这道不能改"）
  expect(originLine.textContent).toContain('公共菜谱不能改')
  expect(screen.queryByRole('link', { name: '编辑' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
  // 原有的来源/许可区块照旧（徽标只是加了一处标记，没动那块）
  expect(screen.getByText('这份菜谱从哪里来')).toBeTruthy()
})

it('详情页删一道自建菜谱：先确认，确认后发 DELETE、说一句并回「我的菜谱」', async () => {
  mockApi({ detailData: detail() })
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { id: 'own-1', name: '外婆的红烧肉' } } as never)
  mount('/recipes/own-1')

  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
  // 没确认之前绝不能发请求：这一步是不可逆的
  expect(remove).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('删了不能恢复')

  // 确认键在弹窗里（页面上那个"删除"只是打开入口，点它不该直接删）
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

  await waitFor(() => expect(remove).toHaveBeenCalledWith('/recipes/own-1'))
  await waitFor(() => expect(useToasts.getState().items.some((item) => item.text === '已删掉「外婆的红烧肉」')).toBe(true))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes/mine'))
})

it('详情页删不掉时留在原地（后端拒绝是 403，用户该看到那句话而不是被踢走）', async () => {
  mockApi({ detailData: detail() })
  const remove = vi.spyOn(apiClient, 'delete').mockRejectedValue({
    isAxiosError: true, response: { status: 403, data: { message: '这道菜谱不是你们家的，改不了' } },
  } as never)
  mount('/recipes/own-1')

  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))

  await waitFor(() => expect(remove).toHaveBeenCalled())
  await waitFor(() => expect(useToasts.getState().items.some((item) => item.text === '这道菜谱不是你们家的，改不了')).toBe(true))
  expect(screen.getByTestId('location').textContent).toBe('/recipes/own-1')
})

it('编辑入口跳 /recipes/:id/edit', async () => {
  mockApi({ detailData: detail() })
  mount('/recipes/own-1')

  fireEvent.click(await screen.findByRole('link', { name: '编辑' }))
  expect(screen.getByTestId('edit-page')).toBeTruthy()
})
