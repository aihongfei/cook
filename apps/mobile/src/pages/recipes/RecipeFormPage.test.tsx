// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { Recipe } from '@/api/recipes'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import RecipeFormPage from './RecipeFormPage'

/**
 * 写 / 改一道菜谱（F1-12）。这一份盯的是**发出去的东西对不对**：
 * ① 前端先把必填拦一遍（名字/品类/菜系/至少一步），别让用户写完一屏才被打回来；
 * ② 新建的 payload 与后端契约逐字段对上（空行滤掉、备注拆条、热量成数字）；
 * ③ **编辑只发改过的字段**（PATCH 的语义：没传的保持原样），"改回原样"一个字段都不发；
 * ④ 删一道自建菜谱要先确认再发请求，成功后回「我的菜谱」。
 */

const clients: QueryClient[] = []

const own: Recipe = {
  id: 'own-1', name: '外婆的红烧肉', image: null, category: '荤菜', cuisine: '家常',
  tags: ['下饭', '慢炖'], calories: 480, caloriesEstimated: false,
  origin: 'user', sourceLabel: '自己上传', mine: true, createdBy: '妈妈',
  aliases: ['红烧肉'], spiciness: 0,
  ingredients: [{ name: '五花肉', amount: '500g' }],
  steps: ['切块焯水', '小火炖 40 分钟'],
  notes: ['糖色别炒糊'],
  videoUrl: null, source: { name: '自己上传', url: '', license: '用户原创', commit: '' },
}

/** 跳转后的落点靠它看（详情页 / 我的菜谱） */
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function mount(entry: string, detail: Recipe = own, getOverride?: (url: string) => unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  })
  clients.push(client)
  vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    if (getOverride) {
      const result = getOverride(url)
      if (result === undefined) throw new Error(`未预期的请求：${url}`)
      return result
    }
    if (url === '/recipes/filters') return { data: { categories: ['荤菜'], cuisines: ['家常'] } }
    if (url === '/orders/options') return { data: { meals: [], statuses: [], dayOptions: [] } }
    if (url === '/family') return { data: null }
    if (url.startsWith('/recipes/')) return { data: detail }
    throw new Error(`未预期的请求：${url}`)
  }) as never)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/recipes/new" element={<RecipeFormPage />} />
          <Route path="/recipes/:id/edit" element={<RecipeFormPage />} />
          <Route path="/recipes/:id" element={<div data-testid="detail-page" />} />
          <Route path="/recipes/mine" element={<div data-testid="my-recipes" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 按 aria-label 填一格（配料/步骤那些行是动态的，只能靠序号定位） */
function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function value(label: string | RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value
}

/**
 * 表单上那一条错误提示。**不能按 role=alert 取**：错误 toast 也是 alert，
 * 一次失败屏幕上就同时有两个（测试里踩过），而这里要盯的是**表单里那一条**。
 */
function formError(): string {
  return document.querySelector('.recipe-form__error')?.textContent ?? ''
}

/** 最小可提交的一份：菜名 + 品类 + 菜系 + 一步做法 */
function fillBasics(name = '红烧肉') {
  type('菜名', name)
  type('品类', '荤菜')
  type('菜系', '家常')
  type('第 1 步做法', '切块焯水')
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useToasts.setState({ items: [] })
  useAuth.getState().clear()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('新建：必填没写全时**不发请求**，并把第一处错误说出来', async () => {
  const post = vi.spyOn(apiClient, 'post')
  mount('/recipes/new')

  // 只写了菜名就提交：品类/菜系/步骤都还空着
  type('菜名', '红烧肉')
  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))

  expect(post).not.toHaveBeenCalled()
  expect(formError()).toContain('还没写这道菜是什么品类')
  expect(useToasts.getState().items.some((item) => item.tone === 'error')).toBe(true)
})

it('新建：一步做法都没有时也拦下来（没有步骤的"菜谱"没法做）', async () => {
  const post = vi.spyOn(apiClient, 'post')
  mount('/recipes/new')

  type('菜名', '红烧肉')
  type('品类', '荤菜')
  type('菜系', '家常')
  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))

  expect(post).not.toHaveBeenCalled()
  expect(formError()).toContain('至少写一步做法')
})

