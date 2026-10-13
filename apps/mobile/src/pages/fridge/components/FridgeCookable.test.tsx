// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { FRIDGE_ZONES, type CookableBoard, type CookableDish, type FridgeBoard, type FridgeItem, type FridgeZone } from '@/api/fridge'
import { useAuth } from '@/stores/auth'
import FridgeCookable from './FridgeCookable'

/**
 * 能做点什么（F5-04 手边食材选菜 / F6-07 库存↔推荐）。
 *
 * 要盯住的四件事（与组件的文件头一一对应）：
 * ① **默认就是用整个冰箱**：打开冰箱页就有结果，不让用户先勾一遍（F6-07 的口径）；
 * ② **"不用买"与"还差几样"分开说，且差的列名字**——这是这一块唯一敢下的结论；
 * ③ **调料不算，但要报数**（"调料 N 样没算"）：不说的话用户会以为功能漏了东西；
 * ④ **挑到一样不剩时不拿整冰箱的结果冒充**——这是实现里真踩到的坑（见下）。
 *
 * 请求参数的断言也在这里：`ingredients` 传了没有、`maxMissing` 是 0 还是 1，
 * 都是"用户看到的"与"后端算的"之间的合同，前端悄悄改一个用户就会得到不一样的结果。
 */

const clients: QueryClient[] = []

function Probe() {
  const location = useLocation()
  return <div data-testid="probe">{`${location.pathname}|${(location.state as { from?: string } | null)?.from ?? 'no-from'}`}</div>
}

function renderCookable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/fridge']}>
        <Routes>
          <Route path="/fridge" element={<FridgeCookable enabled />} />
          <Route path="/recipes/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function stockItem(name: string, zone: FridgeZone = '冷藏'): FridgeItem {
  return {
    id: name, name, amount: null, zone,
    expiresOn: null, expiryLabel: null, attention: false,
    note: null, addedBy: '妈妈', addedAt: '2026-10-13T01:00:00.000Z',
  }
}

function fridgeBoard(groups: Partial<Record<FridgeZone, FridgeItem[]>> = {}): FridgeBoard {
  const zones = FRIDGE_ZONES.map((zone) => ({ zone, items: groups[zone] ?? [] }))
  const items = zones.flatMap((group) => group.items)
  return {
    scope: 'family',
    zones,
    summary: { total: items.length, attention: 0, expired: 0, withExpiry: 0 },
    soon: [],
  }
}

function dish(over: Partial<CookableDish> & { id: string; name: string }): CookableDish {
  return {
    image: null, category: null, cuisine: null, calories: null, caloriesEstimated: false,
    have: [], missing: [], missingCount: 0, ...over,
  }
}

function cookableBoard(over: Partial<CookableBoard> = {}): CookableBoard {
  return {
    source: 'fridge', scope: 'family', pantry: [], usable: 0, skipSeasonings: 0,
    maxMissing: 1, total: 0, filteredOut: 0, items: [], ...over,
  }
}

/** 记下每次 /fridge/cookable 请求带的参数（用户看到的与后端算的之间的合同） */
let cookableCalls: string[] = []

