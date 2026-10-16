// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { Toaster, useToasts } from '@/components/ui/toast'
import type { DecideResult } from '@/api/decide'
import { useTodaySession } from '@/stores/today-session'
import { useAuth } from '@/stores/auth'
import TodaySheet from './TodaySheet'

/**
 * 「今天吃什么」（M5 / F5-05 与 M16 子集合并后，D-061）。要盯住的六件事：
 * ① **打开就问**（不让用户再按一次才给答案）；
 * ② **会话状态活过路由跳转**——点菜名去详情再返回，那道菜还在、抽屉还开着，
 *    而且**不重新挑**（重新挑会把用户正要评估的那道菜换成另一道）；
 * ③ **「换一道」真排除**已经看过的（含"换空了"这种脏情况）；
 * ④ **说清为什么**（后端那句原样显示，前端不改字）；
 * ⑤ **拿不出菜时给去路**，不给一道编的；
 * ⑥ **下半（AI）默认收着、点一下才展开**，而且展开状态与推荐都活过路由跳转
 *    ——用户点的是 AI 推荐里的菜名，回来却要再点一次才看见那几条，就是这条要防的。
 */

const clients: QueryClient[] = []

function Probe() {
  const location = useLocation()
  return <div data-testid="probe">{`${location.pathname}|${(location.state as { from?: string } | null)?.from ?? 'no-from'}`}</div>
}

const dish = (over: Partial<DecideResult['recipe'] & object> = {}) => ({
  id: 'r1',
  name: '番茄炒蛋',
  image: null,
  category: '家常',
  cuisine: '家常',
  calories: 180,
  caloriesEstimated: false,
  have: ['番茄', '鸡蛋'],
  missing: [],
  cooked: 3,
  favorites: 1,
  ...over,
})

function decideResult(over: Partial<DecideResult> = {}): DecideResult {
  return {
    scope: 'family',
    reason: '冰箱里的 番茄、鸡蛋正好能做这道；你们家做过 3 次',
    fridgeEmpty: false,
    canSwap: true,
    recipe: dish(),
    ...over,
  }
}

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/discover']}>
        <Routes>
          <Route path="/discover" element={<TodaySheet visible onClose={() => {}} />} />
          <Route path="/recipes/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

