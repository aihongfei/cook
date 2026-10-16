// 读样式文件做断言需要 node 类型：tsconfig.app 的 `types` 只放了 vite/client，
// 所以在文件里显式引入（与 corner-art.test 的写法一致，但不靠 tsconfig 全局包含）。
/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { ShoppingItem, ShoppingList } from '@/api/shopping'
import { useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import ShoppingPage from './ShoppingPage'

/** 源码根目录（拼 scss 路径用） */
const srcDir = join(__dirname, '..', '..')

// 采购清单（M7 / F7-01~F7-03、F7-05）。要盯住的六件事：
// ① 每样食材都要说清**买多少**与**为哪几道菜买**（买菜的人要能回答"我为什么要买这个"）；
// ② 菜谱没写用量时说"用量没写"——不替菜谱编一句"适量"；
// ③ 没有配料表的菜**必须单独列出来**（漏掉会让人少买一整道菜的东西）；
// ④ 还没定菜单时说清"为什么是空的"并给出路，不编内容；
// ⑤ **勾选走接口**（F7-03）：点一下立刻划掉（乐观），但真相在库里——刷新、换设备都在；
// ⑥ 自加条目能加能删、勾掉的能一键补货进冰箱（F7-05）。

const clients: QueryClient[] = []

function newClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return client
}

