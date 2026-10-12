// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { ShoppingList } from '@/api/shopping'
import { useAuth } from '@/stores/auth'
import ShoppingPage from './ShoppingPage'

// 采购清单（M7 / F7-01）。要盯住的四件事：
// ① 每样食材都要说清**买多少**与**为哪几道菜买**（买菜的人要能回答"我为什么要买这个"）；
// ② 菜谱没写用量时说"用量没写"——不替菜谱编一句"适量"；
// ③ 没有配料表的菜**必须单独列出来**（漏掉会让人少买一整道菜的东西）；
// ④ 还没定菜单时说清"为什么是空的"并给出路，不编内容。

const clients: QueryClient[] = []

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/shopping']}>
        <ShoppingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: ['order.create'], members: [],
}

function board(overrides: Partial<ShoppingList> = {}): ShoppingList {
  return {
    scope: 'family',
    days: 3,
    from: '2026-10-13',
    to: '2026-10-15',
    meals: [{ mealKey: '2026-10-13-DINNER', date: '2026-10-13', mealLabel: '晚餐', dishCount: 2 }],
    items: [
      { name: '鸡蛋', amount: '5个', from: ['番茄炒蛋', '蛋花汤'] },
      { name: '葱', amount: '1根', from: ['番茄炒蛋'] },
    ],
    missing: [],
    dishCount: 2,
    ...overrides,
  }
}

function mockGet({ family = FAMILY as unknown, list }: { family?: unknown; list?: ShoppingList | null } = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/shopping-list') {
      if (list === null) return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: list ?? board() } as never)
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

it('每样食材都显示用量与"为哪几道菜买"', async () => {
  mockGet()
  renderList()

  expect(await screen.findByText('鸡蛋')).toBeTruthy()
  expect(screen.getByText('5个')).toBeTruthy()
  expect(screen.getByText('（番茄炒蛋、蛋花汤）')).toBeTruthy()
  expect(screen.getByText('（番茄炒蛋）')).toBeTruthy()
})

it('菜谱没写用量时说「用量没写」，不替菜谱编「适量」', async () => {
  mockGet({ list: board({ items: [{ name: '白糖', amount: null, from: ['红烧肉'] }] }) })
  renderList()

  expect(await screen.findByText('用量没写')).toBeTruthy()
  expect(screen.queryByText('适量')).toBeNull()
})

it('说明这份清单是按哪几天、哪几餐算的', async () => {
  mockGet()
  renderList()

  // 这句话在 JSX 里跨了几行，DOM 里被拆成多个文本节点——用函数匹配器拼起来找
  // （直接拿正则找会被"broken up by multiple elements"挡住）
  expect(
    await screen.findByText((_, node) =>
      node?.textContent?.replace(/\s+/g, '') === '10-13起3天：1餐定了菜单，共2道菜。',
    ),
  ).toBeTruthy()
})

it('勾掉一样：进度跟着变，行上有划掉的样式类', async () => {
  mockGet()
  renderList()

  expect(await screen.findByText('买到 0/2')).toBeTruthy()
  const eggCheck = screen.getByRole('checkbox', { name: /鸡蛋/ })
  fireEvent.click(eggCheck)
  expect(await screen.findByText('买到 1/2')).toBeTruthy()
  expect(eggCheck.closest('label')?.className).toContain('is-packed')

  // 再点一下取消勾选（勾错要能改）
  fireEvent.click(eggCheck)
  expect(await screen.findByText('买到 0/2')).toBeTruthy()
})

it('没有配料表的菜单独列出来（漏掉会让人少买一整道菜的东西）', async () => {
  mockGet({ list: board({ missing: ['妈妈牌糖醋排骨'] }) })
  renderList()

  expect(await screen.findByText('这几道菜没有配料表，要自己记一下：')).toBeTruthy()
  expect(screen.getByText('妈妈牌糖醋排骨')).toBeTruthy()
})

it('菜单还没定时说清为什么是空的并给出路（去备菜计划）', async () => {
  mockGet({ list: board({ meals: [], items: [], missing: [], dishCount: 0 }) })
  renderList()

  expect(await screen.findByText(/这几天还没有定下来的菜单，所以没什么要买的/)).toBeTruthy()
  expect(screen.getByRole('link', { name: '去备菜计划 →' })).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('共享关掉时说清只按自己参与的餐算', async () => {
  mockGet({ list: board({ scope: 'mine' }) })
  renderList()

  expect(await screen.findByText(/这份清单只按你自己参与的餐算/)).toBeTruthy()
})

it('没加入家庭时给出去处，不去问清单', async () => {
  mockGet({ family: null })
  renderList()

  expect(await screen.findByText(/采购清单是按家里一起定的菜单算的/)).toBeTruthy()
  const urls = (apiClient.get as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0])
  expect(urls).not.toContain('/shopping-list')
})

it('清单取不回来时报错并可重试，不显示假内容', async () => {
  mockGet({ list: null })
  renderList()

  expect(await screen.findByText('采购清单暂时打不开')).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
})
