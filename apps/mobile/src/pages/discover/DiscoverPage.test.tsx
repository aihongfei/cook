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

it('三条出路都在，且按"马上给一道 / 等一会儿给几道"分成两行（F5-05 新增第三个）', async () => {
  mockRecipes(12)
  renderDiscover()

  await screen.findByText('摇一道')
  expect(screen.getByText('帮我决定')).toBeTruthy()
  // 「AI 帮你想」在按钮与抽屉标题里各有一处，所以这里只断言"按钮"有一处
  expect(screen.getAllByRole('button', { name: /AI 帮你想/ })).toHaveLength(1)

  /*
   * 分行不是排版偏好，是**承诺**的区别：上面两个立刻给一道，下面那个给几道、要等十几秒。
   * 三件挤一行的话每格只剩 103px（391 宽的屏），"AI 帮你想"会被截成省略号——
   * 一个说不全名字的按钮比多占一行糟得多（见 shared.scss 的 .today__row）。
   */
  const rows = [...document.querySelectorAll('.today__row')].map((row) =>
    [...row.querySelectorAll('button')].map((button) => button.textContent?.replace(/\s+/g, '')),
  )
  expect(rows).toEqual([['🎲摇一道', '✨帮我决定'], ['🍳AI帮你想']])

  /*
   * 第二行那一个必须**撑满整行**：不撑满时实测只有 102px（内容宽），与上面一行
   * 两个 160px 的按钮并排，看着像"这张卡没做完"。jsdom 算不了布局，所以守规则。
   */
  const css = readFileSync(join(srcDir, 'pages/shared.scss'), 'utf8')
  const aiRow = css.match(/\.today__row--ai\s+\.today__ai\s*\{[^}]*\}/)?.[0] ?? ''
  expect(aiRow, '没读到「AI 帮你想」在独行时撑满的规则').toMatch(/flex:\s*1/)
})

it('同一行里几个按钮的边框宽度一致（否则 flex:1 下不等宽，看着就是歪的）', () => {
  /*
   * 用户 2026-10-13：「为什么有时候会歪」。实测根因不是随机的：这些按钮是
   * `flex: 1`（flex-basis: 0%）平分一行，而 0% 基准下**边框不参与**那份平分——
   * 只有其中一个带 1px 描边时它多占 2px（左右各 1），实测宽度 159 / 161，
   * 中间那道缝也随之偏左 1px。去掉边框两边都是 160；两边都给 1px 又都是 160。
   *
   * 2026-10-13 加了第三个出口「帮我决定」（F5-05）之后这条守卫的范围也跟着变大：
   * 现在**三个**按钮共用同一块公共规则（各自只准改颜色），谁哪天给其中一个
   * 单独加宽度就会破坏等宽——那正是这条用例要拦住的。
   *
   * jsdom 算不了布局，所以守**决定这件事的那条规则**（与 corner-art.test 同一手法）。
   */
  const css = readFileSync(join(srcDir, 'pages/shared.scss'), 'utf8')
  const common =
    css.match(/\.today__shake,\s*\.today__decide,\s*\.today__ai\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(common, '没读到 .today__shake, .today__decide, .today__ai 的公共规则').toBeTruthy()
  expect(common, '边框宽度必须在公共规则里定死（1px 透明占位）').toContain('border: 1px solid transparent')

  /*
   * 找各按钮的独立规则时**必须先跳过公共块**：公共块里正好也有 `.today__ai {` 那一行，
   * 直接在整个文件里匹配会先抓到它（第一版就是这么红的——断言读到的其实是公共块，
   * 看着像"AI 那句没写边框颜色"）。
   */
  const after = css.slice(css.indexOf(common) + common.length)
  /*
   * ⚠️ 必须匹配**行首**的独立规则（`m` + `^`）：`.today__row .today__decide { flex: 1 }`
   * 这种后代选择器里也含 `.today__decide {`，不锚行首就会先抓到它，
   * 于是断言读到的是"只写了 flex"的那条，看着像"没写边框颜色"。
   */
  const ruleOf = (name: string) => after.match(new RegExp(`^\\.${name}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? ''

  for (const name of ['today__shake', 'today__decide', 'today__ai']) {
    const rule = ruleOf(name)
    expect(rule, `没读到 .${name} 的独立规则`).toBeTruthy()
    // 只准改颜色（需要描边的写 border-color）；再写一遍 border 就破坏同排等宽
    expect(rule, `.${name} 不该自带边框宽度（写了就破坏同排等宽）`).not.toMatch(/border\s*:/)
  }

  expect(ruleOf('today__ai'), '「AI 帮你想」只该改边框颜色').toMatch(/border-color\s*:/)
  expect(ruleOf('today__decide'), '「帮我决定」只该改边框颜色').toMatch(/border-color\s*:/)
})
