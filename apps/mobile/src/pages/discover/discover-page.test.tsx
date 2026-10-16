/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig } from 'axios'
import { apiClient } from '@/api/client'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import { useTodaySession } from '@/stores/today-session'
import DiscoverPage from './DiscoverPage'

/**
 * 发现页 2026-10-16 加的两块（时令精选 / 家庭月报，见 D-110）。
 *
 * 这一批要盯住的是**几条容易悄悄坏掉的规矩**，不是"渲染出来了没有"：
 * ① 时令那一行数字与点进去的筛选必须同源（都是标签精确筛，不是搜索兜）；
 * ② 月报不足 3 顿**整块不画**（不是画一堆 0）；
 * ③ 「换个场合挑」是**可选**的：默认不问场合，选了才带参数——而且它没让页面上多出一块。
 *
 * 「翻牌子」原本是这一批的第三块，用户当天看完预览后定「不要翻牌子了」，
 * 组件、接口、测试一并删掉（决定记在 D-110）。
 */

const srcDir = join(__dirname, '..', '..')
const clients: QueryClient[] = []

function renderDiscover() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/discover']}>
        <Routes>
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/recipes" element={<div data-testid="recipe-list" />} />
          <Route path="/recipes/:id" element={<div data-testid="recipe-detail" />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const SEASONAL = {
  season: '秋',
  title: '秋日时令',
  note: '天凉了，这些正当时',
  count: 38,
  tagQuery: '秋季,秋季菜谱,秋季养生',
  items: [
    { id: 's1', name: '三色补血汤', image: null, category: '主食', cuisine: '家常' },
    { id: 's2', name: '五彩鲜贝', image: null, category: '荤菜', cuisine: '家常' },
  ],
}

const REPORT = {
  scope: 'family' as const,
  month: '2026-10',
  report: { meals: 10, done: 4, kinds: 10, photos: 6, topDish: '红烧排骨', topDishOn: '10/16', line: '最常做的是 红烧排骨（10/16）。' },
}

function mockApi(overrides: Record<string, unknown> = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url in overrides) return Promise.resolve({ data: overrides[url] } as never)
    if (url === '/family') return Promise.resolve({ data: { id: 'f1', name: '小满一家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    if (url === '/orders/plan') return Promise.resolve({ data: { scope: 'family', days: [] } } as never)
    if (url === '/orders/options') return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [{ value: '2026-10-16', label: '今天' }] } } as never)
    if (url === '/ai/status') return Promise.resolve({ data: { configured: false, model: '' } } as never)
    if (url === '/discover/family-picks') return Promise.resolve({ data: { scope: 'family', limit: 8, total: 0, items: [] } } as never)
    if (url === '/discover/seasonal') return Promise.resolve({ data: SEASONAL } as never)
    if (url === '/discover/report') return Promise.resolve({ data: REPORT } as never)
    if (url === '/discover/occasions') {
      return Promise.resolve({
        data: {
          items: [
            { label: '不想费劲', tag: '快手菜', count: 74 },
            { label: '干饭要香', tag: '下饭菜', count: 46 },
            { label: '来客人了', tag: '宴请', count: 33 },
            { label: '做给孩子', tag: '儿童', count: 33 },
          ],
        },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'a', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' },
  })
  useTodaySession.getState().close()
})