function renderWith(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/shopping']}>
        <ShoppingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderList() {
  return renderWith(newClient())
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: ['order.create'], members: [],
}

/**
 * 采购页测试的默认口径是**冰箱里什么都没记**（`noStock`）：这一页的既有用例讲的是
 * "从菜单推出来的清单长什么样"，与库存无关。F7-02 的行为在下面单独一组验。
 */
const noStock = {
  stock: { verdict: 'missing' as const, stockName: null, stockAmount: null, remaining: null },
  needsBuy: true,
  stockLabel: null,
}

function board(over: Partial<ShoppingList> = {}): ShoppingList {
  const items = over.items ?? [
    { name: '鸡蛋', amount: '5个', from: ['番茄炒蛋', '蛋花汤'], ...noStock },
    { name: '葱', amount: '1根', from: ['番茄炒蛋'], ...noStock },
  ]
  const toBuy = items.filter((item) => item.needsBuy)
  return {
    scope: 'family',
    days: 3,
    from: '2026-10-13',
    to: '2026-10-15',
    meals: [{ mealKey: '2026-10-13-DINNER', date: '2026-10-13', mealLabel: '晚餐', dishCount: 2 }],
    items,
    toBuyCount: toBuy.length,
    coveredCount: items.length - toBuy.length,
    unsureCount: items.filter((item) => item.stock.verdict === 'unknown').length,
    stockEmpty: true,
    // 后端总会给分组（F7-03）；这里按同一口径从 items 推出来，测试里不用手写
    aisles: toBuy.length > 0 ? [{ aisle: '蔬菜水果', items: toBuy }] : [],
    checkedNames: [],
    checkedCount: 0,
    missing: [],
    dishCount: 2,
    ...over,
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

/** 手搓一个 axios 错误：`apiErrorMessage` 靠 `isAxiosError` 认它（与 checkin-photo.test 同一手法） */
function axiosError(status: number, message: string) {
  return { isAxiosError: true, response: { status, data: { message } } }
}

function lastToast() {
  const items = useToasts.getState().items
  return items[items.length - 1] ?? null
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
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
  mockGet({ list: board({ items: [{ name: '白糖', amount: null, from: ['红烧肉'], ...noStock }] }) })
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

it('没有配料表的菜单独列出来（漏掉会让人少买一整道菜的东西）', async () => {
  mockGet({ list: board({ missing: ['妈妈牌糖醋排骨'] }) })
  renderList()

  expect(await screen.findByText('这几道菜没有配料表，要自己记一下：')).toBeTruthy()
  expect(screen.getByText('妈妈牌糖醋排骨')).toBeTruthy()
})

it('菜单还没定时说清为什么是空的并给出路（去备菜计划）', async () => {
  mockGet({ list: board({ meals: [], items: [], missing: [], dishCount: 0, aisles: [] }) })
  renderList()

  expect(await screen.findByText(/这几天还没有定下来的菜单，所以没什么要买的/)).toBeTruthy()
  expect(screen.getByRole('link', { name: '去备菜计划' })).toBeTruthy()
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

/*
 * 勾选框是**自绘**的（用户 2026-10-13：「这个复选框不好看」）。
 *
 * 实测过：原生方框在 jsdom 里量不到外观（`appearance: auto`、16×16），所以这一条守的是
 * **决定外观的那几条规则**——谁哪天把 `appearance: none` 或对勾的 SVG 删了，它就红。
 * 与 corner-art.test 的"守插画锚点"同一手法：jsdom 算不了视觉，就守住产生视觉的写法。
 */
it('勾选框是自绘的：关掉原生外观、有对勾、保留键盘焦点圈（原生方框与这版界面不搭）', () => {
  const css = readFileSync(join(srcDir, 'pages/shopping/shopping.scss'), 'utf8')
  const base = css.match(/\.shop__check\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(base, '没读到 .shop__check 规则').toBeTruthy()
  expect(base, '必须关掉原生外观，否则系统方框会盖掉自绘样式').toContain('appearance: none')
  // 尺寸与圆角：直角方框在这套手绘圆角里最扎眼（卡片 22 / 按钮 14 / 缩略图 10）
  expect(base, '自绘勾选框要有圆角').toMatch(/border-radius\s*:\s*5px/)

  const checked = css.match(/\.shop__check:checked\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(checked, '没读到 .shop__check:checked 规则').toBeTruthy()
  expect(checked, '勾上时要画出对勾（SVG 背景），不能只换底色').toContain('svg+xml')
  expect(checked, '对勾要是白线，压在品牌色底上才看得见').toContain("stroke='white'")

  // 原生外观关掉后，键盘用户就只剩这一条线索了
  const focus = css.match(/\.shop__check:focus-visible\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(focus, '没读到 .shop__check:focus-visible 规则——关掉原生外观必须自己给焦点圈').toBeTruthy()
  expect(focus, '焦点圈要有可见的 outline').toMatch(/outline\s*:\s*2px/)
})

it('真 `<input type="checkbox">` 还在（键盘空格勾选、读屏语义都靠它，不为好看换成 div）', async () => {
  mockGet()
  vi.spyOn(apiClient, 'post').mockResolvedValue({ data: board({ checkedNames: ['鸡蛋'], checkedCount: 1 }) } as never)
  renderList()

  const box = await screen.findByRole('checkbox', { name: /鸡蛋/ }) as HTMLInputElement
  expect(box.type).toBe('checkbox')
  // 勾上后整行要标记为已买（`.is-packed`）——自绘样式靠这个类做划线
  fireEvent.click(box)
  await waitFor(() => expect(box.closest('label')?.className).toContain('is-packed'))
})

/* ---- 勾选持久化（F7-03）：真相在库里，不在这一屏 ---- */

it('勾选走接口：点一下立刻划掉（乐观），请求带的是"勾上"这个目标状态', async () => {
  mockGet()
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: board({ checkedNames: ['鸡蛋'], checkedCount: 1 }) } as never)
  renderList()

  expect(await screen.findByText('买到 0/2')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: /鸡蛋/ }))

  // 乐观：不等响应就先划掉
  expect(await screen.findByText('买到 1/2')).toBeTruthy()
  // 请求体是"勾上 鸡蛋"（不是"翻一下"——重放同一个请求结果一样）
  expect(post).toHaveBeenCalledWith('/shopping-list/check', { name: '鸡蛋', checked: true })
})

it('**重新打开这一页，勾还在**（勾选存库里，不是这一屏的临时状态）', async () => {
  mockGet()
  vi.spyOn(apiClient, 'post').mockResolvedValue({ data: board({ checkedNames: ['鸡蛋'], checkedCount: 1 }) } as never)
  const client = newClient()
  const first = renderWith(client)

  fireEvent.click(await screen.findByRole('checkbox', { name: /鸡蛋/ }))
  await waitFor(() => expect(screen.getByText('买到 1/2')).toBeTruthy())

  // 整页卸载再挂上 = 离开再回来（组件里的 useState 会被清掉，服务端状态不会）
  first.unmount()
  renderWith(client)

  expect(await screen.findByText('买到 1/2')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: /鸡蛋/ }) as HTMLInputElement).checked).toBe(true)
})

it('勾选失败要**把这一样翻回去**并说出来（不能悄悄留着一个假勾）', async () => {
  mockGet()
  vi.spyOn(apiClient, 'post').mockRejectedValue(axiosError(500, '厨房服务开小差了'))
  renderList()

  fireEvent.click(await screen.findByRole('checkbox', { name: /鸡蛋/ }))

  await waitFor(() => expect(screen.getByText('买到 0/2')).toBeTruthy())
  expect((screen.getByRole('checkbox', { name: /鸡蛋/ }) as HTMLInputElement).checked).toBe(false)
  expect(lastToast()?.text).toContain('厨房服务开小差了')
  expect(lastToast()?.tone).toBe('error')
})

/* ---- 分组（F7-03）：要买的按货架排 ---- */

it('要买的按**货架**分组显示（买菜是一个区一个区扫过去的）', async () => {
  mockGet({
    list: board({
      items: [
        { name: '鸡蛋', amount: '5个', from: ['番茄炒蛋'], ...noStock },
        { name: '生抽', amount: '适量', from: ['红烧肉'], ...noStock },
      ],
      aisles: [
        { aisle: '蛋奶豆制品', items: [{ name: '鸡蛋', amount: '5个', from: ['番茄炒蛋'], ...noStock }] },
        { aisle: '调味干货', items: [{ name: '生抽', amount: '适量', from: ['红烧肉'], ...noStock }] },
      ],
    }),
  })
  renderList()

  const titles = await screen.findAllByRole('heading', { level: 3 })
  expect(titles.map((node) => node.textContent)).toEqual(['蛋奶豆制品', '调味干货'])
  // 组标题与行都在
  expect(screen.getByText('鸡蛋')).toBeTruthy()
  expect(screen.getByText('生抽')).toBeTruthy()
})

/* ---- 自加条目（F7-03「增减条目」） ---- */

it('能往清单上加一条没有菜谱的东西（垃圾袋），加完就在清单上', async () => {
  mockGet()
  const added = { name: '垃圾袋', amount: '两卷', from: [], extra: true, extraId: 'e1', ...noStock }
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: board({ items: [...board().items, added], aisles: [{ aisle: '其他', items: [added] }] }),
  } as never)
  renderList()

  fireEvent.click(await screen.findByRole('button', { name: /加一样清单上没有的/ }))
  fireEvent.change(screen.getByLabelText('要加的东西'), { target: { value: '垃圾袋' } })
  fireEvent.change(screen.getByLabelText('数量（可不写）'), { target: { value: '两卷' } })
  fireEvent.click(screen.getByRole('button', { name: '加上去' }))

  expect(await screen.findByText('垃圾袋')).toBeTruthy()
  expect(post).toHaveBeenCalledWith('/shopping-list/extras', { name: '垃圾袋', amount: '两卷' })
  expect(lastToast()?.text).toContain('加上「垃圾袋」了')
})

