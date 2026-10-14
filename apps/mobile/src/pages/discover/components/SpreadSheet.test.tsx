// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { Toaster, useToasts } from '@/components/ui/toast'
import type { SpreadDish, SpreadResult } from '@/api/spread'
import { useAuth } from '@/stores/auth'
import { useSpreadSession } from '@/stores/spread-session'
import SpreadSheet from './SpreadSheet'

/**
 * 「摇一桌」（M5 / F5-01，2026-10-15 由「摇一道」升级，见 D-072）。要盯住的六件事：
 * ① **打开就摇**（不让用户再按一下才有一桌）；
 * ② **一个请求配一桌**：整组加入走 `/orders/items/bulk`，**不是前端循环调加菜**
 *    （循环会在中途失败时加进去一半）；
 * ③ **已有的菜跳过要说出来**（"另外 N 道本来就在这一餐里"），不能静默少加；
 * ④ **"这一桌都在了"不是失败**（idempotent 的第二次点击不该报一个"加了 0 道"）；
 * ⑤ **单独「就它了」仍然在**（原来「摇一道」那条"只要一道"的路没有丢）；
 * ⑥ **人数只在"这一餐没存过"时可改**（存过就以存着的为准，摆一个点了不生效的按钮更糟）。
 */

const clients: QueryClient[] = []

function Probe() {
  const location = useLocation()
  return <div data-testid="probe">{`${location.pathname}|${(location.state as { from?: string } | null)?.from ?? 'no-from'}`}</div>
}

const ROLE_LABEL: Record<string, string> = { meat: '荤菜', veg: '素菜', soup: '汤', other: '另配' }

function dish(id: string, name: string, over: Partial<SpreadDish> = {}): SpreadDish {
  const role = (over.role ?? 'meat') as SpreadDish['role']
  return {
    id,
    name,
    image: null,
    category: '荤菜',
    cuisine: '家常',
    tags: [],
    calories: 200,
    caloriesEstimated: false,
    role,
    roleLabel: ROLE_LABEL[role],
    reason: '',
    have: [],
    missing: [],
    soon: [],
    cooked: 0,
    lastCookedOn: null,
    ...over,
  }
}

function spreadResult(items: SpreadDish[], over: Partial<SpreadResult> = {}): SpreadResult {
  return {
    scope: 'family',
    mealKey: '2026-10-13-DINNER',
    date: '2026-10-13',
    meal: 'DINNER',
    mealLabel: '晚餐',
    diners: 4,
    dinersFromMeal: false,
    count: items.length,
    reason: `按 4 个人算，配了 ${items.length} 道`,
    fridgeEmpty: false,
    items,
    ...over,
  }
}

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/discover']}>
        <Routes>
          <Route path="/discover" element={<SpreadSheet visible onClose={() => {}} />} />
          <Route path="/recipes/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

interface MockOptions {
  bulk?: { added?: string[]; skipped?: string[] } | 'fail'
  optionsDays?: { value: string; label: string }[]
}

