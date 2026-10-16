/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import { useSpreadSession } from '@/stores/spread-session'
import DiscoverPage from './DiscoverPage'

// 发现页首页那块「今天吃什么」（D-026 / D-061 / D-072）。要盯住的事：
// ① 「摇一桌」开得出来抽屉，并且**摇的是后端配的那一桌**（不是前端自己随机拼的）；
// ② 空库时说人话（"还没有菜可配"）而不是静默失败；
// ③ 两个 AI 入口都开得出来（合并之后它们的入口位置变了，容易改坏）；
// ④ 两条出路并排等宽（用户当场报过"看着歪"）。

/** 样式文件所在目录（读 scss 做断言用，见 corpus-art.test 的同一手法） */
const srcDir = join(__dirname, '..', '..')

const clients: QueryClient[] = []

function renderDiscover() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      {/* Toaster 挂在应用根部（main.tsx），测试树里要自己挂上，否则提示渲染不出来 */}
      <MemoryRouter initialEntries={['/discover']}>
        <Routes>
          <Route path="/discover" element={<DiscoverPage />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

function recipe(id: string, name: string) {
  return { id, name, image: null, category: '素菜', cuisine: '家常', tags: [], calories: 100, caloriesEstimated: false }
}

/** 一桌菜：`count` 道，带角色与理由（形状与后端 `GET /discover/spread` 一致） */
function spread(count: number) {
  const roles = ['meat', 'veg', 'soup', 'other'] as const
  const labels: Record<string, string> = { meat: '荤菜', veg: '素菜', soup: '汤', other: '另配' }
  return {
    scope: 'family',
    mealKey: '2026-10-15-DINNER',
    date: '2026-10-15',
    meal: 'DINNER',
    mealLabel: '晚餐',
    diners: 4,
    dinersFromMeal: false,
    count,
    reason: `按 4 个人算，配了 ${count} 道`,
    fridgeEmpty: false,
    items: Array.from({ length: count }, (_, i) => ({
      ...recipe(`r${i}`, `第${i}道菜`),
      role: roles[i % 4],
      roleLabel: labels[roles[i % 4]],
      reason: `做过 ${i + 1} 次`,
      have: [],
      missing: [],
      soon: [],
      cooked: i + 1,
      lastCookedOn: null,
    })),
  }
}

/** 发现页要的那几个接口（`/discover/spread` 换成 `mockSpread` 覆写） */
function mockApi(overrides: Record<string, unknown> = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url in overrides) return Promise.resolve({ data: overrides[url] } as never)
    if (url === '/family') return Promise.resolve({ data: { id: 'f1', name: '家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    if (url === '/orders/plan') return Promise.resolve({ data: { scope: 'family', days: [] } } as never)
    if (url === '/orders/options') return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [{ value: '2026-10-15', label: '今天' }] } } as never)
    if (url === '/ai/status') return Promise.resolve({ data: { configured: true, model: 'm' } } as never)
    if (url === '/recipes') return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 12 } } as never)
    /*
     * 2026-10-16 加的几块（D-108）。上一条用例只关心「今天吃什么」那一块，
     * 但页面会把三块新东西一起画出来——不给它们数据就会走 error 分支，
     * 于是每一条用例都在渲染三条"暂时打不开"，噪声大且掩盖真问题。
     * 这里给**空但合法**的响应（新家庭那一档正是这个样子）。
     */
    if (url === '/discover/seasonal') return Promise.resolve({ data: { season: '秋', title: '秋日时令', note: '', count: 0, tagQuery: '秋季', items: [] } } as never)
    if (url === '/discover/flip') return Promise.resolve({ data: { limit: 12, remaining: 0, items: [] } } as never)
    if (url === '/discover/report') return Promise.resolve({ data: { scope: 'family', month: '2026-10', report: null } } as never)
    if (url === '/discover/occasions') return Promise.resolve({ data: { items: [] } } as never)
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
  /*
   * 「摇一桌」的会话状态也是**模块级**的（它要活过路由跳转，见 stores/spread-session）：
   * 上一条用例把抽屉开着、`asked` 置成了 true，不清掉的话下一条里抽屉是开的、
   * 而且不会再去摇——症状是"找不到那句头部话术"，看着像组件坏了。
   */
  useSpreadSession.getState().close()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('「摇一桌」打开抽屉，并摇出**后端配的那一桌**（不是前端自己随机拼的）', async () => {
  mockApi({ '/discover/spread': spread(4) })
  renderDiscover()

  fireEvent.click(await screen.findByText('摇一桌'))
  // 头部那句由后端拼、前端照搬：出现它就说明这一桌真的来自 /discover/spread
  expect(await screen.findByText('按 4 个人算，配了 4 道')).toBeTruthy()
  for (let i = 0; i < 4; i += 1) expect(screen.getByText(`第${i}道菜`)).toBeTruthy()
  // 每道都带自己那句理由（一句真事都没有时后端给空串，界面上就不显示理由）
  expect(screen.getByText('做过 1 次')).toBeTruthy()
  // 角色标签（荤菜/素菜/汤/另配）是后端的说法，前端不自己维护第二份对照
  expect(screen.getByText('汤')).toBeTruthy()
})

