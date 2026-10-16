// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AxiosError, type AxiosRequestConfig } from 'axios'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { RecipeSummary } from '@/api/recipes'
import { useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import MyRecipesPage from './MyRecipesPage'

/**
 * 我的菜谱（F1-12 + F9-02 三视角，见 D-076）。要盯住的事：
 * ① **三个 tab 都在，且切换真的换内容**（做过的 / 收藏的 / 原创的）；
 * ② **tab 在 URL 里**——点进详情再返回要回到原来那个 tab（组件 state 活不过路由跳转）；
 * ③ 「原创的」那一支**只问自己家的**（请求必须带 `mine=1`，不带就把整个库拉回来了）；
 * ④ 一条都没有时**给下一步**（这一页的价值就是往里加第一道菜），不是一片空白；
 * ⑤ 打不开时能重试。
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

/** 落点探针：把路由 state 读出来（编辑入口带没带 `from` 是这条用例要盯的） */
function EditLanding() {
  const location = useLocation()
  return <div data-testid="edit-page" data-from={JSON.stringify(location.state)} />
}

/** 详情页探针：点卡片进去之后，**返回要回得到原来那个 tab**，判据就是这里读到的 `from` */
function DetailLanding() {
  const location = useLocation()
  return <div data-testid="detail-page" data-from={(location.state as { from?: string } | null)?.from ?? '(没带)'} />
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', search: '?tab=mine', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
          <Route path="/recipes/new" element={<div data-testid="form-page" />} />
          <Route path="/recipes/:id" element={<DetailLanding />} />
          <Route path="/recipes/:id/edit" element={<EditLanding />} />
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
    // 另外两个 tab 要的（「做过的」/「收藏的」）：这一份用例盯的是「原创的」，
    // 但它们**在同一个组件里**，切 tab 时会被请求到（空数据即可）
    if (url === '/discover/cooked') return { data: { items: [], total: 0, limit: 30 } }
    if (url === '/favorites') return { data: { items: [], total: 0, limit: 200 } }
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

// ---------------------------------------------------------------------------
// 三视角（F9-02 / D-076）：做过的 / 收藏的 / 原创的
// ---------------------------------------------------------------------------

/** 三个 tab 要的接口都回同一份"有内容"的数据，用来验"切了真的换内容" */
/** 三个新 tab 都要登录态才有请求（`/discover/cooked` 与 `/favorites` 的 enabled 都看 token） */
function signIn() {
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'a', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' },
  })
}

function mockAllThree() {
  return vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    if (url === '/discover/cooked') {
      return { data: { items: [{ id: 'c1', name: '我做的排骨', image: null, category: '荤菜', cuisine: '家常', tags: [], calories: 300, caloriesEstimated: false, cooked: 3, lastCookedOn: '2026-10-12', cookedLabel: '做过 3 次 · 最近 3 天前' }], total: 1, limit: 30 } }
    }
    if (url === '/favorites') {
      return { data: { items: [{ id: 'f1', name: '我收的菜', image: null, category: '素菜', cuisine: '家常', tags: [], calories: 100, caloriesEstimated: false, favoritedAt: '2026-10-14T00:00:00.000Z' }], total: 1, limit: 200 } }
    }
    if (url === '/recipes') return { data: { items: [own], total: 1, page: 1, pageSize: 12 } }
    if (url === '/orders/options') return { data: { meals: [], statuses: [], dayOptions: [] } }
    if (url === '/family') return { data: null }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
}

it('三个 tab 都在，默认（不给 tab 参数时）落在「做过的」', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      {/* 不带 tab 参数 = 从「我的」页那一行进来的默认落点 */}
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByText('做过的')).toBeTruthy()
  expect(screen.getByText('收藏的')).toBeTruthy()
  expect(screen.getByText('原创的')).toBeTruthy()
  // 默认那一个 tab 的内容（"做过的"）在屏上，另外两个的不在
  expect(await screen.findByText('我做的排骨')).toBeTruthy()
  expect(screen.queryByText('我收的菜')).toBeNull()
  expect(screen.queryByText('外婆的红烧肉')).toBeNull()
})

it('切到「收藏的」真的换内容（不是把三个列表都堆在一起）', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  fireEvent.click(await screen.findByText('收藏的'))
  expect(await screen.findByText('我收的菜')).toBeTruthy()
  // 换过去了：原来那个 tab 的内容退场
  await waitFor(() => expect(screen.queryByText('我做的排骨')).toBeNull())
})