function mockGet({ fridge = fridgeBoard({ 冷藏: [stockItem('鸡蛋')] }), cookable = cookableBoard(), byQuery }: {
  fridge?: FridgeBoard
  cookable?: CookableBoard
  /** 想让"挑了几样之后"的请求返回不同结果时用它（按 query 匹配） */
  byQuery?: (query: string) => CookableBoard
} = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/fridge') return Promise.resolve({ data: fridge } as never)
    if (url.startsWith('/fridge/cookable')) {
      cookableCalls.push(url)
      const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
      return Promise.resolve({ data: byQuery ? byQuery(query) : cookable } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  cookableCalls = []
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

it('默认就用整个冰箱（F6-07）：不发 ingredients 参数，直接就出结果', async () => {
  mockGet({
    cookable: cookableBoard({
      pantry: ['鸡蛋', '西红柿'], usable: 2,
      total: 1,
      items: [dish({ id: 'r1', name: '番茄炒蛋', have: ['鸡蛋', '西红柿'], missing: [], missingCount: 0 })],
    }),
  })
  renderCookable()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(cookableCalls.some((url) => url.includes('ingredients'))).toBe(false)
  expect(cookableCalls[0]).toContain('maxMissing=1')
})

it('"不用买"与"还差几样"分开说，且差的**列名字**（不只是数字）', async () => {
  mockGet({
    cookable: cookableBoard({
      pantry: ['鸡蛋'], usable: 1, total: 2,
      items: [
        dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'], missing: [], missingCount: 0 }),
        dish({ id: 'r2', name: '番茄炒蛋', have: ['鸡蛋'], missing: ['番茄'], missingCount: 1 }),
      ],
    }),
  })
  renderCookable()

  // 不用买的那道：徽章说"不用买"，且**不说**"还差"
  const ready = (await screen.findByText('蒸蛋')).closest('.cook__item') as HTMLElement
  expect(ready.querySelector('.cook__badge')?.textContent).toBe('不用买')
  expect(ready.querySelector('.cook__missing')).toBeNull()

  // 差一样的那道：列的是**名字**（"番茄"），不是"差 1 样"
  const almost = screen.getByText('番茄炒蛋').closest('.cook__item') as HTMLElement
  expect(almost.querySelector('.cook__missing')?.textContent).toContain('番茄')
  expect(almost.querySelector('.cook__badge')?.textContent).toBe('差 1 样')
  // 两行"用上了什么"都要在（这是他最想看到的功劳）
  expect(ready.querySelector('.cook__have')?.textContent).toContain('鸡蛋')
})

it('调料不算，但**要把跳过的样数说出来**（不说用户会以为功能漏了东西）', async () => {
  mockGet({
    fridge: fridgeBoard({ 冷藏: [stockItem('鸡蛋')], 常温: [stockItem('盐', '常温'), stockItem('生抽', '常温')] }),
    cookable: cookableBoard({
      pantry: ['鸡蛋'], usable: 1, skipSeasonings: 2, total: 1,
      items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })],
    }),
  })
  renderCookable()

  expect(await screen.findByText(/调料 2 样没算/)).toBeTruthy()
  // 摘掉的那两样不该出现在摘要里当"能用上的"
  expect(screen.queryByText(/盐、生抽/)).toBeNull()
})

it('冰箱里只有调料时明说是**调料不算**，不是"你做不了菜"', async () => {
  mockGet({
    fridge: fridgeBoard({ 常温: [stockItem('盐', '常温'), stockItem('生抽', '常温'), stockItem('油', '常温')] }),
    cookable: cookableBoard({ pantry: [], usable: 0, skipSeasonings: 3, total: 0 }),
  })
  renderCookable()

  expect(await screen.findByText(/3 样都是调料/)).toBeTruthy()
  expect(screen.getByText(/记几样真材实料/)).toBeTruthy()
})

it('空冰箱时整块不出现（冰箱那块已经说了"还是空的"，说两遍就是两块一样的空话）', async () => {
  mockGet({ fridge: fridgeBoard(), cookable: cookableBoard() })
  renderCookable()

  await waitFor(() => expect(cookableCalls.length).toBeGreaterThan(0))
  expect(screen.queryByText('能做点什么')).toBeNull()
})

it('点了「挑几样」就从全选开始（对着冰箱挨个去掉，不是从空开始一个个加）', async () => {
  mockGet({
    fridge: fridgeBoard({ 冷藏: [stockItem('鸡蛋'), stockItem('西红柿')], 常温: [stockItem('土豆', '常温')] }),
    cookable: cookableBoard({
      pantry: ['鸡蛋', '西红柿', '土豆'], usable: 3, total: 1,
      items: [dish({ id: 'r1', name: '番茄炒蛋', have: ['鸡蛋', '西红柿'] })],
    }),
  })
  renderCookable()

  const toggle = await screen.findByRole('button', { name: '挑几样' })
  toggle.click()
  await screen.findByText(/现在用的是整个冰箱（3 样）/)

  // 三个标签都在，且**都是选中的**（从全选开始）
  for (const name of ['鸡蛋', '西红柿', '土豆']) {
    expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true')
  }
  /*
   * 标签顺序 = **冰箱那块的顺序**（`FRIDGE_ZONES` = 常温→保鲜→冷藏→冷冻），
   * 所以放在常温的土豆排在放在冷藏的鸡蛋前面。
   *
   * 第一版断言写成了 [鸡蛋, 西红柿, 土豆]（按接口返回的 pantry 顺序），红了才发现
   * 自己以为的"分区顺序"是错的——**冷藏在常温室后面**才是冰箱那块的排法，
   * 而标签跟着它走正是这里想要的效果（用户站在冰箱前是从常温那格开始拿的）。
   */
  const labels = Array.from(document.querySelectorAll('.cook__chip')).map((node) => node.textContent)
  expect(labels).toEqual(['土豆', '鸡蛋', '西红柿'])
  // 全选时发的还是三样（与冰箱版同一份结果，不会因为进了挑选模式就换个算法）
  expect(cookableCalls.at(-1)).toContain('ingredients=')
})