it('加一条**清单上已经有**的：把服务端那句话原样说出来（不写成"操作失败"）', async () => {
  mockGet()
  vi.spyOn(apiClient, 'post').mockRejectedValue(axiosError(400, '清单上已经有「鸡蛋」了（菜单里那道菜要用的，直接勾它就行）'))
  renderList()

  fireEvent.click(await screen.findByRole('button', { name: /加一样清单上没有的/ }))
  fireEvent.change(screen.getByLabelText('要加的东西'), { target: { value: '鸡蛋' } })
  fireEvent.click(screen.getByRole('button', { name: '加上去' }))

  await waitFor(() => expect(lastToast()?.text).toBe('清单上已经有「鸡蛋」了（菜单里那道菜要用的，直接勾它就行）'))
  expect(lastToast()?.tone).toBe('error')
})

it('自加的那条带「删掉」，删了就发 DELETE（菜单推出来的条目没有这个按钮）', async () => {
  const extra = { name: '垃圾袋', amount: '两卷', from: [], extra: true, extraId: 'e1', ...noStock }
  mockGet({ list: board({ items: [...board().items, extra], aisles: [{ aisle: '其他', items: [extra] }] }) })
  const del = vi.spyOn(apiClient, 'delete').mockResolvedValue({
    data: board({ items: board().items, aisles: [{ aisle: '蔬菜水果', items: board().items }] }),
  } as never)
  renderList()

  fireEvent.click(await screen.findByRole('button', { name: '把「垃圾袋」从清单上删掉' }))
  // 写请求在微任务里发出（mutate 不当场调用 mutationFn），断言要等它一下
  await waitFor(() => expect(del).toHaveBeenCalledWith('/shopping-list/extras/e1'))
  await waitFor(() => expect(screen.queryByText('垃圾袋')).toBeNull())
  // 菜单推出来的那两样**没有**删掉按钮（删了下次请求还会回来，它该不该在由菜单决定）
  expect(screen.queryByRole('button', { name: '把「鸡蛋」从清单上删掉' })).toBeNull()
})