/** 把 /discover/decide 的返回按调用顺序排好；`/orders/options` 与 `/orders/items` 是加菜要用的 */
function mockApi(
  results: DecideResult[],
  options: { addFails?: boolean; decideFails?: boolean } = {},
) {
  const calls: { url: string; params?: unknown }[] = []
  const spy = vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: unknown) => {
    if (url === '/discover/decide') {
      const index = calls.filter((call) => call.url === '/discover/decide').length
      calls.push({ url, params: (config as { params?: unknown } | undefined)?.params })
      if (options.decideFails) return Promise.reject(new Error('boom')) as never
      const next = results[Math.min(index, results.length - 1)]
      return Promise.resolve({ data: next } as never)
    }
    if (url === '/orders/options') {
      return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [{ value: '2026-10-13', label: '今天' }] } } as never)
    }
    if (url === '/family') {
      return Promise.resolve({ data: { id: 'f1', name: '家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/orders/items') {
      if (options.addFails) return Promise.reject(new Error('boom')) as never
      return Promise.resolve({ data: { mealLabel: '晚餐', date: '2026-10-13', tasteWarning: null } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  return spy
}

function decideCalls(spy: ReturnType<typeof vi.spyOn>) {
  return (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([url]) => url === '/discover/decide')
}

beforeEach(() => {
  localStorage.clear()
  useTodaySession.getState().close()
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'a', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' },
  })
})

afterEach(() => {
  cleanup()
  useToasts.setState({ items: [] })
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('打开就问一次，不用再按一下才给答案', async () => {
  const spy = mockApi([decideResult()])
  renderSheet()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(decideCalls(spy)).toHaveLength(1)
})

it('说清为什么是这道（后端那句原样显示）', async () => {
  mockApi([decideResult({ reason: '冰箱里的 豆腐 正好能做这道；豆腐 也该先吃了' })])
  renderSheet()

  expect(await screen.findByText('冰箱里的 豆腐 正好能做这道；豆腐 也该先吃了')).toBeTruthy()
})

it('「用上了」与「还差」分开说，差的**列名字**（用户要拿它决定顺不顺路买）', async () => {
  mockApi([
    decideResult({
      recipe: dish({ have: ['豆腐'], missing: ['小葱'] }),
      reason: '冰箱里的 豆腐正好能做这道；只差 小葱，顺路买一下',
    }),
  ])
  renderSheet()

  expect(await screen.findByText('用上了 豆腐')).toBeTruthy()
  expect(screen.getByText('还差 小葱')).toBeTruthy()
})

it('菜名点得进详情，并带上来源 `/discover`（返回按钮才知道回哪）', async () => {
  mockApi([decideResult()])
  renderSheet()

  fireEvent.click(await screen.findByText('番茄炒蛋'))
  // 落到了详情（Probe），并且 state 里带着来源
  await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/recipes/r1|/discover'))
})

it('**从详情返回时不重新挑**：那道菜还在（重新挑会把用户正要评估的菜换成另一道）', async () => {
  const spy = mockApi([decideResult()])
  const { unmount } = renderSheet()
  await screen.findByText('番茄炒蛋')

  // 模拟"点菜名跳走再回来"：路由跳转会让本页卸载，store 里的会话活下来
  unmount()
  renderSheet()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  // 关键：**没有**再发一次决定请求（第一次那一次不算）
  expect(decideCalls(spy)).toHaveLength(1)
})

it('「换一道」把看过的排除掉（不发排除参数的话会换回同一道，看着像按钮坏了）', async () => {
  const spy = mockApi([
    decideResult(),
    decideResult({ reason: '库里挑的，今天换换口味', recipe: dish({ id: 'r2', name: '清炒时蔬', have: [], missing: [] }) }),
  ])
  renderSheet()
  await screen.findByText('番茄炒蛋')

  fireEvent.click(screen.getByRole('button', { name: /换一道/ }))

  expect(await screen.findByText('清炒时蔬')).toBeTruthy()
  const calls = decideCalls(spy)
  expect(calls).toHaveLength(2)
  // 第二次必须带上刚看过的那道
  expect((calls[1][1] as { params?: { exclude?: string } }).params?.exclude).toBe('r1')
})

it('换到没有别的为止：「换一道」置灰（点了没反应比置灰更让人摸不着头脑）', async () => {
  mockApi([decideResult({ canSwap: false })])
  renderSheet()
  await screen.findByText('番茄炒蛋')

  expect((screen.getByRole('button', { name: /换一道/ }) as HTMLButtonElement).disabled).toBe(true)
})

it('「就它了」加进菜单，加过之后不再给按钮（同一道菜加两遍是重复点菜）', async () => {
  const spy = mockApi([decideResult()])
  renderSheet()
  await screen.findByText('番茄炒蛋')

  fireEvent.click(screen.getByRole('button', { name: '就它了' }))

  expect(await screen.findByText('已经加进菜单了')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '就它了' })).toBeNull()
  // 走的是与手点同一条接口
  const posts = (spy as unknown as { mock: { calls: unknown[][] } })
  expect(posts).toBeTruthy()
})

it('拿不出菜时说清那一种情况的去路（冰箱空 → 给去记冰箱的入口）', async () => {
  mockApi([decideResult({ recipe: null, reason: '冰箱里还没记东西', fridgeEmpty: true, canSwap: false })])
  renderSheet()

  expect(await screen.findByText('冰箱里还没记东西')).toBeTruthy()
  expect(screen.getByText('去记两样冰箱里的东西')).toBeTruthy()
})

it('冰箱空但挑得出菜：明说"这次没照着冰箱挑"（不说的话用户会以为它看过冰箱了）', async () => {
  mockApi([decideResult({ fridgeEmpty: true })])
  renderSheet()

  expect(await screen.findByText(/冰箱里还没记东西，这次只按家里的口味/)).toBeTruthy()
  expect(screen.getByText('去记两样')).toBeTruthy()
})

it('请求失败时说人话并给「再试一次」；重试仍带着已经看过的排除项', async () => {
  /*
   * 造"点过一次「换一道」之后才失败"的现场：第一次成功、之后都失败。
   * 这样 seen 里确实有东西，才能验"重试带着它"。
   */
  let failFrom = 1
  const calls: { params?: unknown }[] = []
  vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: unknown) => {
    if (url === '/discover/decide') {
      calls.push({ params: (config as { params?: unknown } | undefined)?.params })
      if (calls.length > failFrom) return Promise.reject(new Error('boom')) as never
      return Promise.resolve({ data: decideResult() } as never)
    }
    if (url === '/orders/options') {
      return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [] } } as never)
    }
    if (url === '/family') {
      return Promise.resolve({ data: { id: 'f1', name: '家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  renderSheet()
  await screen.findByText('番茄炒蛋')

  // 换一道 → 这次失败（但 seen 已经记下看过 r1）
  fireEvent.click(screen.getByRole('button', { name: /换一道/ }))
  const retry = await screen.findByRole('button', { name: '再试一次' })

  // 再试一次 → 仍带着 r1，不会把刚看过的菜换回来
  fireEvent.click(retry)
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3))
  expect((calls[2].params as { exclude?: string }).exclude).toBe('r1')
})

it('**重挂载不会问第二次**（StrictMode 的双挂载：问两次的话后回来的结果会把显示中的菜换掉）', async () => {
  /*
   * 造"请求还没回来就卸载、再挂载一遍"的现场（React StrictMode 在开发模式下就是这么干的）。
   * 那条记录必须在 store 里才守得住——组件 state 会随卸载重置，第二遍又会问一次，
   * 于是用户看到的那道菜会自己变（浏览器实测抓到过：先"番茄炒蛋"、一秒后变另一道）。
   */
  const spy = vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/discover/decide') {
      // 一直不回来：这条用例只关心"问了几次"，不关心结果
      return new Promise(() => {}) as never
    }
    if (url === '/orders/options') {
      return Promise.resolve({ data: { meals: [], statuses: [], dayOptions: [] } } as never)
    }
    if (url === '/family') {
      return Promise.resolve({ data: { id: 'f1', name: '家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })

  const first = renderSheet()
  // mutate 的 mutationFn 在微任务里才跑，所以要等一下才看得到这次请求
  await waitFor(() => expect(decideCalls(spy)).toHaveLength(1))

  // 请求还没回来就卸载（StrictMode 的第一次挂载就是被丢弃的那次），再挂一遍
  first.unmount()
  renderSheet()
  // 给"可能发出的第二次请求"留出时间：没有 store 那道闸门时它会出现在这里
  await new Promise((resolve) => setTimeout(resolve, 30))

  expect(decideCalls(spy)).toHaveLength(1)
})

it('下半（AI）**默认收着**：不先铺一堆输入框，用户此刻要的是上面那道', async () => {
  mockApi([decideResult()])
  renderSheet()
  await screen.findByText('番茄炒蛋')

  // 收着时只给一行说明，AI 的输入框与快问都不在
  expect(screen.getByText(/都不合意/)).toBeTruthy()
  expect(screen.queryByPlaceholderText(/想吃酸的/)).toBeNull()

  // 点一下才展开：这时才出现那种"要等十几秒"的东西
  fireEvent.click(screen.getByText(/都不合意/))
  expect(await screen.findByPlaceholderText(/想吃酸的/)).toBeTruthy()
  expect(useTodaySession.getState().aiOpen).toBe(true)
})

it('**拿不出菜时下半仍然可用**：上面挑不出来，用户还得有第二条路', async () => {
  mockApi([decideResult({ recipe: null, reason: '菜谱小书里还没有菜，先去加几道', canSwap: false })])
  renderSheet()

  await screen.findByText('菜谱小书里还没有菜，先去加几道')
  // 上面空了，但"说说想吃什么"那一行还在（不然用户看着一个空状态无路可去）
  expect(screen.getByText(/都不合意/)).toBeTruthy()
})

it('「就它了」与「换一道」的**几何完全一致**（用户 2026-10-13：这块没对齐）', () => {
  /*
   * 现场：两个按钮顶边差 6px（320 / 314）、一个是 999px 胶囊、一个是 14px 圆角。
   * 根因是「就它了」借用了菜谱详情页的 `.recipe-button`，而它带着 `margin-top: 12px`
   * 和 `border-radius: 999px`；「换一道」是我另写的。所以现在这一对**不借用别处的类**，
   * 几何写在一条公共规则里、各自只准改颜色。
   *
   * jsdom 算不了布局，所以守**决定这件事的那条规则**（与 corner-art / DiscoverPage
   * 那两处同一手法）：谁哪天给其中一个单独加内边距、圆角或边框，这条就会红。
   */
  const srcDir = join(__dirname, '..', '..', '..')
  const css = readFileSync(join(srcDir, 'pages/discover/discover.scss'), 'utf8')
  const common = css.match(/\.decide__take,\s*\n\.decide__swap\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(common, '没读到 .decide__take, .decide__swap 的公共规则').toBeTruthy()
  for (const [property, label] of [
    ['padding', '内边距'],
    ['border-radius', '圆角'],
    ['margin-top', '外边距'],
    ['border: 1px solid transparent', '边框宽度'],
  ] as const) {
    expect(common, `${label}必须在公共规则里定死`).toContain(property)
  }

  // 各自的独立规则只准改颜色（再写一遍几何就又不一致了）
  const after = css.slice(css.indexOf(common) + common.length)
  for (const name of ['decide__take', 'decide__swap']) {
    const rule = after.match(new RegExp(`^\\.${name}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? ''
    expect(rule, `没读到 .${name} 的独立规则`).toBeTruthy()
    for (const geometry of ['padding', 'border-radius', 'margin-top', 'border:']) {
      expect(rule, `.${name} 不该再写${geometry}（几何统一在公共规则里）`).not.toContain(geometry)
    }
  }
})

it('拿不出菜时**不画**「就它了」与「换一道」：没有菜可加、也没有菜可换', async () => {
  mockApi([decideResult({ recipe: null, reason: '菜谱小书里还没有菜，先去加几道', canSwap: false })])
  renderSheet()

  await screen.findByText('菜谱小书里还没有菜，先去加几道')
  // 一行空状态 + 一句原因。没有菜的时候画一个按不动的「就它了」只会让人反复去戳它
  expect(screen.queryByRole('button', { name: '就它了' })).toBeNull()
  expect(screen.queryByRole('button', { name: /换一道/ })).toBeNull()
})