afterEach(() => {
  cleanup()
  useToasts.setState({ items: [] })
  useTodaySession.getState().close()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('时令精选：标题与道数来自后端，那一行走的是**标签精确筛**而不是搜索', async () => {
  mockApi()
  renderDiscover()

  // 季节由后端算（前端不自己按月份挑），所以标题与那句话都是照搬
  expect(await screen.findByText('秋日时令')).toBeTruthy()
  expect(screen.getByText('天凉了，这些正当时')).toBeTruthy()

  const more = screen.getByRole('link', { name: '38 道 ›' })
  /*
   * 关键那一条：`?tag=` 而不是 `?q=`。两者今天返回的**是同一批菜**（实测过），
   * 但判据不同：`q` 命中"文本里出现过这两个字"（菜名、食材名都算），
   * `tag` 才是"打了这个标签"。界面上那个数字用户会拿来判断值不值得点，
   * 所以接线必须接在稳定判据上（见后端 recipe.query 的 tagList）。
   */
  const href = more.getAttribute('href') ?? ''
  expect(href).toContain('tag=')
  expect(href).not.toContain('q=')
  // 三个季节标签都要带上（只取「秋季」会漏掉「秋季菜谱」「秋季养生」那 5 道）
  expect(decodeURIComponent(href)).toContain('秋季,秋季菜谱,秋季养生')

  // 一屏只画后端给的那几道（橱窗，不是列表）
  expect(screen.getByText('三色补血汤')).toBeTruthy()
  expect(screen.getByText('五彩鲜贝')).toBeTruthy()
})

it('时令精选的图与名字那一层必须是 block（行内元素吃不上宽高，卡会变成参差不齐）', () => {
  /*
   * 预览里实测过一次：`.season__pic` 是 `<span>`，没写 `display:block` 时
   * 里面的图按原始尺寸铺开，这一块从 114px 涨到 230px。jsdom 算不了布局，
   * 所以守那条规则本身（与 DiscoverPage.test 守 .today__row 同一手法）。
   */
  const css = readFileSync(join(srcDir, 'pages/discover/discover.scss'), 'utf8')
  const rule = css.match(/\.season__pic\s*\{[^}]*\}/)?.[0] ?? ''
  expect(rule, '没读到 .season__pic 的规则').toBeTruthy()
  expect(rule).toMatch(/display:\s*block/)
  expect(rule).toMatch(/width:\s*116px/)
  expect(rule).toMatch(/height:\s*84px/)
})

it('时令精选的底色跟着**后端给的季节**走，不按月份在前端算一遍', async () => {
  /*
   * 2026-10-16 补的底（用户：「这块的样式优化下，加个背景啥的」）。这条守两件事：
   * ① 季节这个值只有一个来源——后端 `season` 字段直接挂到 `data-season` 上。
   *    前端自己按月份再算一遍的话，月初月末会出现"标题写秋日时令、底是夏天绿"，
   *    而那种偏差平时看不见，只有跨月那两天露头。
   * ② 四个季节都得有颜色，且四季的规则要从样式表里真读得到（写漏一个 = 那一季没底）。
   */
  mockApi()
  renderDiscover()

  /*
   * 等的是**属性挂上去**，不是元素出现：`.season` 这一层在数据到之前就在 DOM 里
   * （它同时要装加载态），只等元素的话第一轮就返回了、属性还是 null——
   * 拿到的红会看着像"组件没挂 data-season"，其实只是问早了。
   */
  await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.season')
    expect(el?.getAttribute('data-season')).toBe('秋')
  })

  const css = readFileSync(join(srcDir, 'pages/discover/discover.scss'), 'utf8')
  for (const season of ['春', '夏', '秋', '冬']) {
    expect(css, `${season}缺一个色`).toMatch(new RegExp(`\\.season\\[data-season='${season}'\\]\\s*\\{[^}]*--season-tint:`))
  }
})

it('栏距加在**卡身**上（这样滚动中途右侧也露着底色），且只加这一处', () => {
  /*
   * 这一条改过两版，现在的形状是用户 2026-10-16 亲口定的：
   * 「这块右侧也需要留白，**有滚动时也要**」「你就给外层容器一个 padding 不就好了」。
   *
   * 前一版右边是 0（横滑行贴到卡的边上滑）：静止时看着行，**一滚就露馅**——
   * 被裁的卡片是在卡的边缘被裁的，右边一点底色都没有，像缺了一块。
   * 栏距挪到卡身之后，滚动区整体内缩，右边始终露 15px 的当季底色
   * （实测：`listRight` 358 = 卡右缘 374 − 16；滚到一半时被裁的那张也停在 358）。
   *
   * 守三条：
   * ① 卡身左右都有栏距（写成 0 就退回那个"一滚就贴边"的版本）；
   * ② 横滑行**自己不再垫左右**——两处都有就叠加成 30px，右边明显比别处空一截；
   * ③ 不要再挂末尾垫片元素：本机 Chromium 实测 `overflow-x` 不会吃掉右内边距，
   *    垫片是纯叠加（量出来右缝 40px）。
   */
  const css = readFileSync(join(srcDir, 'pages/discover/discover.scss'), 'utf8')
  const cardRule = css.match(/^\.season\s*\{[^}]*\}/m)?.[0] ?? ''
  expect(cardRule, '没读到 .season 的规则').toBeTruthy()
  expect(cardRule).toMatch(/padding:\s*14px\s+var\(--season-gutter\)\s+12px/)
  expect(cardRule).toMatch(/overflow:\s*hidden/)

  const listRule = css.match(/\.season__list\s*\{[^}]*\}/)?.[0] ?? ''
  expect(listRule, '没读到 .season__list 的规则').toBeTruthy()
  // 横滑行自己不垫左右（上下由卡身负责；这里只留 2px 给文字的下沉）
  expect(listRule).toMatch(/padding:\s*0\s+0\s+2px/)

  expect(css, '末尾垫片会与栏距叠加，不要加').not.toMatch(/\.season__end\s*\{/)
  const tsx = readFileSync(join(srcDir, 'pages/discover/components/SeasonalPicks.tsx'), 'utf8')
  expect(tsx).not.toContain('season__end')
})

it('家庭月报：四个数是后端的，那句脚注也是后端的（前端不改一个字）', async () => {
  mockApi()
  renderDiscover()

  expect(await screen.findByText('十月')).toBeTruthy()
  for (const label of ['一起吃了', '真的做了', '试过的菜', '拍的照片']) {
    expect(screen.getByText(label)).toBeTruthy()
  }
  expect(screen.getByText('最常做的是 红烧排骨（10/16）。')).toBeTruthy()
  // 不给谁打分：这一页只写全家一起的数，不写"谁做得最多"
  expect(screen.queryByText(/做得最多/)).toBeNull()
})