/* ---- 一键补货（F7-05） ---- */

it('一键补货：勾了几样就补几样，补完钩子清掉、东西写进冰箱', async () => {
  mockGet()
  const post = vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/shopping-list/check') {
      return Promise.resolve({ data: board({ checkedNames: ['鸡蛋'], checkedCount: 1 }) } as never)
    }
    if (url === '/shopping-list/restock') {
      return Promise.resolve({
        data: { added: [{ id: 'f1', name: '鸡蛋', zone: '冷藏', amount: null }], skipped: [], board: board() },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  renderList()

  // 一样都没勾时**不画**这个按钮（画一个按不动的按钮不如不画）
  expect(await screen.findByText('买到 0/2')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /记进冰箱/ })).toBeNull()

  fireEvent.click(screen.getByRole('checkbox', { name: /鸡蛋/ }))
  fireEvent.click(await screen.findByRole('button', { name: /把这 1 样记进冰箱/ }))

  await waitFor(() => expect(post).toHaveBeenCalledWith('/shopping-list/restock', { names: ['鸡蛋'] }))
  // 补完：勾被清掉（已经进冰箱了，还亮着勾会让人以为没放进去）
  await waitFor(() => expect(screen.getByText('买到 0/2')).toBeTruthy())
  expect(lastToast()?.text).toContain('记进冰箱 1 样')
})

it('补货时"冰箱里已经有了"的那几样要说出来（跳过不是失败，用户得知道去合并）', async () => {
  mockGet()
  vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/shopping-list/check') {
      return Promise.resolve({ data: board({ checkedNames: ['鸡蛋'], checkedCount: 1 }) } as never)
    }
    return Promise.resolve({
      data: {
        added: [], skipped: [{ name: '鸡蛋', why: '冷藏里已经有一条了' }], board: board(),
      },
    } as never)
  })
  renderList()

  fireEvent.click(await screen.findByRole('checkbox', { name: /鸡蛋/ }))
  fireEvent.click(await screen.findByRole('button', { name: /把这 1 样记进冰箱/ }))

  await waitFor(() => expect(lastToast()?.text).toContain('1 样冰箱里已经有了'))
})

/* ---- 与库存比对（F7-02，D-059 口径不变） ---- */

const covered = (over: Partial<ShoppingItem> & { name: string }): ShoppingItem => ({
  amount: '2个',
  from: ['番茄炒蛋'],
  stock: { verdict: 'enough', stockName: over.name, stockAmount: '6个', remaining: null },
  needsBuy: false,
  stockLabel: '家里有 6个，够了',
  ...over,
})

it('家里够的从"要买的"里拿掉，收在「家里有 N 样」那条线里（默认不展开）', async () => {
  mockGet({
    list: board({
      items: [
        { name: '番茄', amount: '2个', from: ['番茄炒蛋'], ...noStock },
        covered({ name: '鸡蛋' }),
      ],
      toBuyCount: 1,
      coveredCount: 1,
      stockEmpty: false,
    }),
  })
  renderList()

  expect(await screen.findByText('番茄')).toBeTruthy()
  // 要买的那组里没有鸡蛋
  expect(screen.queryByText('鸡蛋')).toBeNull()
  // 那条线说清有几样不用买
  expect(screen.getByText(/家里有 1 样，不用买/)).toBeTruthy()
  // 默认收起：鸡蛋那一行不该在
  expect(screen.queryByText('家里有 6个，够了')).toBeNull()
})