it('新建：新增时留下的空行会被滤掉，只填了用量没写名字的那行则拦下来', async () => {
  const post = vi.spyOn(apiClient, 'post')
  mount('/recipes/new')

  fillBasics()
  type('第 1 条配料名', '五花肉')
  type('第 2 条配料用量', '两勺')
  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))

  // 不静默丢掉用户敲进去的字：告诉他这一行缺名字（顺带把那行写的用量念出来，好找）
  expect(post).not.toHaveBeenCalled()
  expect(formError()).toContain('有一条配料只写了用量（两勺）')

  // 补上名字之后就发得出去，且空行（第 2 行删掉后剩下的那些）不在 payload 里
  type('第 2 条配料名', '冰糖')
  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))
  await waitFor(() => expect(post).toHaveBeenCalled())
  expect((post.mock.calls[0][1] as { ingredients: unknown }).ingredients).toEqual([
    { name: '五花肉', amount: '' },
    { name: '冰糖', amount: '两勺' },
  ])
})

it('新建：提交的 payload 与后端契约逐字段对上（标签去重、备注拆条、热量成数字）', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { ...own, id: 'own-9' } } as never)
  mount('/recipes/new')

  fillBasics()
  type('标签（用顿号或逗号隔开，最多 8 个）', '下饭、慢炖、下饭')
  type('第 1 条配料名', '五花肉')
  type('第 1 条配料用量', '500g')
  type('掌勺小贴士（一行一条，最多 5 条）', '糖色别炒糊\n小火慢炖')
  type('热量（千卡，可不填）', '480')
  fireEvent.click(screen.getByRole('button', { name: '＋ 加一步' }))
  type('第 2 步做法', '小火炖 40 分钟')

  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))

  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith('/recipes', {
    name: '红烧肉',
    category: '荤菜',
    cuisine: '家常',
    tags: ['下饭', '慢炖'],
    ingredients: [{ name: '五花肉', amount: '500g' }],
    steps: ['切块焯水', '小火炖 40 分钟'],
    notes: ['糖色别炒糊', '小火慢炖'],
    calories: 480,
    aliases: [],
  })
  // 建完进这一道的详情（用户多半会想看自己刚写的东西）
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes/own-9'))
  expect(useToasts.getState().items.some((item) => item.text === '菜谱写好了')).toBe(true)
})

it('新建：没填热量时发 null（后端口径是"不知道"，不是 0）', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: own } as never)
  mount('/recipes/new')

  fillBasics()
  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))

  await waitFor(() => expect(post).toHaveBeenCalled())
  expect((post.mock.calls[0][1] as { calories: unknown }).calories).toBeNull()
})

it('新建：后端的中文报错原样显示（重名那条尤其有用），且不跳走', async () => {
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true, response: { status: 409, data: { message: '你们家已经有一道「红烧肉」了，直接改那一道就行' } },
  } as never)
  mount('/recipes/new')

  fillBasics()
  fireEvent.click(screen.getByRole('button', { name: '写好收着' }))

  await waitFor(() => expect(formError()).toContain('你们家已经有一道「红烧肉」了，直接改那一道就行'))
  expect(useToasts.getState().items.some((item) => item.text.includes('已经有一道'))).toBe(true)
  expect(screen.getByTestId('location').textContent).toBe('/recipes/new')
})

it('编辑：进入时用详情回填（配料、步骤、备注、热量各归各位）', async () => {
  mount('/recipes/own-1/edit')

  await waitFor(() => expect(value('菜名')).toBe('外婆的红烧肉'))
  expect(value('品类')).toBe('荤菜')
  expect(value('菜系')).toBe('家常')
  expect(value('标签（用顿号或逗号隔开，最多 8 个）')).toBe('下饭、慢炖')
  expect(value('第 1 条配料名')).toBe('五花肉')
  expect(value('第 1 条配料用量')).toBe('500g')
  expect(value('第 1 步做法')).toBe('切块焯水')
  expect(value('第 2 步做法')).toBe('小火炖 40 分钟')
  expect(value('掌勺小贴士（一行一条，最多 5 条）')).toBe('糖色别炒糊')
  expect(value('热量（千卡，可不填）')).toBe('480')
})

