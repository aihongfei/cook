// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { ShoppingList } from '@/api/shopping'
import { useAuth } from '@/stores/auth'
import FridgePage from './FridgePage'

// 冰箱页（2026-10-13 信息架构改版，D-040）。要盯住的四件事：
// ① **主体是冰箱**（四个存放区骨架），采购只是**一行入口**——
//    第一版把采购做成整块预览，用户当场说"占据太大位置了，冰箱相关才是主题"；
// ② **一个假数字都没有**：原先写死的 12 在库 / 3 临期 / 8 品类 / 今日先吃全撤了，
//    现在库存那块连将来才有数字的空槽都不写数；
// ③ 采购那一行三种状态（加载 / 出错 / 空）都只占一行，不把冰箱挤走；
// ④ 点那一行进 `/shopping`，并且带上来源（返回能回冰箱）。

const clients: QueryClient[] = []

function ShoppingProbe() {
  const location = useLocation()
  return <div data-testid="probe">{`${location.pathname}|${(location.state as { from?: string } | null)?.from ?? 'no-from'}`}</div>
}

function renderFridge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/fridge']}>
        <Routes>
          <Route path="/fridge" element={<FridgePage />} />
          <Route path="/shopping" element={<ShoppingProbe />} />
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

function board(overrides: Partial<ShoppingList> = {}): ShoppingList {
  return {
    scope: 'family',
    days: 3,
    from: '2026-10-13',
    to: '2026-10-15',
    meals: [{ mealKey: '2026-10-13-DINNER', date: '2026-10-13', mealLabel: '晚餐', dishCount: 2 }],
    items: [
      { name: '花椒', amount: '3-4颗', from: ['【红烧排骨】'] },
      { name: '白砂糖', amount: null, from: ['【红烧排骨】'] },
      { name: '桂圆肉', amount: '6个', from: ['【桂圆银耳羹】'] },
    ],
    missing: [],
    dishCount: 3,
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

it('主体是冰箱：四个存放区的骨架在，且说明"将来会长什么样"', async () => {
  mockGet()
  renderFridge()

  expect(await screen.findByText('冰箱里有什么')).toBeTruthy()
  for (const zone of ['常温', '保鲜', '冷藏', '冷冻']) expect(screen.getByText(zone)).toBeTruthy()
  // 空槽要说"食材会列在这里"，而不是留白（留白会读成"冰箱是空的"）
  expect(screen.getAllByText('食材会列在这里')).toHaveLength(4)
  expect(screen.getByText(/每种食材的数量与保质期/)).toBeTruthy()
})

it('采购只占一行入口：显示样数与由来，**不铺开成预览列表**', async () => {
  mockGet()
  renderFridge()

  // 那一行的标题在加载中就渲染，所以**用 findByText 等数据到位的那句**再断言——
  // 先 await 静态标题、再 getByText 断言副信息，红的是时机不是功能（本轮第二次踩，
  // 上一次在冰箱页第一版；这是一类错误：断言要等"它自己那部分数据"）
  expect(
    await screen.findByText((_, node) => node?.textContent?.replace(/\s+/g, '') === '10-13起3天·共3样'),
  ).toBeTruthy()
  expect(screen.getByText('要去买什么')).toBeTruthy()
  // 关键：不列具体食材（那是 /shopping 页的事；列出来这一块就又变成"内容"、又占地方）
  expect(screen.queryByText('花椒')).toBeNull()
  expect(screen.queryByText('白砂糖')).toBeNull()
})

it('点那一行进清单页，且带着来源（返回能回冰箱）', async () => {
  mockGet()
  renderFridge()

  const entry = await screen.findByRole('link', { name: /要去买什么/ })
  expect(entry.getAttribute('href')).toBe('/shopping')
  entry.click()
  expect(await screen.findByTestId('probe')).toBeTruthy()
  expect(screen.getByTestId('probe').textContent).toBe('/shopping|/fridge')
})

it('这几天没定菜单时，那一行说清为什么（仍只占一行，不铺开）', async () => {
  mockGet({ list: board({ items: [], meals: [], dishCount: 0 }) })
  renderFridge()

  expect(await screen.findByText('这几天还没定菜单')).toBeTruthy()
  // 冰箱主体不受影响
  expect(screen.getByText('冰箱里有什么')).toBeTruthy()
})

it('清单取不回来时那一行给出去处（点进去重试），冰箱主体仍完整', async () => {
  mockGet({ list: null })
  renderFridge()

  expect(await screen.findByText('暂时打不开，点进去重试')).toBeTruthy()
  expect(screen.getByText('冰箱里有什么')).toBeTruthy()
})

it('加载中也只占一行（不跳高、不把冰箱挤下去）', async () => {
  mockGet()
  renderFridge()

  expect(await screen.findByText('正在算…')).toBeTruthy()
  expect(screen.getByText('冰箱里有什么')).toBeTruthy()
})

it('有没写配料表的菜时给个记号（别漏买），但不铺开成一段话', async () => {
  mockGet({ list: board({ missing: ['妈妈牌糖醋排骨'] }) })
  renderFridge()

  expect(await screen.findByTitle('有 1 道菜没有配料表')).toBeTruthy()
  // 具体是哪道菜在 /shopping 页说，这一行不展开
  expect(screen.queryByText(/妈妈牌糖醋排骨/)).toBeNull()
})

it('共享关掉时说清只按自己参与的餐算', async () => {
  mockGet({ list: board({ scope: 'mine' }) })
  renderFridge()

  expect(await screen.findByText(/采购清单只按你自己参与的餐算/)).toBeTruthy()
})

it('没加入家庭时给出去处，不去问清单', async () => {
  mockGet({ family: null })
  renderFridge()

  expect(await screen.findByText(/采购清单是按家里一起定的菜单算的/)).toBeTruthy()
  const urls = (apiClient.get as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0])
  expect(urls).not.toContain('/shopping-list')
})

it('一个假数字都没有：原先写死的 12/3/8 与"今日先吃"示例全不在', async () => {
  mockGet()
  renderFridge()

  await screen.findByText('冰箱里有什么')
  for (const ghost of ['12', '3', '8', '在库', '临期', '品类', '小油菜', '今日先吃', '存放位置', '拍照识别 · 一键入库']) {
    expect(screen.queryByText(ghost)).toBeNull()
  }
  // 「还没做」必须明说——骨架不能看起来像成品
  expect(screen.getByText('还没做')).toBeTruthy()
})