it('去掉一样之后按剩下的算，且界面说清"挑好了 N 样"', async () => {
  mockGet({
    fridge: fridgeBoard({ 冷藏: [stockItem('鸡蛋'), stockItem('西红柿')] }),
    // 全局默认：整个冰箱两份（`whole` 用）
    cookable: cookableBoard({
      pantry: ['鸡蛋', '西红柿'], usable: 2, total: 1,
      items: [dish({ id: 'r1', name: '番茄炒蛋', have: ['鸡蛋', '西红柿'] })],
    }),
    byQuery: (query) =>
      query.includes('ingredients=') && !query.includes('%E8%A5%BF%E7%BA%A2%E6%9F%BF')
        ? cookableBoard({
            source: 'picked', pantry: ['鸡蛋'], usable: 1, total: 1,
            items: [dish({ id: 'r2', name: '蒸蛋', have: ['鸡蛋'] })],
          })
        : cookableBoard({
            source: 'picked', pantry: ['鸡蛋', '西红柿'], usable: 2, total: 1,
            items: [dish({ id: 'r1', name: '番茄炒蛋', have: ['鸡蛋', '西红柿'] })],
          }),
  })
  renderCookable()

  ;(await screen.findByRole('button', { name: '挑几样' })).click()
  ;(await screen.findByRole('button', { name: '西红柿' })).click()

  expect(await screen.findByText(/挑好了 1 样/)).toBeTruthy()
  /*
   * ⚠️ 必须**重新查一次**那个按钮：React 重渲染会换掉 DOM 节点，
   * 点之前抓到的那一个是**旧节点**，读它的 aria-pressed 永远是点之前的值
   * （第一版就是这么红的——看起来像"点了没反应"，其实断言读的是历史）。
   */
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '西红柿' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '鸡蛋' }).getAttribute('aria-pressed')).toBe('true')
  })
  /*
   * **取消勾选之后那个标签还在**（这条钉住一个真 bug）：第一版把可选列表取自
   * "当前这次请求的 pantry"，于是取消西红柿之后它也从不回来的 pantry 里消失了，
   * 用户再也点不回来。选东西的列表必须与当前选中项无关。
   */
  expect(screen.getByRole('button', { name: '西红柿' })).toBeTruthy()
  // 发出去的清单里**不再有西红柿**（用 URL 编码后的形式断言，避免中文编码差异）
  await waitFor(() => expect(cookableCalls.at(-1)).not.toContain('%E8%A5%BF%E7%BA%A2%E6%9F%BF'))
})

it('**挑到一样不剩时不许拿整冰箱的结果冒充**（`enabled:false` 不会清掉缓存数据）', async () => {
  /*
   * 这条是实现里真踩到的坑：`enabled: false` 只是"不发新请求"，react-query 会把上一次的
   * 缓存数据**照原样交回来**。第一版于是出现"先点几样你想用掉的"这句提示下面，
   * 挂着上一次整个冰箱算出来的那串菜——说的和做的不是一回事。
   * 现在是不画（`nothingPicked` 直接把 data 置空），所以这里断言**一道菜都不该在**。
   */
  mockGet({
    fridge: fridgeBoard({ 冷藏: [stockItem('鸡蛋')] }),
    cookable: cookableBoard({
      pantry: ['鸡蛋'], usable: 1, total: 1,
      items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })],
    }),
  })
  renderCookable()

  await screen.findByText('蒸蛋')
  ;(await screen.findByRole('button', { name: '挑几样' })).click()
  ;(await screen.findByRole('button', { name: '鸡蛋' })).click()

  expect(await screen.findByText(/一样都没选/)).toBeTruthy()
  expect(screen.queryByText('蒸蛋')).toBeNull()
  expect(screen.getByText(/先点几样你想用掉的/)).toBeTruthy()
})

it('「只看不用买的」把 maxMissing 变成 0（这是"马上能做"与"顺路买一样"的分界）', async () => {
  mockGet({
    fridge: fridgeBoard({ 冷藏: [stockItem('鸡蛋')] }),
    cookable: cookableBoard({ pantry: ['鸡蛋'], usable: 1, total: 1, items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })] }),
  })
  renderCookable()

  await screen.findByText('蒸蛋')
  ;(await screen.findByRole('button', { name: '只看不用买的' })).click()
  await waitFor(() => expect(cookableCalls.at(-1)).toContain('maxMissing=0'))
  expect(screen.getByRole('button', { name: '只看不用买的' }).getAttribute('aria-pressed')).toBe('true')
})