it('空库时说人话，给出去处，不给一桌编的', async () => {
  mockApi({ '/discover/spread': { ...spread(0), reason: '菜谱小书里还没有菜，先去加几道' } })
  renderDiscover()

  fireEvent.click(await screen.findByText('摇一桌'))
  expect(await screen.findByText('菜谱小书里还没有菜，先去加几道')).toBeTruthy()
  expect(screen.getByText(/去菜谱小书里加几道/)).toBeTruthy()
})

it('这一餐没存过人数时，才给"改人数"的入口（存过就以存着的为准，摆不生效的按钮更糟）', async () => {
  mockApi({ '/discover/spread': spread(3) })
  renderDiscover()
  fireEvent.click(await screen.findByText('摇一桌'))

  expect(await screen.findByText('不是 4 个人？')).toBeTruthy()
  expect(screen.getByRole('button', { name: '2 人' })).toBeTruthy()
})

it('问答入口（问 AI）还在，且打得开', async () => {
  mockApi()
  renderDiscover()

  expect(await screen.findByText(/问 AI/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '点这里问 AI →' }))
  expect(await screen.findByText(/拿不准的都能问/)).toBeTruthy()
})

it('发现页不再有那三格假数字，本周菜单也整卡删掉（D-040 / 2026-10-16 改版）', async () => {
  mockApi()
  renderDiscover()

  await screen.findByText('摇一桌')
  // 三格（85 私房菜 / 12 冰箱食材 / 3 临期）是 M0 拼版面用的写死数据：
  // 库内实际 600 道、冰箱功能还没做。它们该是**冰箱页**的数据，不该在发现页，
  // 更不该是假的。这条守住"别哪天又给加回来"。
  expect(document.querySelector('.stats')).toBeNull()
  for (const ghost of ['私房菜', '冰箱食材', '临期']) expect(screen.queryByText(ghost)).toBeNull()

  /*
   * 「本周菜单」2026-10-16 整卡删掉（用户：「发现也不要展示本周菜单了」）：
   * 那是**同一份数据在第三个地方画的只读副本**（点单页能操作、备菜计划排到第 7 天），
   * 实测占 508px。删卡之后它原来的两个出口必须接住——那是它们唯一的入口，
   * 所以搬成页面底部一行两枚工具胶囊（`.discover-tools`）。
   */
  expect(document.querySelector('.weekplan')).toBeNull()
  const tools = [...document.querySelectorAll('.discover-tool')].map((tool) =>
    tool.textContent?.replace(/\s+/g, ''),
  )
  expect(tools).toEqual(['🧩常用组合', '🗓备菜计划'])
})