it('展开那条线才看到"家里有什么、有多少"（点开是有意的动作，不是默认噪音）', async () => {
  mockGet({
    list: board({
      items: [covered({ name: '鸡蛋' })],
      toBuyCount: 0,
      coveredCount: 1,
      stockEmpty: false,
    }),
  })
  renderList()

  // 全都不用买：这是一句好消息，直接铺开（没有"要买的"要让它位置）
  expect(await screen.findByText(/这 1 样冰箱里都有，不用买了/)).toBeTruthy()
  expect(screen.getByText('家里有 6个，够了')).toBeTruthy()
})

it('**"量算不清"的要明说，绝不写"够了"**（写"够了"是编的，藏起来用户会以为漏了）', async () => {
  mockGet({
    list: board({
      items: [
        covered({
          name: '盐',
          amount: '适量',
          stock: { verdict: 'unknown', stockName: '盐', stockAmount: '一罐', remaining: null },
          stockLabel: '家里有 一罐，够不够看一眼',
        }),
      ],
      toBuyCount: 0,
      coveredCount: 1,
      unsureCount: 1,
      stockEmpty: false,
    }),
  })
  renderList()

  expect(await screen.findByText('家里有 一罐，够不够看一眼')).toBeTruthy()
  // 那句总结也要提醒（用户扫一眼就知道有几样得自己判断）
  expect(screen.getByText(/1 样的量没法算清，下厨前看一眼/)).toBeTruthy()
})

it('家里不够的留在"要买的"里，并说出**还要买多少**', async () => {
  mockGet({
    list: board({
      items: [
        {
          name: '鸡蛋',
          amount: '5个',
          from: ['番茄炒蛋'],
          stock: { verdict: 'notEnough', stockName: '鸡蛋', stockAmount: '3个', remaining: '2个' },
          needsBuy: true,
          stockLabel: '家里有 3个，还要买 2个',
        },
      ],
      toBuyCount: 1,
      stockEmpty: false,
    }),
  })
  renderList()

  expect(await screen.findByText('鸡蛋')).toBeTruthy()
  expect(screen.getByText('家里有 3个，还要买 2个')).toBeTruthy()
})

it('勾选进度的分母**只算要买的**（把"家里有"的算进去，用户永远买不到 100%）', async () => {
  mockGet({
    list: board({
      items: [
        { name: '番茄', amount: '2个', from: ['番茄炒蛋'], ...noStock },
        covered({ name: '鸡蛋' }),
      ],
      toBuyCount: 1,
      coveredCount: 1,
      stockEmpty: false,
    }),
  })
  renderList()

  expect(await screen.findByText('买到 0/1')).toBeTruthy()
  expect(screen.queryByText('买到 0/2')).toBeNull()
})

it('冰箱里没记东西时说清"没替你扣掉什么"并给出路（不说的话用户以为这功能没用）', async () => {
  mockGet({ list: board({ stockEmpty: true }) })
  renderList()

  expect(await screen.findByText(/冰箱里还没记东西，所以这份清单没替你扣掉什么/)).toBeTruthy()
  const link = screen.getByRole('link', { name: /记一下冰箱里有什么/ })
  expect(link.getAttribute('href')).toBe('/fridge')
})

it('冰箱里有东西时不出现那句（它是给空冰箱的，不是常驻提示）', async () => {
  mockGet({ list: board({ stockEmpty: false }) })
  renderList()

  await screen.findByText('鸡蛋')
  expect(screen.queryByText(/没替你扣掉什么/)).toBeNull()
})

it('页脚说清匹配口径（"五花肉不算猪肉"这类保守判断要让用户知道）', async () => {
  mockGet()
  renderList()

  expect(await screen.findByText(/名字对得上冰箱的才算"家里有"/)).toBeTruthy()
})
