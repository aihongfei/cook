/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import DiscoverPage from './DiscoverPage'

// 发现页首页那块「今天吃什么」（D-026：随机 + AI 合一）。要盯住的事：
// ① 「摇一道」真会跳走，而且**跳到随机那一道**（不是永远第一道——那就不叫摇）；
// ② 空库时说人话（"还没有菜"）而不是静默失败；
// ③ 两个 AI 入口都开得出来（合并之后它们的入口位置变了，容易改坏）。

/** 样式文件所在目录（读 scss 做断言用，见 corpus-art.test 的同一手法） */
const srcDir = join(__dirname, '..', '..')

const clients: QueryClient[] = []

function RecipeProbe() {
  return <div data-testid="recipe-page">菜谱详情</div>
}

function renderDiscover() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      {/* Toaster 挂在应用根部（main.tsx），测试树里要自己挂上，否则提示渲染不出来 */}
      <MemoryRouter initialEntries={['/discover']}>
        <Routes>
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/recipes/:id" element={<RecipeProbe />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

function recipe(id: string, name: string) {
  return { id, name, image: null, category: '素菜', cuisine: '家常', tags: [], calories: 100, caloriesEstimated: false }
}

/** 库里有 total 道菜；pageSize=12 的列表分页返回对应那一段 */
function mockRecipes(total: number) {
  const all = Array.from({ length: total }, (_, i) => recipe(`r${i}`, `第${i}道菜`))
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: unknown) => {
    if (url === '/recipes') {
      const page = (config as { params?: { page?: number } } | undefined)?.params?.page ?? 1
      return Promise.resolve({
        data: { items: all.slice((page - 1) * 12, page * 12), total, page, pageSize: 12 },
      } as never)
    }
    if (url === '/family') return Promise.resolve({ data: { id: 'f1', name: '家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    if (url === '/orders/plan') return Promise.resolve({ data: { scope: 'family', days: [] } } as never)
    if (url === '/orders/options') return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [] } } as never)
    if (url === '/ai/status') return Promise.resolve({ data: { configured: true, model: 'm' } } as never)
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'a', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' },
  })
})