it('问 AI 那行只有后半句可点：前半句是说明，不该看着像按钮', async () => {
  mockApi()
  renderDiscover()

  const hint = await screen.findByText('下厨上的问题想问问人？')
  // 说明是纯文本；改回整行一个 button 的话这条会红——那正是用户报的问题
  expect(hint.tagName).toBe('SPAN')
  expect(hint.closest('button')).toBeNull()

  // 点它确实打开问答抽屉（不是只有样式像链接）
  fireEvent.click(screen.getByRole('button', { name: '点这里问 AI →' }))
  expect(await screen.findByText(/拿不准的都能问/)).toBeTruthy()
})

it('两条出路并排一行，AI 收进抽屉（2026-10-13 用户提出重复后合并，D-061）', async () => {
  mockApi()
  renderDiscover()

  await screen.findByText('摇一桌')
  expect(screen.getByText('帮我决定')).toBeTruthy()
  /*
   * 「AI 帮你想」**不再单独占一行**：它已经收进「帮我决定」那个抽屉的第二半。
   * 这条守住的就是这件事——哪天有人把它加回卡上，用户提出的那个重复就又回来了
   * （三个出口里两个都叫"我替你决定"）。
   */
  expect(screen.queryByText('AI 帮你想')).toBeNull()

  const rows = [...document.querySelectorAll('.today__row')].map((row) =>
    [...row.querySelectorAll('button')].map((button) => button.textContent?.replace(/\s+/g, '')),
  )
  expect(rows).toEqual([['🎲摇一桌', '✨帮我决定']])

  /*
   * 两个按钮必须**等宽平分**那一行（用户 2026-10-13：「为什么有时候会歪」那条的延续）：
   * jsdom 算不了布局，所以守决定这件事的规则。
   */
  const css = readFileSync(join(srcDir, 'pages/shared.scss'), 'utf8')
  const rowRule = css.match(/\.today__row\s+\.today__shake,\s*\n\.today__row\s+\.today__decide\s*\{[^}]*\}/)?.[0] ?? ''
  expect(rowRule, '没读到同一行两个按钮平分的规则').toMatch(/flex:\s*1/)
})

it('同一行里两个按钮的边框宽度一致（否则 flex:1 下不等宽，看着就是歪的）', () => {
  /*
   * 用户 2026-10-13：「为什么有时候会歪」。实测根因不是随机的：这些按钮是
   * `flex: 1`（flex-basis: 0%）平分一行，而 0% 基准下**边框不参与**那份平分——
   * 只有其中一个带 1px 描边时它多占 2px（左右各 1），实测宽度 159 / 161，
   * 中间那道缝也随之偏左 1px。去掉边框两边都是 160；两边都给 1px 又都是 160。
   *
   * jsdom 算不了布局，所以守**决定这件事的那条规则**（与 corner-art.test 同一手法）。
   */
  const css = readFileSync(join(srcDir, 'pages/shared.scss'), 'utf8')
  const common = css.match(/\.today__shake,\s*\n\.today__decide\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(common, '没读到 .today__shake, .today__decide 的公共规则').toBeTruthy()
  expect(common, '边框宽度必须在公共规则里定死（1px 透明占位）').toContain('border: 1px solid transparent')

  /*
   * 各自的独立规则**必须锚行首**（`m` + `^`）：`.today__row .today__decide { flex: 1 }`
   * 这种后代选择器里也含 `.today__decide {`，不锚行首就会先抓到它，
   * 于是断言读到的是"只写了 flex"的那条，看着像"没写边框颜色"。
   */
  const after = css.slice(css.indexOf(common) + common.length)
  const ruleOf = (name: string) => after.match(new RegExp(`^\\.${name}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? ''

  for (const name of ['today__shake', 'today__decide']) {
    const rule = ruleOf(name)
    expect(rule, `没读到 .${name} 的独立规则`).toBeTruthy()
    // 只准改颜色（需要描边的写 border-color）；再写一遍 border 就破坏同排等宽
    expect(rule, `.${name} 不该自带边框宽度（写了就破坏同排等宽）`).not.toMatch(/border\s*:/)
  }

  // 需要描边的那个必须用 border-color（不是重新写一遍 border）
  expect(ruleOf('today__decide'), '「帮我决定」只该改边框颜色').toMatch(/border-color\s*:/)
})
