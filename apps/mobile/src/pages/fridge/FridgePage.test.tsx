// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { FRIDGE_ZONES, type CookableBoard, type FridgeBoard, type FridgeItem, type FridgeZone } from '@/api/fridge'
import type { ShoppingList } from '@/api/shopping'
import { useAuth } from '@/stores/auth'
import FridgePage from './FridgePage'

// 冰箱页（2026-10-13 信息架构改版 D-040；库存换成真数据 M6 / D-050）。要盯住的四件事：
// ① **主体是冰箱**（四个存放区 + 临期先吃），采购只是**一行入口**——
//    第一版把采购做成整块预览，用户当场说"占据太大位置了，冰箱相关才是主题"；
// ② **一个假数字都没有**：原先写死的 12 在库 / 3 临期 / 8 品类全撤了，而 M6 之前那段
//    "骨架 + 明说还没做"现在也不该再有——数据是真的了，空冰箱就说"还是空的"；
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

const noStock = {
  stock: { verdict: 'missing' as const, stockName: null, stockAmount: null, remaining: null },
  needsBuy: true,
  stockLabel: null,
}

function board(overrides: Partial<ShoppingList> = {}): ShoppingList {
  return {
    scope: 'family',
    days: 3,
    from: '2026-10-13',
    to: '2026-10-15',
    meals: [{ mealKey: '2026-10-13-DINNER', date: '2026-10-13', mealLabel: '晚餐', dishCount: 2 }],
    // 冰箱页只借这份数据画"要去买什么"那一行的样数与"有菜没配料表"的记号，
    // 所以这里给最简形状；F7-02 的库存比对不进这一页的断言
    items: [
      { name: '花椒', amount: '3-4颗', from: ['【红烧排骨】'], ...noStock },
      { name: '白砂糖', amount: null, from: ['【红烧排骨】'], ...noStock },
      { name: '桂圆肉', amount: '6个', from: ['【桂圆银耳羹】'], ...noStock },
    ],
    toBuyCount: 3,
    coveredCount: 0,
    unsureCount: 0,
    stockEmpty: true,
    missing: [],
    dishCount: 3,
    ...overrides,
  }
}

/** 冰箱里的一条（接口给的字段全在这儿；测试只覆盖关心的那几个） */
function stockItem(over: Partial<FridgeItem> & { name: string }): FridgeItem {
  return {
    id: over.name,
    amount: null,
    zone: '冷藏',
    expiresOn: null,
    expiryLabel: null,
    attention: false,
    note: null,
    addedBy: '妈妈',
    addedAt: '2026-10-13T01:00:00.000Z',
    ...over,
  }
}

/**
 * 接口给的板子长这样（四区、概览数字、今日先吃都是后端算好的）。
 * 测试里自己照着数出这些数字，是为了让断言写得出**期望的真数**——
 * 页面一旦自己瞎算（比如把没写保质期的也算成临期），这里就会红。
 */
function fridgeBoard(
  groups: Partial<Record<FridgeZone, FridgeItem[]>> = {},
  scope: FridgeBoard['scope'] = 'family',
): FridgeBoard {
  const zones = FRIDGE_ZONES.map((zone) => ({ zone, items: groups[zone] ?? [] }))
  const items = zones.flatMap((group) => group.items)
  const attention = items.filter((entry) => entry.attention)
  return {
    scope,
    zones,
    summary: {
      total: items.length,
      attention: attention.length,
      expired: attention.filter((entry) => entry.expiryLabel?.startsWith('过期')).length,
      withExpiry: items.filter((entry) => entry.expiresOn !== null).length,
    },
    soon: attention,
  }
}

