// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { FamilyPicks as PicksBoard } from '@/api/discover'
import { useAuth } from '@/stores/auth'
import FamilyPicks from './FamilyPicks'

// 发现页的家人最爱（M5 / F5-02）。要盯住的四件事：
// ① 每一行都带"为什么它在榜上"（做过几次 / 几人收着）——没有理由的排名用户不会信；
// ② **共享关着时说清只算自己那一份**（否则用户以为"家里只做过这几道"）；
// ③ 没信号时不编内容（说清"做几顿就会出来"，不拿随机菜凑）；
// ④ 点一行进详情（榜单是入口不是终点）。

const clients: QueryClient[] = []

/** 渲染 /recipes/:id 的目的地，才能断言"点一行真的进了那道菜"（只看链接文字测不出） */
function DetailProbe() {
  const location = useLocation()
  return <div data-testid="probe">{location.pathname}</div>
}

function renderPicks({ initial = '/' }: { initial?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<FamilyPicks />} />
          <Route path="/recipes/:id" element={<DetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: ['order.create'], members: [],
}

function pick(overrides: Partial<PicksBoard['items'][number]> = {}) {
  return {
    id: 'r1', name: '番茄炒蛋', image: null, category: '荤菜', cuisine: '家常',
    calories: 210, caloriesEstimated: false,
    cooked: 2, favorites: 1, score: 5, lastCookedOn: '2026-10-05',
    ...overrides,
  }
}

function board(overrides: Partial<PicksBoard> = {}): PicksBoard {
  return { scope: 'family', limit: 8, total: 1, items: [pick()], ...overrides }
}

function mockGet({ family = FAMILY as unknown, picks }: { family?: unknown; picks?: PicksBoard | null } = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/discover/family-picks') {
      if (picks === null) return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: picks ?? board() } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 'test-token', refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('每行都带理由：做过几次 + 几人收着', async () => {
  mockGet({ picks: board({ items: [pick({ name: '番茄炒蛋', cooked: 3, favorites: 2 })] }) })
  renderPicks()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.getByText('做过 3 次 · 2 人收着')).toBeTruthy()
})

it('只做过、没人收藏时只说过做过的次数，不编收藏', async () => {
  mockGet({ picks: board({ items: [pick({ cooked: 1, favorites: 0 })] }) })
  renderPicks()

  expect(await screen.findByText('做过 1 次')).toBeTruthy()
  expect(screen.queryByText(/收着/)).toBeNull()
})

it('共享关着（scope=mine）时说清只算自己那一份，且收藏那句说「我收着」', async () => {
  mockGet({ picks: board({ scope: 'mine', items: [pick({ cooked: 1, favorites: 1 })] }) })
  renderPicks()

  expect(await screen.findByText(/家里关了共享，现在只算你自己做过和收着的菜/)).toBeTruthy()
  expect(screen.getByText('做过 1 次 · 我收着')).toBeTruthy()
  // 「1 人收着」会让人以为是别人收的（mine 口径下算的只有自己）
  expect(screen.queryByText(/1 人收着/)).toBeNull()
})

it('没有信号时不编内容：说清做几顿就会出来', async () => {
  mockGet({ picks: board({ total: 0, items: [] }) })
  renderPicks()

  expect(await screen.findByText(/还没有信号：做过的菜和收藏的菜都会出现在这里/)).toBeTruthy()
  expect(screen.queryByRole('listitem')).toBeNull()
})

it('点一行进那道菜的详情页', async () => {
  mockGet({ picks: board({ items: [pick({ id: 'jis-abc', name: '三丝杏鲍菇' })] }) })
  renderPicks()

  const link = await screen.findByRole('link', { name: '查看三丝杏鲍菇菜谱' })
  link.click()
  expect(await screen.findByTestId('probe')).toBeTruthy()
  expect(screen.getByTestId('probe').textContent).toBe('/recipes/jis-abc')
})

it('名单超过一屏时说还有多少道，并给出出路（收藏 / 去点菜）', async () => {
  mockGet({ picks: board({ total: 20, items: [pick()] }) })
  renderPicks()

  expect(await screen.findByText(/还有 19 道做过或收过的菜/)).toBeTruthy()
  expect(screen.getByRole('link', { name: '我收藏的菜 →' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '去点菜 →' })).toBeTruthy()
})

it('没加入家庭时给出去处，不去问榜单', async () => {
  mockGet({ family: null, picks: board() })
  renderPicks()

  expect(await screen.findByText(/一家人一起点过、做过几顿之后/)).toBeTruthy()
  const urls = (apiClient.get as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0])
  expect(urls).not.toContain('/discover/family-picks')
})

it('榜单取不回来时报错并给重试，不显示假内容', async () => {
  mockGet({ picks: null })
  renderPicks()

  expect(await screen.findByText('家人最爱暂时打不开')).toBeTruthy()
  expect(screen.queryByRole('listitem')).toBeNull()
})