it('**tab 在 URL 里**：从 URL 直接进「收藏的」也落在那个 tab（点详情返回时才回得来）', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', search: '?tab=favorites', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByText('我收的菜')).toBeTruthy()
  expect(screen.queryByText('我做的排骨')).toBeNull()
})

it('认不出的 tab 值落回第一个（URL 是不可信输入）', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', search: '?tab=乱写的', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByText('我做的排骨')).toBeTruthy()
})

/*
 * 「点卡片进详情 → 返回」要回到**原来那个 tab**（用户 2026-10-16：
 * 「做过的和收藏的那两个，进入后返回有问题」）。
 *
 * 缺陷的形状：两张卡片的 `from` 写的是 `location.pathname`——**把查询串丢了**，
 * 而"在第几个 tab"恰恰只写在查询串里。于是从「收藏的」点进详情，返回落回
 * 「做过的」（无参数时的默认 tab），用户看到的就是"tab 被重置了"。
 * 「原创的」那一支自己拼的是 `pathname + search`，所以它一直是好的——
 * 这正是用户说"那两个"而不是"三个"的原因。
 */
it('收藏的：点卡片进详情时 `from` **带着 tab**（否则返回会落回「做过的」）', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', search: '?tab=favorites', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
          <Route path="/recipes/:id" element={<DetailLanding />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  fireEvent.click(await screen.findByText('我收的菜'))
  const detail = await screen.findByTestId('detail-page')
  expect(detail.dataset.from).toBe('/recipes/mine?tab=favorites')
})

it('做过的：点卡片进详情时 `from` 也带着**这一页自己的**地址', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      {/* 做过的这一支是默认 tab，地址里没有参数——返回目标就是这一页本身 */}
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
          <Route path="/recipes/:id" element={<DetailLanding />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  fireEvent.click(await screen.findByText('我做的排骨'))
  const detail = await screen.findByTestId('detail-page')
  expect(detail.dataset.from).toBe('/recipes/mine')
})

it('在「收藏的」里点的卡片，`from` 不会被**当前正在看的 tab** 串改（每一支各有各的地址）', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', search: '?tab=favorites', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
          <Route path="/recipes/:id" element={<DetailLanding />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  // 先切回「做过的」再切回「收藏的」——两边的卡片都不该拿到对方那一支的地址
  fireEvent.click(await screen.findByText('做过的'))
  expect(await screen.findByText('我做的排骨')).toBeTruthy()
  fireEvent.click(screen.getByText('收藏的'))
  fireEvent.click(await screen.findByText('我收的菜'))

  const detail = await screen.findByTestId('detail-page')
  expect(detail.dataset.from).toBe('/recipes/mine?tab=favorites')
})

// ---------------------------------------------------------------------------
// 原创的：卡片上直接放「编辑 / 删除」（交付二 / D-085）
// ---------------------------------------------------------------------------

it('原创的：卡上直接给「编辑 / 删除」，编辑带 `from` 跳表单页（改完返回才回得到这一页）', async () => {
  mockGet([own])
  mount()

  const edit = await screen.findByRole('button', { name: '编辑' })
  // 与"点卡片进详情"**不是同一个动作**：这里直接进表单
  fireEvent.click(edit)

  const landing = await screen.findByTestId('edit-page')
  expect(landing.dataset.from).toContain('/recipes/mine?tab=mine')
  expect(screen.queryByTestId('detail-page')).toBeNull()
})

it('原创的：删除要先确认（不点卡片进详情），确认后发 DELETE 并报一句', async () => {
  mockGet([own])
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { id: 'own-1', name: '外婆的红烧肉' } } as never)
  mount()

  fireEvent.click(await screen.findByRole('button', { name: '删除' }))

  // 两颗按钮是 `<Link>` 的**兄弟**：点它们不能顺势进详情（进详情就等于把确认框盖掉）
  expect(screen.queryByTestId('detail-page')).toBeNull()
  expect(remove).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  // 与详情页同一句：说清连带影响（收藏与常用组合里的引用也一起没了）
  expect(dialog.textContent).toContain('「外婆的红烧肉」会从你们家的菜谱里删掉')
  expect(dialog.textContent).toContain('收藏与常用组合里的这道也会一起消失')

  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

  await waitFor(() => expect(remove).toHaveBeenCalledWith('/recipes/own-1'))
  await waitFor(() => expect(
    useToasts.getState().items.some((item) => item.text === '已删掉「外婆的红烧肉」'),
  ).toBe(true))
})