it('口味档案挡掉的菜要说出来（不声不响地少几道，用户会以为是冰箱配不出来）', async () => {
  mockGet({
    cookable: cookableBoard({
      pantry: ['鸡蛋'], usable: 1, total: 1, filteredOut: 3,
      items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })],
    }),
  })
  renderCookable()

  expect(await screen.findByText(/有 3 道被口味档案挡掉了/)).toBeTruthy()
  expect(screen.getByText(/口味与忌口/)).toBeTruthy()
})

it('共享关掉时说清只按自己记的那些算（与冰箱那块同一口径）', async () => {
  mockGet({
    cookable: cookableBoard({
      scope: 'mine', pantry: ['鸡蛋'], usable: 1, total: 1,
      items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })],
    }),
  })
  renderCookable()

  expect(await screen.findByText('家里关了共享，这里只按你自己记的那些算。')).toBeTruthy()
})

it('点一道进它的详情页，且带着来源（返回能回冰箱）', async () => {
  mockGet({
    cookable: cookableBoard({
      pantry: ['鸡蛋'], usable: 1, total: 1,
      items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })],
    }),
  })
  renderCookable()

  const link = (await screen.findByText('蒸蛋')).closest('a') as HTMLAnchorElement
  expect(link.getAttribute('href')).toBe('/recipes/r1')
  link.click()
  expect((await screen.findByTestId('probe')).textContent).toBe('/recipes/r1|/fridge')
})

it('一道都配不出时给出**可做的事**（不是只说"没结果"）', async () => {
  mockGet({
    cookable: cookableBoard({ pantry: ['鸡蛋'], usable: 1, total: 0 }),
  })
  renderCookable()

  /*
   * ⚠️ 用整句匹配，不用 `/配不出菜/`：那句话在**两个地方**出现（筛选行里的摘要
   * "这几样配不出菜" + 下面那段解释），宽松的正则会同时命中两个节点、
   * 报"found multiple elements"——第一版就是这么红的。
   */
  expect(await screen.findByText('这几样暂时配不出菜。菜谱要的配料得和冰箱里的名字对得上——记的时候尽量用常见的叫法（比如"西红柿"而不是"洋柿子"）。')).toBeTruthy()
})

it('**同一个 tick 里连点两个标签，两次都要算数**（函数式更新，不然后一次覆盖前一次）', async () => {
  /*
   * 这条是反证跑出来的：浏览器验收时我用脚本连点 9 个标签，界面只显示"挑好了 10 样"
   * （11 样里少 1 样）——看着像"点击没反应"。原因是非函数式更新把 `pickedList`
   * 闭包在**同一个渲染**的那份数组上，9 次都从同一份旧数组算，最后一次覆盖前面全部。
   *
   * 真人点不了那么快，但这是**静默丢状态**，而修法免费（`setPicked(current => …)`），
   * 所以这里直接钉住：同一 tick 内连点两下，两样都要真的取消掉。
   */
  mockGet({
    fridge: fridgeBoard({ 冷藏: [stockItem('鸡蛋'), stockItem('西红柿'), stockItem('豆腐')] }),
    cookable: cookableBoard({
      pantry: ['鸡蛋', '西红柿', '豆腐'], usable: 3, total: 1,
      items: [dish({ id: 'r1', name: '番茄炒蛋', have: ['鸡蛋', '西红柿'] })],
    }),
  })
  renderCookable()

  ;(await screen.findByRole('button', { name: '挑几样' })).click()
  await screen.findByText(/现在用的是整个冰箱（3 样）/)

  // **同一个 tick** 里连点两下（真实用户点不了这么快，但状态更新必须是幂等可叠加的）
  const chips = document.querySelectorAll('.cook__chip')
  ;(chips[0] as HTMLElement).click()
  ;(chips[1] as HTMLElement).click()

  expect(await screen.findByText(/挑好了 1 样/)).toBeTruthy()
  await waitFor(() => {
    const pressed = Array.from(document.querySelectorAll('.cook__chip'))
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
  })
})

it('"还有 N 道"只在真有更多时说（与榜单那条同一规矩：不编"看全部"入口）', async () => {
  mockGet({
    cookable: cookableBoard({
      pantry: ['鸡蛋'], usable: 1, total: 20,
      items: [dish({ id: 'r1', name: '蒸蛋', have: ['鸡蛋'] })],
    }),
  })
  renderCookable()

  expect(await screen.findByText(/还有 19 道能做/)).toBeTruthy()
  expect(screen.queryByText(/看全部/)).toBeNull()
})