it('编辑：PATCH **只带改过的字段**（没动的一个都不发）', async () => {
  const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: own } as never)
  mount('/recipes/own-1/edit')

  await waitFor(() => expect(value('菜名')).toBe('外婆的红烧肉'))
  // 只改用量：别的字段（步骤/备注/标签/热量）都不该出现在请求体里
  type('第 1 条配料用量', '600g')
  fireEvent.click(screen.getByRole('button', { name: '存好' }))

  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(patch).toHaveBeenCalledWith('/recipes/own-1', {
    ingredients: [{ name: '五花肉', amount: '600g' }],
  })
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes/own-1'))
  expect(useToasts.getState().items.some((item) => item.text === '改好了')).toBe(true)
})

it('编辑：改名与改备注各只发自己那一项', async () => {
  const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: own } as never)
  mount('/recipes/own-1/edit')

  await waitFor(() => expect(value('菜名')).toBe('外婆的红烧肉'))
  type('菜名', '外婆的梅菜扣肉')
  type('掌勺小贴士（一行一条，最多 5 条）', '')
  fireEvent.click(screen.getByRole('button', { name: '存好' }))

  await waitFor(() => expect(patch).toHaveBeenCalledWith('/recipes/own-1', {
    name: '外婆的梅菜扣肉',
    // 备注被清空 → 明确发空列表（`undefined` 才是"别动它"，后端靠这个区分）
    notes: [],
  }))
})

it('编辑：改回原样时一个字段都不发（空 PATCH 会被后端以 400「没有要改的内容」打回）', async () => {
  const patch = vi.spyOn(apiClient, 'patch')
  mount('/recipes/own-1/edit')

  await waitFor(() => expect(value('菜名')).toBe('外婆的红烧肉'))
  type('菜名', '外婆的红烧肉?')
  type('菜名', '外婆的红烧肉')
  fireEvent.click(screen.getByRole('button', { name: '存好' }))

  expect(patch).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes/own-1'))
})

it('编辑：提交中禁用保存键（防重复提交）', async () => {
  let resolve!: (value: unknown) => void
  const patch = vi.spyOn(apiClient, 'patch').mockImplementation(() => new Promise((done) => { resolve = done }) as never)
  mount('/recipes/own-1/edit')

  await waitFor(() => expect(value('菜名')).toBe('外婆的红烧肉'))
  type('菜名', '外婆的梅菜扣肉')
  fireEvent.click(screen.getByRole('button', { name: '存好' }))

  const button = await screen.findByRole('button', { name: '正在存…' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  resolve({ data: { ...own, name: '外婆的梅菜扣肉' } })
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes/own-1'))
  // 只发出过一次：禁用是真的（不是"点了没反应"，而是同一时间只可能有一笔在飞）
  expect(patch).toHaveBeenCalledTimes(1)
})

it('编辑：底部「删掉这道」走确认后才发 DELETE，成功回「我的菜谱」', async () => {
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { id: 'own-1', name: '外婆的红烧肉' } } as never)
  mount('/recipes/own-1/edit')

  await waitFor(() => expect(value('菜名')).toBe('外婆的红烧肉'))
  fireEvent.click(screen.getByRole('button', { name: '删掉这道' }))

  expect(remove).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('会从你们家的菜谱里删掉')
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

  await waitFor(() => expect(remove).toHaveBeenCalledWith('/recipes/own-1'))
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/recipes/mine'))
})

it('编辑：取不到那道菜时给错误与重试，不是一张空表单（空表单提交等于另建一道）', async () => {
  const notFound = { isAxiosError: true, response: { status: 404, data: {} } }
  mount('/recipes/own-1/edit', own, (url) => {
    if (url === '/recipes/filters') return { data: { categories: [], cuisines: [] } }
    throw notFound
  })

  expect(await screen.findByText('这道菜谱暂时打不开')).toBeTruthy()
  expect(screen.getByText('这道菜谱没有找到，去菜谱大全看看吧。')).toBeTruthy()
  // 拿不到详情就不画表单：一张空表单提交出去等于又新建了一道
  expect(screen.queryByLabelText('菜名')).toBeNull()
  expect(screen.getByRole('button', { name: '再试一次' })).toBeTruthy()
})