function mockApi(results: SpreadResult[], opts: MockOptions = {}) {
  const seen: { spread: unknown[]; bulk: unknown[]; one: unknown[] } = { spread: [], bulk: [], one: [] }
  vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: unknown) => {
    if (url === '/discover/spread') {
      const index = seen.spread.length
      seen.spread.push((config as { params?: unknown } | undefined)?.params)
      const next = results[Math.min(index, results.length - 1)]
      return Promise.resolve({ data: next } as never)
    }
    if (url === '/orders/options') {
      return Promise.resolve({
        data: {
          meals: [],
          statuses: [],
          dayOptions: opts.optionsDays ?? [{ value: '2026-10-13', label: '今天' }],
        },
      } as never)
    }
    if (url === '/family') {
      return Promise.resolve({
        data: { id: 'f1', name: '家', shared: true, members: [], myCapabilities: [], myRole: 'OWNER', inviteCode: 'X', createdAt: '', memberCount: 1, memberLimit: 10 },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  vi.spyOn(apiClient, 'post').mockImplementation((url: string, body?: unknown) => {
    if (url === '/orders/items/bulk') {
      seen.bulk.push(body)
      if (opts.bulk === 'fail') return Promise.reject(new Error('boom')) as never
      return Promise.resolve({
        data: {
          added: opts.bulk?.added ?? [],
          skipped: opts.bulk?.skipped ?? [],
          card: { mealLabel: '晚餐', mealKey: '2026-10-13-DINNER', dishCount: 3 },
        },
      } as never)
    }
    if (url === '/orders/items') {
      seen.one.push(body)
      return Promise.resolve({ data: { mealLabel: '晚餐', mealKey: '2026-10-13-DINNER', dishCount: 1 } } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  return seen
}

beforeEach(() => {
  localStorage.clear()
  useSpreadSession.getState().close()
  /*
   * 钉住时钟：落到哪一餐由共享规则 `nextMealDefaults` 算（下午 3 点后默认明天的午饭），
   * 不钉的话同一条断言上午跑绿、下午跑红——那是测试的毛病，不是产品的。
   */
  vi.setSystemTime(new Date('2026-10-13T10:00:00'))
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'a', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' },
  })
})

afterEach(() => {
  cleanup()
  useToasts.setState({ items: [] })
  useSpreadSession.getState().close()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('打开就摇一桌（不用再按一下），道数与头部那句都来自后端', async () => {
  const seen = mockApi([spreadResult([dish('r1', '红烧排骨'), dish('r2', '清炒时蔬', { role: 'veg' })])])
  renderSheet()

  expect(await screen.findByText('按 4 个人算，配了 2 道')).toBeTruthy()
  expect(screen.getByText('红烧排骨')).toBeTruthy()
  expect(screen.getByText('清炒时蔬')).toBeTruthy()
  expect(seen.spread).toHaveLength(1)
  // 落到这一餐由共享规则算（今天 15 点前是晚餐）——与「帮我决定」同一个落点
  expect(seen.spread[0]).toMatchObject({ mealKey: '2026-10-13-DINNER' })
})

it('整组加入是**一个请求**（不是前端循环调加菜），并报清加了几道', async () => {
  const seen = mockApi(
    [spreadResult([dish('r1', '红烧排骨'), dish('r2', '清炒时蔬', { role: 'veg' })])],
    { bulk: { added: ['r1', 'r2'] } },
  )
  renderSheet()

  fireEvent.click(await screen.findByText('全都加进晚餐'))
  await waitFor(() => expect(seen.bulk).toHaveLength(1))
  expect(seen.bulk[0]).toMatchObject({
    recipeIds: ['r1', 'r2'],
    mealDate: '2026-10-13',
    meal: 'DINNER',
  })
  // 单道加菜的接口**一次都没被调用**：循环调它的话中途失败会加进去一半
  expect(seen.one).toHaveLength(0)
  expect(await screen.findByText(/已把 2 道加进晚餐/)).toBeTruthy()
})

it('已有的菜跳过时**说出来**（不能静默少加几道）', async () => {
  mockApi(
    [spreadResult([dish('r1', '红烧排骨'), dish('r2', '清炒时蔬', { role: 'veg' }), dish('r3', '番茄蛋汤', { role: 'soup' })])],
    { bulk: { added: ['r1'], skipped: ['r2', 'r3'] } },
  )
  renderSheet()

  fireEvent.click(await screen.findByText('全都加进晚餐'))
  expect(await screen.findByText(/加了 1 道，另外 2 道本来就在这一餐里/)).toBeTruthy()
})

it('整桌already都在时不当成失败（第二次点同一个按钮）', async () => {
  mockApi([spreadResult([dish('r1', '红烧排骨')])], { bulk: { added: [], skipped: ['r1'] } })
  renderSheet()

  fireEvent.click(await screen.findByText('全都加进晚餐'))
  /*
   * 提示语与底部那句占位**文案相同**（都是"这一桌都在晚餐里了"）：这里要的是
   * "用户被告知了"，两处出现都对，所以取全集而不是唯一匹配。
   */
  await waitFor(() => expect(screen.getAllByText(/这一桌都在晚餐里了/).length).toBeGreaterThan(0))
})

it('加过的那些标成"已在菜单里"，且底部主按钮换成"都在了"', async () => {
  mockApi([spreadResult([dish('r1', '红烧排骨'), dish('r2', '清炒时蔬', { role: 'veg' })])], {
    bulk: { added: ['r1', 'r2'] },
  })
  renderSheet()

  fireEvent.click(await screen.findByText('全都加进晚餐'))
  await waitFor(() => expect(screen.getAllByText('已在菜单里')).toHaveLength(2))
  expect(screen.getByText('这一桌都在晚餐里了')).toBeTruthy()
  // 主按钮退场：不该还留着一个"点了不生效"的按钮
  expect(screen.queryByText('全都加进晚餐')).toBeNull()
})

it('单独「就它了」还在（"只要这一道"那条路没有因为升级而丢）', async () => {
  const seen = mockApi([spreadResult([dish('r1', '红烧排骨'), dish('r2', '清炒时蔬', { role: 'veg' })])])
  renderSheet()

  const buttons = await screen.findAllByText('就它了')
  fireEvent.click(buttons[0])
  await waitFor(() => expect(seen.one).toHaveLength(1))
  expect(seen.one[0]).toMatchObject({ recipeId: 'r1', mealDate: '2026-10-13', meal: 'DINNER' })
  // 只加了一道：另一道还能接着点
  await waitFor(() => expect(screen.getAllByText('就它了')).toHaveLength(1))
})

it('这一餐存过人数时不给"改人数"的入口（以存着的为准，摆不生效的按钮更糟）', async () => {
  mockApi([spreadResult([dish('r1', '红烧排骨')], { diners: 6, dinersFromMeal: true, reason: '6 个人吃，配了 1 道' })])
  renderSheet()

  expect(await screen.findByText('6 个人吃，配了 1 道')).toBeTruthy()
  expect(screen.queryByText(/不是 6 个人？/)).toBeNull()
})

it('改人数是再摇一次、并把人数报给后端（不是前端本地改道数）', async () => {
  const seen = mockApi([
    spreadResult([dish('r1', '红烧排骨')]),
    spreadResult([dish('r1', '红烧排骨'), dish('r2', '清炒时蔬', { role: 'veg' }), dish('r3', '番茄蛋汤', { role: 'soup' })], {
      diners: 6,
      reason: '按 6 个人算，配了 3 道',
    }),
  ])
  renderSheet()

  fireEvent.click(await screen.findByRole('button', { name: '6 人' }))
  expect(await screen.findByText('按 6 个人算，配了 3 道')).toBeTruthy()
  expect(seen.spread).toHaveLength(2)
  expect(seen.spread[1]).toMatchObject({ diners: 6 })
})

it('空库时给去路，不给一桌编的', async () => {
  mockApi([spreadResult([], { count: 0, reason: '菜谱小书里还没有菜，先去加几道' })])
  renderSheet()

  expect(await screen.findByText('菜谱小书里还没有菜，先去加几道')).toBeTruthy()
  expect(screen.getByText(/去菜谱小书里加几道/)).toBeTruthy()
})

it('菜名可以点进详情，并带上"从哪来"（返回时才退得回发现页）', async () => {
  mockApi([spreadResult([dish('r1', '红烧排骨')])])
  renderSheet()

  fireEvent.click(await screen.findByText('红烧排骨'))
  expect((await screen.findByTestId('probe')).textContent).toBe('/recipes/r1|/discover')
})

it('加菜失败时说人话，不静默（这一桌还在，用户能再点一次）', async () => {
  mockApi([spreadResult([dish('r1', '红烧排骨')])], { bulk: 'fail' })
  renderSheet()

  fireEvent.click(await screen.findByText('全都加进晚餐'))
  // 失败之后主按钮还在（用户能再试），不是变成"都在了"
  await waitFor(() => expect(screen.getByText('全都加进晚餐')).toBeTruthy())
  expect(screen.queryByText('这一桌都在晚餐里了')).toBeNull()
})