it('删不掉时把后端那句话说出来，卡片留在原地（不假装删掉了）', async () => {
  mockGet([own])
  vi.spyOn(apiClient, 'delete').mockRejectedValue({
    isAxiosError: true, response: { status: 403, data: { message: '这道菜谱不是你们家的，改不了' } },
  } as never)
  mount()

  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))

  await waitFor(() => expect(
    useToasts.getState().items.some((item) => item.text === '这道菜谱不是你们家的，改不了'),
  ).toBe(true))
  expect(screen.getByText('外婆的红烧肉')).toBeTruthy()
})

it('不是自己传的那些不画「编辑 / 删除」（公共菜谱只能看：给个按钮再拿 403 拒绝比不给更糟）', async () => {
  signIn()
  mockAllThree()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes/mine', search: '?tab=favorites', state: { from: '/mine' } }]}>
        <Routes>
          <Route path="/recipes/mine" element={<MyRecipesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByText('我收的菜')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
})

// ---------------------------------------------------------------------------
// 「原创的」的横向栏距（用户 2026-10-16：「这块左右没有空白间隔，和做过的、收藏的不一致」）
// ---------------------------------------------------------------------------

/**
 * 实测（360 宽）：做过的 / 收藏的网格 `left: 16, width: 328`，而**原创的**是 `left: 0, width: 360`
 * ——卡片贴着屏幕边。
 *
 * 根因是**选择器打空靶**（R-78 那一族，只不过这里是 CSS 不是 mock）：栏距写在
 * `.my-recipes .recipes-grid` 上，而「页头不动、只滚主体」这一刀（D-091）把 `.my-recipes`
 * 挪进了**固定页头**、网格留在**页体**里——两者成了兄弟，那条后代选择器永远匹配不到。
 * 同一条规则里的 `.my-recipes .recipe-status` 与宽屏那条 `max-width: 760px` 一起失效。
 *
 * 守两条：① 真正的元素上挂着**能在 DOM 里匹配到**的钩子类；
 * ② 样式里不再出现 `.my-recipes 后代` 这种形状的选择器（它在这页结构上**必然**打空靶）。
 * jsdom 算不了布局，所以守规则（与 recipes.test.tsx 里那两条同一手法）。
 */
describe('「原创的」的横向栏距', () => {
  const css = () =>
    readFileSync(join(__dirname, 'recipes.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('网格自带钩子类，且样式里那条规则真的带着栏距变量', async () => {
    mockGet([own])
    mount()
    fireEvent.click(await screen.findByText('原创的'))

    // ① DOM：网格上要有能被样式命中的钩子（不能靠 `.my-recipes` 后代——那个类不在这一层）
    const grid = await waitFor(() => {
      const el = document.querySelector('.my-recipes__grid')
      expect(el, '「原创的」的网格没挂 my-recipes__grid 钩子').toBeTruthy()
      return el as HTMLElement
    })
    expect(grid.className).toContain('recipes-grid')

    // ② 样式：那条规则要用全站的栏距变量（写死 16px 会在调整栏距时悄悄掉队）
    const rule = css().match(/\.my-recipes__grid\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(rule, '没读到 .my-recipes__grid 的规则').toBeTruthy()
    expect(rule, '网格要自带左右栏距，否则卡片贴着屏幕边（与另外两支不一致）')
      .toMatch(/margin[^;]*var\(--spacing-page\)/)
  })

  it('样式里不再有 `.my-recipes 后代` 形状的选择器（那个类在固定页头里，永远匹配不到页体）', () => {
    // 这一条是**这一族 bug 的总闸**：`.my-recipes` 现在只包着页头那几样，
    // 任何"它后面的后代"都落在页体里，写出来必然是死规则。
    const dead = css().match(/\.my-recipes\s+\.([\w-]+)/g) ?? []
    expect(dead, `这些选择器在 DOM 里匹配不到（.my-recipes 在固定页头、内容在页体）：${dead.join('、')}`)
      .toEqual([])
  })
})
