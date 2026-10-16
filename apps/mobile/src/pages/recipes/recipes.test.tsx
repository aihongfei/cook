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

/*
 * ⚠️ 这里原来 mock 的是 `FilterTabs`——而分类筛选区在 2026-10-16 换成了 `Chips`
 * （用户选定方案 B「胶囊双行」，见 PLAN.md / D-096），那个 mock 就成了**空转**：
 * 页面根本不 import 它，于是测试里跑的是真的 `Chips`，而 mock 只是让
 * "筛选按钮"这件事看起来被覆盖了。这类"mock 打空靶"最危险的地方是**它不报错**。
 * 现在改 mock 真正的那个组件，并保留同样可点的按钮语义（`aria-pressed` 表示选中）。
 */
vi.mock('@/components/ui/Chips', () => ({
  default: ({ items, value, onChange }: { items: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) =>
    <div data-testid="chips">{items.map((item) => <button key={item.id} type="button" aria-pressed={value === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}</div>,
}))

const dish: RecipeSummary = { id: 'tomato', name: '番茄炒蛋', image: null, category: '素菜', cuisine: '家常', tags: ['快手'], calories: null, caloriesEstimated: false, origin: 'howtocook', sourceLabel: 'HowToCook', mine: false }
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

  /*
   * `?tag=` 是发现页「时令精选」点进来的落点（2026-10-16，见 D-110）。
   * 这一条守住三件事，每一件都对应一个真实会犯的错：
   * ① 请求带的是 `tag` 而**不是 `q`**（用搜索兜会多出名字里带"秋"的 3 道，数字对不上）；
   * ② 标签**不持久化**到本地存储（品类/菜系才是"我平时爱看什么"，标签是一次性入口
   *    ——进了时令精选，过两天打开菜谱小书还只看见秋菜是坏的）；
   * ③ 生效中要有一条**可关的**说明：不说的话用户只看到"共 2 道"，会以为菜谱库没了。
   */
  it('`?tag=` 时按标签精确筛、不落到本地存储，并给一条可关的说明', async () => {
    const get = mockList()
    mount('/recipes?tag=' + encodeURIComponent('秋季,秋季菜谱'))
    await screen.findByText('番茄炒蛋')

    const tagCall = get.mock.calls.find(([, config]) => requestParams(config).tag)
    expect(tagCall, '请求里没有 tag').toBeTruthy()
    expect(requestParams(tagCall![1]).tag).toBe('秋季,秋季菜谱')
    expect(requestParams(tagCall![1]).q).toBeUndefined()
    expect(localStorage.getItem('yushan-recipe-filters')).not.toContain('秋季')

    // 那一枚胶囊写着标签名；去掉之后 URL 与请求都不再带它
    fireEvent.click(screen.getByRole('button', { name: /去掉标签筛选：秋季、秋季菜谱/ }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('tag='))
    await waitFor(() => expect(get.mock.calls.some(([, config]) => !requestParams(config).tag && requestParams(config).page === 1)).toBe(true))
  })

  it('renders actual detail fields and source, and leaves an absent video as text', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: {
      ...dish, aliases: ['木须番茄'], spiciness: 0,
      ingredients: [{ name: '鸡蛋', amount: '两个' }], steps: ['先打散鸡蛋。', '翻炒番茄后混合。'], notes: ['小火收汁。'],
      videoUrl: null, source: { name: 'HowToCook', url: 'https://example.com/recipe', license: 'Unlicense', commit: 'abc123' },
    } })
    mount('/recipes/tomato')
    await screen.findByRole('heading', { name: '番茄炒蛋' })
    for (const text of ['鸡蛋', '两个', '先打散鸡蛋。', '小火收汁。', 'Unlicense', 'abc123', '暂无视频，先跟着文字步骤做吧']) expect(screen.getByText(text)).toBeTruthy()
    /*
     * 来源名在详情页是**两处**：标题下的来源徽标（F1-12）与页尾的「这份菜谱从哪里来」。
     * 所以这里按"两处都在"断言——原来的单数断言在加了徽标之后必然变成"找到多个"。
     */
    expect(screen.getAllByText('HowToCook')).toHaveLength(2)
    expect(document.querySelector('.recipe-detail__origin .origin-badge')!.textContent).toBe('HowToCook')
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

/*
 * 跟手翻页时**两页之间要有空白间隙**（用户 2026-10-16：「这个滚动时，两个 tab 的内容没有空白间隙」）。
 *
 * 现象：拖到一半时左页最后一张卡与右页第一张卡贴在一起（实测间距 **0px**）。
 * 根因：左右栏距挂在外层容器（`.recipes-page` 的 `padding`）上，而两页各自是 100% 宽、紧挨在一起，
 * 于是"页与页"这一段没有任何留白——看着像一长排卡片连着铺过去，而不是两页。
 * （订单页 / 打卡墙是 32px，那两页的栏距本来就在卡片自己身上。）
 *
 * 修法是把栏距从外层挪到**每一页**（`.swipe-pager__panel`）上。jsdom 算不了布局，
 * 所以这条守规则（与上面「标题带」那条同一手法）：**栏距必须挂在页上**，
 * 而且外层不能再留一份（两份会叠成 64px）。
 *
 * ⚠️ 写成"页上的 padding-inline 是 var(--spacing-page)"而不是写死 `16px`：
 * 栏距是全站的变量，将来调它时这条断言不该跟着变红。
 */
describe('翻页时两页之间的间隙', () => {
  it('横向栏距挂在每一页上，外层容器不再留一份（两份会叠起来）', () => {
    const css = readFileSync(join(__dirname, 'recipes.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (name: string) =>
      css.match(new RegExp(`\\.${name}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''

    const panel = rule('recipes-page--body \\.swipe-pager__panel') || rule('swipe-pager__panel')
    expect(panel, '没读到"每一页自带栏距"那条规则').toBeTruthy()
    expect(panel, '每一页要自带左右栏距，否则翻到一半两页的卡片会贴在一起').toMatch(/padding-inline\s*:\s*var\(--spacing-page\)/)

    const body = rule('recipes-page--body')
    expect(body, '没读到 .recipes-page--body 规则').toBeTruthy()
    expect(body, '外层不能再留横向栏距（会与页上那份叠成两倍）').toMatch(/padding\s*:\s*0\b/)
  })
})

/*
 * 分类筛选区（用户 2026-10-16 选定方案 B「胶囊双行」，D-096 / PLAN.md）。
 *
 * 这一组盯三件事，都是"改坏了不容易发现"的：
 * ① **标签进到行内**——它原来各独占一行（28px × 2），是这一刀要省的 87px 里的大头；
 * ② **点胶囊真的换筛选**（并且两组各自独立、互不干扰）；
 * ③ 结构上是"两行，每行一个标签 + 一组选项"，行数变了就说明又被摊开了。
 */
describe('分类筛选区（胶囊双行）', () => {
  it('标签与选项在同一行：两行、每行一个标签、一组选项', async () => {
    mockList()
    mount()
    await screen.findByText('番茄炒蛋')

    const filters = document.querySelector('.recipes-filters') as HTMLElement
    const rows = [...filters.querySelectorAll('.recipes-filters__row')]
    expect(rows).toHaveLength(2)
    const labels = rows.map((row) => row.querySelector('.recipes-filters__label')?.textContent?.trim())
    expect(labels).toEqual(['品类', '菜系'])
    // 每一行里，标签与选项是**兄弟**（同一行），而不是标签自成一行
    rows.forEach((row) => {
      expect(row.querySelector('.recipes-filters__label')).toBeTruthy()
      expect(row.querySelector('.recipes-filters__track')).toBeTruthy()
      // 选项那一截里有真的可选按钮（Chips 被上面 mock 掉了，所以认它渲染出来的按钮）
      expect(row.querySelector('.recipes-filters__track')!.querySelectorAll('button').length).toBeGreaterThan(1)
    })
    // 两组选项各自一串
    const tracks = [...filters.querySelectorAll('.recipes-filters__track')]
    expect(tracks).toHaveLength(2)
    expect(tracks[0].querySelectorAll('button').length).toBeGreaterThan(1)
    expect(tracks[1].querySelectorAll('button').length).toBeGreaterThan(1)
  })

  it('点品类胶囊只换品类（菜系那边不动），点菜系胶囊只换菜系', async () => {
    mockList()
    mount()
    await screen.findByText('番茄炒蛋')

    // 两项各自独立：品类那一行的按钮点下去，只该改 category
    fireEvent.click(screen.getByRole('button', { name: '荤菜' }))
    await waitFor(() => {
      const location = new URL(screen.getByTestId('location').textContent!, 'http://localhost')
      expect(location.searchParams.get('category')).toBe('荤菜')
    })
    expect(useRecipeFilters.getState().category).toBe('荤菜')

    fireEvent.click(screen.getByRole('button', { name: '川菜' }))
    await waitFor(() => {
      const location = new URL(screen.getByTestId('location').textContent!, 'http://localhost')
      expect(location.searchParams.get('cuisine')).toBe('川菜')
    })
    // 先前选的品类**没被顶掉**（两个筛选项是叠加的，不是二选一）
    expect(useRecipeFilters.getState().category).toBe('荤菜')
  })

  it('选中的那颗是胶囊的选中态（不是靠颜色深浅猜）', async () => {
    mockList()
    mount('/recipes?category=素菜')
    await screen.findByText('番茄炒蛋')

    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent?.trim())
    // 「全部菜系」也在一开始就被选中（菜系未筛），加上传进来的「素菜」
    expect(pressed).toContain('素菜')
    expect(pressed).toContain('全部菜系')
    expect(pressed).not.toContain('荤菜')
  })
})