it('月报不足 3 顿时**整块不画**（后端给 null，不是画一堆 0）', async () => {
  mockApi({ '/discover/report': { scope: 'family', month: '2026-10', report: null } })
  renderDiscover()

  // 等页面稳定（时令那块出来了就说明各块都渲染过一轮）
  await screen.findByText('秋日时令')
  expect(document.querySelector('.report')).toBeNull()
  expect(screen.queryByText('一起吃了')).toBeNull()
  expect(screen.queryByText('真的做了')).toBeNull()
})

it('「换个场合挑」在抽屉里，默认一个都不选；选了才给 decide 带上那枚标签', async () => {
  /*
   * 用一个**可变**的场合变量记下 decide 收到的参数，而不是中途换掉整个 mock：
   * 换 mock 会把别的接口（场合词那一份）一起打空，症状是"胶囊没渲染出来"——
   * 那种红看着像组件坏了，其实是测试自己把数据抽走了。
   */
  let askedOccasion: string | undefined | null = null
  const decideResult = (name: string, reason: string, occasion?: string) => ({
    scope: 'family',
    reason,
    fridgeEmpty: false,
    canSwap: true,
    ...(occasion ? { occasion, occasionLabel: '来客人了' } : {}),
    recipe: { id: `d-${name}`, name, image: null, category: '荤菜', cuisine: '家常', calories: null, caloriesEstimated: false, have: [], missing: [], cooked: 0, favorites: 0 },
  })
  vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: AxiosRequestConfig) => {
    if (url === '/discover/decide') {
      askedOccasion = (config?.params as { occasion?: string } | undefined)?.occasion
      return Promise.resolve({
        data: askedOccasion
          ? decideResult('宫保虾仁', '按你说的「来客人了」挑的；库里挑的，今天换换口味', askedOccasion)
          : decideResult('蒜蓉粉丝蒸虾', '冰箱里的 虾 正好能做这道'),
      } as never)
    }
    if (url === '/family') return Promise.resolve({ data: { id: 'f1', name: '小满一家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    if (url === '/ai/status') return Promise.resolve({ data: { configured: false, model: '' } } as never)
    if (url === '/orders/options') return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [{ value: '2026-10-16', label: '今天' }] } } as never)
    if (url === '/discover/family-picks') return Promise.resolve({ data: { scope: 'family', limit: 8, total: 0, items: [] } } as never)
    if (url === '/discover/seasonal') return Promise.resolve({ data: { ...SEASONAL, items: [] } } as never)
    if (url === '/discover/report') return Promise.resolve({ data: { scope: 'family', month: '2026-10', report: null } } as never)
    if (url === '/discover/occasions') {
      return Promise.resolve({ data: { items: [
        { label: '不想费劲', tag: '快手菜', count: 74 },
        { label: '干饭要香', tag: '下饭菜', count: 46 },
        { label: '来客人了', tag: '宴请', count: 33 },
        { label: '做给孩子', tag: '儿童', count: 33 },
      ] } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  renderDiscover()

  // 页面上**不该**再有独立的一块场景词（2026-10-16 并入抽屉，见 D-110）
  await screen.findByText('秋日时令')
  expect(document.querySelector('.scenes')).toBeNull()
  expect(screen.queryByText('今天想吃什么感觉的')).toBeNull()

  // 打开「帮我决定」抽屉：不给场合也要能出结果（默认那条路一个字没变）
  fireEvent.click(screen.getByText('帮我决定'))
  expect(await screen.findByText('蒜蓉粉丝蒸虾')).toBeTruthy()
  expect(askedOccasion).toBeUndefined()

  // 四枚胶囊都在，默认一个都没选中（这一行是**可选**的收窄条件）
  for (const label of ['不想费劲', '干饭要香', '来客人了', '做给孩子']) {
    expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false')
  }

  fireEvent.click(screen.getByRole('button', { name: '来客人了' }))

  // 换了一道，并把后端拼的那句话原样显示（含"按你说的…"那半句）
  expect(await screen.findByText('宫保虾仁')).toBeTruthy()
  expect(askedOccasion).toBe('宴请')
  expect(screen.getByText('按你说的「来客人了」挑的；库里挑的，今天换换口味')).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: '来客人了' }).getAttribute('aria-pressed')).toBe('true'))

  // 再点一下 = 取消（回到不问场合那道）：用户取消限制就是要重挑，不是把胶囊弹起来
  fireEvent.click(screen.getByRole('button', { name: '来客人了' }))
  expect(await screen.findByText('蒜蓉粉丝蒸虾')).toBeTruthy()
  expect(askedOccasion).toBe('')
  await waitFor(() => expect(screen.getByRole('button', { name: '来客人了' }).getAttribute('aria-pressed')).toBe('false'))
})