function mockGet({
  family = FAMILY as unknown,
  list,
  fridge = fridgeBoard(),
  cookable,
}: { family?: unknown; list?: ShoppingList | null; fridge?: FridgeBoard; cookable?: CookableBoard } = {}) {
  const cookableBoard = cookable ?? emptyCookable(fridge)
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/shopping-list') {
      if (list === null) return Promise.reject(new Error('boom'))
      return Promise.resolve({ data: list ?? board() } as never)
    }
    if (url === '/fridge') return Promise.resolve({ data: fridge } as never)
    if (url.startsWith('/fridge/cookable')) return Promise.resolve({ data: cookableBoard } as never)
    throw new Error(`未预期的请求：${url}`)
  })
}

/**
 * 「能做点什么」那块要的那份结果。
 *
 * 这一页的测试只关心**冰箱主体与采购那一行**，所以默认给一份"什么都做不了"的板子
 * （`total: 0`）——那块自己会说"这几样配不出菜"。它自己的行为在
 * `components/FridgeCookable.test.tsx` 里单独验，两份测试各盯各的，不互相掺和。
 */
function emptyCookable(fridge: FridgeBoard): CookableBoard {
  const names = fridge.zones.flatMap((group) => group.items.map((item) => item.name))
  return {
    source: 'fridge',
    scope: fridge.scope,
    pantry: names,
    usable: names.length,
    skipSeasonings: 0,
    maxMissing: 1,
    total: 0,
    filteredOut: 0,
    items: [],
  }
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

it('主体是冰箱：空的时候说"还是空的"并指路，骨架话（"还没做""食材会列在这里"）不该再有', async () => {
  mockGet()
  renderFridge()

  expect(await screen.findByText('冰箱里有什么')).toBeTruthy()
  expect(await screen.findByText(/冰箱还是空的/)).toBeTruthy()
  // 入口就在这块的标题行上（文案里说"点右上角"，所以它得真的在标题那一行里）
  const add = screen.getByRole('button', { name: '＋ 记一样' })
  expect(add.closest('.stock__head')).toBeTruthy()
  // M6 之前那段的写法必须彻底不在：数据是真的了，不能一边有真数据一边留着骨架话
  expect(screen.queryByText('还没做')).toBeNull()
  expect(screen.queryByText('食材会列在这里')).toBeNull()
})

it('有货时四个存放区都在：有东西的给样数，空的格子说"这格里没有东西"', async () => {
  mockGet({
    fridge: fridgeBoard({
      冷藏: [stockItem({ name: '鸡蛋', amount: '一盒' })],
      冷冻: [stockItem({ name: '冻虾', zone: '冷冻' })],
    }),
  })
  renderFridge()

  expect(await screen.findByText('鸡蛋')).toBeTruthy()
  for (const zone of FRIDGE_ZONES) expect(screen.getByText(zone)).toBeTruthy()
  expect(screen.getByText('一盒')).toBeTruthy()
  // 空的是**确实**空（不是"还没做"）：常温、保鲜两格
  expect(screen.getAllByText('这格里没有东西')).toHaveLength(2)
  expect(screen.queryByText(/冰箱还是空的/)).toBeNull()
})

it('顺序照接口给的（后端已按"临期先看"排好，前端不再排一遍）', async () => {
  /*
   * 刻意选这样两样：按名字排是「白菜」在前，按"临期先看"排是「酸奶」在前。
   * 接口给的是后一种（后端排好），所以这一条同时盯住两件事：
   * 临期那句总结出得来，且**位置不被前端自己按名字重排**——
   * 前端要是好心再排一遍，这里就翻成 [白菜, 酸奶]（用户下次找同一样东西会换位置）。
   */
  mockGet({
    fridge: fridgeBoard({
      冷藏: [
        stockItem({ name: '酸奶', expiresOn: '2026-10-13', expiryLabel: '今天到期', attention: true }),
        stockItem({ name: '白菜' }),
      ],
    }),
  })
  renderFridge()

  expect(await screen.findByText('今天到期')).toBeTruthy()
  expect(screen.getByText('有 1 样该先吃')).toBeTruthy()
  const names = Array.from(document.querySelectorAll('.fitem__name')).map((node) => node.textContent)
  expect(names).toEqual(['酸奶', '白菜'])
})

it('过期与快到期分开数，而且临期那句要显眼（靠 is-attention，规则在 fridge.scss）', async () => {
  mockGet({
    fridge: fridgeBoard({
      冷藏: [
        stockItem({ name: '酸奶', expiresOn: '2026-10-11', expiryLabel: '过期 2 天', attention: true }),
        stockItem({ name: '牛奶', expiresOn: '2026-10-14', expiryLabel: '明天到期', attention: true }),
        stockItem({ name: '酱油', expiresOn: '2026-12-31', expiryLabel: '还有 79 天' }),
      ],
    }),
  })
  renderFridge()

  expect(await screen.findByText('有 1 样过期了、1 样快到期')).toBeTruthy()
  expect(screen.getByText('过期 2 天').className).toContain('is-attention')
  // 还早的那条不该被打上"先吃"的记号（都标了就等于没标）
  expect(screen.getByText('还有 79 天').className).not.toContain('is-attention')
})

it('全过期的时候不说"0 样快到期"（那是句难听的话，也等于没说）', async () => {
  mockGet({
    fridge: fridgeBoard({
      冷藏: [
        stockItem({ name: '酸奶', expiresOn: '2026-10-11', expiryLabel: '过期 2 天', attention: true }),
        stockItem({ name: '菠菜', expiresOn: '2026-10-12', expiryLabel: '过期 1 天', attention: true }),
      ],
    }),
  })
  renderFridge()

  expect(await screen.findByText('有 2 样过期了')).toBeTruthy()
  expect(screen.queryByText(/快到期/)).toBeNull()
})

it('没记保质期的样数说出来（否则"快过期"为什么不提醒它就成了谜）', async () => {
  mockGet({
    fridge: fridgeBoard({
      冷藏: [
        stockItem({ name: '鸡蛋' }),
        stockItem({ name: '牛奶', expiresOn: '2026-10-20', expiryLabel: '还有 7 天' }),
      ],
    }),
  })
  renderFridge()

  expect(await screen.findByText('还有 1 样没记保质期，写了才能提醒你。')).toBeTruthy()
})

it('内置食材有图，自己打的字给中性占位（不假装知道那是什么）', async () => {
  mockGet({ fridge: fridgeBoard({ 冷藏: [stockItem({ name: '鸡蛋' }), stockItem({ name: '外婆的酱' })] }) })
  renderFridge()

  const known = (await screen.findByText('鸡蛋')).closest('.fitem') as HTMLElement
  expect(known.querySelector('img')?.getAttribute('src')).toBe('/img/ingredients/egg.png')
  const homemade = screen.getByText('外婆的酱').closest('.fitem') as HTMLElement
  expect(homemade.querySelector('img')).toBeNull()
  expect(homemade.querySelector('.fitem__pic-none')).toBeTruthy()
})

it('冰箱这块也照顾共享关掉的情况：说清这里只显示自己放的', async () => {
  mockGet({ fridge: fridgeBoard({ 冷藏: [stockItem({ name: '鸡蛋' })] }, 'mine') })
  renderFridge()

  expect(await screen.findByText('家里关了共享，这里只显示你自己放进去的。')).toBeTruthy()
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
  // 冰箱也一样：没有"家里的冰箱"可看，别白问一趟（会回 404）
  expect(urls).not.toContain('/fridge')
})

it('一个假数字都没有：页面上的数都来自接口（写死的 12/3/8 全不在）', async () => {
  mockGet({ fridge: fridgeBoard({ 冷藏: [stockItem({ name: '鸡蛋' })] }) })
  renderFridge()

  await screen.findByText('鸡蛋')
  for (const ghost of ['12', '3', '8', '在库', '临期', '品类', '小油菜', '还没做']) {
    expect(screen.queryByText(ghost)).toBeNull()
  }
  // 这一条既没写保质期也没临期：不该冒出"该先吃""过期"那种话
  expect(screen.queryByText(/该先吃/)).toBeNull()
  expect(screen.queryByText(/过期/)).toBeNull()
})