afterEach(() => {
  cleanup()
  // toast 是模块级 store，不清会带到下一条用例
  useToasts.setState({ items: [] })
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('「摇一道」跳到随机那一道（random 钉死成"取最后一个"时不能还是第一道）', async () => {
  mockRecipes(30)
  // random() 固定返回 0.999 → 下标落在最后一个（第 29 道，落在第 3 页）。
  // 不钉死的话"随机"这件事只能靠概率验，会偶发地假红
  vi.spyOn(Math, 'random').mockReturnValue(0.999)
  renderDiscover()

  fireEvent.click(await screen.findByText('摇一道'))
  expect(await screen.findByTestId('recipe-page')).toBeTruthy()
  const requestedPages = (apiClient.get as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter(([url]) => url === '/recipes')
    .map(([, config]) => (config as { params?: { page?: number } } | undefined)?.params?.page)
  // 第一次问总数（第 1 页），第二次去取目标页（第 3 页）——不是在第 1 页里随便挑一个
  expect(requestedPages).toEqual([1, 3])
})

it('库里有菜但只够一页时不发第二次请求（顺手省一次）', async () => {
  mockRecipes(5)
  vi.spyOn(Math, 'random').mockReturnValue(0.5) // 落到第 1 页
  renderDiscover()

  fireEvent.click(await screen.findByText('摇一道'))
  expect(await screen.findByTestId('recipe-page')).toBeTruthy()
  const pages = (apiClient.get as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter(([url]) => url === '/recipes')
  expect(pages).toHaveLength(1)
})

it('空库时说人话，不跳走也不静默', async () => {
  mockRecipes(0)
  renderDiscover()

  fireEvent.click(await screen.findByText('摇一道'))
  // 留在发现页（没跳路由），并给出可读的提示
  await waitFor(() => expect(screen.queryByTestId('recipe-page')).toBeNull())
  expect(await screen.findByText(/还没有菜/)).toBeTruthy()
})

it('两个 AI 入口都还在（合并成一块之后位置变了，别改丢）', async () => {
  mockRecipes(12)
  renderDiscover()

  const suggest = await screen.findByText('AI 帮你想')
  expect(suggest).toBeTruthy()
  expect(screen.getByText(/问 AI/)).toBeTruthy()

  // 点开「AI 帮你想」：抽屉里的引导文案出现即入口有效
  fireEvent.click(suggest)
  expect(await screen.findByText(/说说想吃什么/)).toBeTruthy()
})

it('发现页不再有那三格假数字，也不再有重复的入口胶囊（2026-10-13 信息架构改版，D-040）', async () => {
  mockRecipes(12)
  renderDiscover()

  await screen.findByText('摇一道')
  // 三格（85 私房菜 / 12 冰箱食材 / 3 临期）是 M0 拼版面用的写死数据：
  // 库内实际 600 道、冰箱功能还没做。它们该是**冰箱页**的数据，不该在发现页，
  // 更不该是假的。这条守住"别哪天又给加回来"。
  expect(document.querySelector('.stats')).toBeNull()
  for (const ghost of ['私房菜', '冰箱食材', '临期']) expect(screen.queryByText(ghost)).toBeNull()
  // 入口胶囊只留跟「本周菜单」走的两个；收藏/点菜不再从发现页重复给
  const pills = [...document.querySelectorAll('.picks__more, .weekplan__more')].map((p) => p.textContent?.trim())
  expect(pills).toEqual(['常用组合 →', '备菜计划 →'])
})

it('问 AI 那行只有后半句可点：前半句是说明，不该看着像按钮', async () => {
  mockRecipes(12)
  renderDiscover()

  const hint = await screen.findByText('下厨上的问题想问问人？')
  // 说明是纯文本；改回整行一个 button 的话这条会红——那正是用户报的问题
  expect(hint.tagName).toBe('SPAN')
  expect(hint.closest('button')).toBeNull()

  // 点它确实打开问答抽屉（不是只有样式像链接）
  fireEvent.click(screen.getByRole('button', { name: '点这里问 AI →' }))
  expect(await screen.findByText(/拿不准的都能问/)).toBeTruthy()
})

it('「摇一道」与「AI 帮你想」的边框宽度一致（否则 flex:1 下两个按钮不等宽，看着就是歪的）', () => {
  /*
   * 用户 2026-10-13：「为什么有时候会歪」。实测根因不是随机的：这两个按钮是
   * `flex: 1`（flex-basis: 0%）平分一行，而 0% 基准下**边框不参与**那份平分——
   * 只有「AI 帮你想」带 1px 描边时它多占 2px（左右各 1），实测宽度 159 / 161，
   * 中间那道缝也随之偏左 1px。去掉边框两边都是 160；给「摇一道」也加 1px 又都是 160。
   *
   * jsdom 算不了布局，所以守**决定这件事的那条规则**（与 corner-art.test 同一手法）：
   * 谁哪天只给其中一个加/去边框，这条就会红。
   */
  const css = readFileSync(join(srcDir, 'pages/shared.scss'), 'utf8')
  const common = css.match(/\.today__shake,\s*\.today__ai\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(common, '没读到 .today__shake, .today__ai 的公共规则').toBeTruthy()
  expect(common, '两个按钮的边框宽度必须在公共规则里定死（1px 透明占位）').toContain('border: 1px solid transparent')

  /*
   * 找「AI 帮你想」那条独立规则时**必须先跳过公共块**：公共块的第二行正好是
   * `.today__ai {`，直接在整个文件里匹配会先抓到它（第一版就是这么红的——
   * 断言读到的其实是公共块，看着像"AI 那句没写边框颜色"）。
   */
  const after = css.slice(css.indexOf(common) + common.length)
  const ai = after.match(/\.today__ai\s*\{[^}]*\}/)?.[0] ?? ''
  expect(ai, '没读到 .today__ai 的独立规则').toBeTruthy()
  expect(ai, '「AI 帮你想」只该改边框颜色').toMatch(/border-color\s*:/)
  expect(ai, '「AI 帮你想」不该再写边框宽度（写了就破坏等宽）').not.toMatch(/border\s*:/)

  const shake = after.match(/\.today__shake\s*\{[^}]*\}/)?.[0] ?? ''
  expect(shake, '没读到 .today__shake 的独立规则').toBeTruthy()
  expect(shake, '「摇一道」不该自带边框宽度（会与公共规则打架）').not.toMatch(/border\s*:/)
})
