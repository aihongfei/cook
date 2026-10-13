// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { CookableBoard, CookableDish } from '@/api/fridge'
import { useAuth } from '@/stores/auth'
import CookablePage from './CookablePage'

const srcDir = join(__dirname, '..', '..')

/**
 * 「能做点什么」的完整列表（F5-04 / F6-07）。入口是冰箱页横滑条末尾的「看全部」。
 *
 * 要盯住的四件事：
 * ① 翻页**接着来、不重不漏**（`offset` 按已翻出的条数推，末页不会重复请求同一批）；
 * ② 从冰箱页带过来的口径（挑好的几样 / 只看不用买的）**原样生效**——
 *    点进来看到的必须是"刚才那份结果的全部"，不是另一套算法；
 * ③ 从这一页进菜谱详情，**返回时回到这一页并保留筛选**（URL 里的查询串就是这件事的载体）；
 * ④ 一道都没有时说清原因并给出路（不编内容）。
 */

const clients: QueryClient[] = []

function Probe() {
  const location = useLocation()
  return <div data-testid="probe">{`${location.pathname}${location.search}|${(location.state as { from?: string } | null)?.from ?? 'no-from'}`}</div>
}

function renderPage(entry = '/fridge/cookable') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/fridge/cookable" element={<CookablePage />} />
          <Route path="/recipes/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function dish(over: Partial<CookableDish> & { id: string; name: string }): CookableDish {
  return {
    image: null, category: null, cuisine: null, calories: null, caloriesEstimated: false,
    have: ['鸡蛋'], missing: [], missingCount: 0, ...over,
  }
}

/** 后端按 offset 切页的样子（真接口就是 `ranked.slice(offset, offset + limit)`） */
function pagedBoard(all: CookableDish[], offset: number, limit: number): CookableBoard {
  return {
    source: 'fridge', scope: 'family', pantry: ['鸡蛋'], usable: 1, skipSeasonings: 0,
    maxMissing: 1, total: all.length, offset, filteredOut: 0,
    items: all.slice(offset, offset + limit),
  }
}

let calls: string[] = []

function mockGet(all: CookableDish[], over: Partial<CookableBoard> = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (!url.startsWith('/fridge/cookable')) throw new Error(`未预期的请求：${url}`)
    calls.push(url)
    const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
    const offset = Number(query.get('offset') ?? 0)
    const limit = Number(query.get('limit') ?? 12)
    return Promise.resolve({ data: { ...pagedBoard(all, offset, limit), ...over } } as never)
  })
}

const many = (count: number) => Array.from({ length: count }, (_, i) =>
  dish({ id: `r${i}`, name: `菜${i + 1}` }),
)

beforeEach(() => {
  localStorage.clear()
  calls = []
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

it('一行一道：名字 + 用上了什么 + 还差什么（这是这一页唯一敢下的结论）', async () => {
  mockGet([
    dish({ id: 'r1', name: '番茄炒蛋', have: ['鸡蛋', '西红柿'], missing: ['番茄'], missingCount: 1 }),
  ])
  renderPage()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.getByText('用上了 鸡蛋、西红柿')).toBeTruthy()
  expect(screen.getByText('还差 番茄')).toBeTruthy()
  expect(screen.getByText('差 1 样')).toBeTruthy()
})

it('"不用买就能做"的道：徽章说不用买，且**不说**还差什么', async () => {
  mockGet([dish({ id: 'r1', name: '蒸蛋' })])
  renderPage()

  const row = (await screen.findByText('蒸蛋')).closest('.cooklist__item') as HTMLElement
  expect(row.querySelector('.cooklist__badge')?.textContent).toBe('不用买')
  expect(row.querySelector('.cooklist__missing')).toBeNull()
})

it('一次只取一页，「再看一页」接着翻（offset 从已翻出的条数推，不重复请求同一批）', async () => {
  mockGet(many(20))
  renderPage()

  expect(await screen.findByText('菜1')).toBeTruthy()
  // 第一页 12 道，不该出现第 13 道
  expect(screen.queryByText('菜13')).toBeNull()
  expect(screen.getByText(/再看一页（还有 8 道）/)).toBeTruthy()

  screen.getByRole('button', { name: /再看一页/ }).click()

  expect(await screen.findByText('菜13')).toBeTruthy()
  // 第二页的请求带着 offset=12（12 = 已经翻出来的条数）
  await waitFor(() => expect(calls.some((url) => url.includes('offset=12'))).toBe(true))
  // 翻到底：不再有下一页，也不该重复请求
  expect(screen.queryByRole('button', { name: /再看一页/ })).toBeNull()
  expect(screen.getByText('能做的都在这里了。')).toBeTruthy()
  // 一共 20 道，只取了两页（不是把每页都重取一遍）
  expect(calls.length).toBe(2)
})

it('把冰箱页的口径带过来：挑好的几样进 ingredients、只看不用买的进 maxMissing=0', async () => {
  mockGet([dish({ id: 'r1', name: '蒸蛋' })])
  renderPage('/fridge/cookable?ingredients=%E9%B8%A1%E8%9B%8B,%E8%A5%BF%E7%BA%A2%E6%9F%BF&maxMissing=0')

  await screen.findByText('蒸蛋')
  const first = calls[0]
  expect(first).toContain('ingredients=%E9%B8%A1%E8%9B%8B%2C%E8%A5%BF%E7%BA%A2%E6%9F%BF')
  expect(first).toContain('maxMissing=0')
  // 页面要说清"按你挑的那几样算"，用户才知道看到的不是整个冰箱
  expect(screen.getByText('按你挑的那几样算')).toBeTruthy()
})

it('点开「只看不用买的」是**改地址**（筛选活过跳转，也能直接分享这一屏）', async () => {
  mockGet([dish({ id: 'r1', name: '蒸蛋' })])
  renderPage()

  await screen.findByText('蒸蛋')
  screen.getByRole('button', { name: '只看不用买的' }).click()

  await waitFor(() => expect(calls.at(-1)).toContain('maxMissing=0'))
  expect(screen.getByRole('button', { name: '只看不用买的' }).getAttribute('aria-pressed')).toBe('true')
})

it('点一道进菜谱详情，带回来的来源是**这一页的完整地址**（含筛选），返回能回到原处', async () => {
  mockGet([dish({ id: 'r1', name: '蒸蛋' })])
  renderPage('/fridge/cookable?maxMissing=0')

  const link = (await screen.findByText('蒸蛋')).closest('a') as HTMLAnchorElement
  expect(link.getAttribute('href')).toBe('/recipes/r1')
  link.click()

  expect((await screen.findByTestId('probe')).textContent)
    .toBe('/recipes/r1|/fridge/cookable?maxMissing=0')
})

it('冰箱里没有可算的东西时说清原因并给出路（不编一道菜出来）', async () => {
  mockGet([], { usable: 0, total: 0 })
  renderPage()

  expect(await screen.findByText(/冰箱里还没有能拿来做菜的东西（调料不算）/)).toBeTruthy()
  expect(screen.getByRole('link', { name: /去记冰箱里的东西/ }).getAttribute('href')).toBe('/fridge')
  expect(screen.queryByRole('link', { name: /查看/ })).toBeNull()
})

it('有食材但配不出菜：把两种原因分开说（"不用买"筛太紧 vs 名字对不上）', async () => {
  mockGet([], { usable: 3, total: 0 })
  renderPage('/fridge/cookable?maxMissing=0')

  expect(await screen.findByText(/这几样暂时没有"不用买就能做"的菜/)).toBeTruthy()
})

it('共享关掉时说明只按自己记的那些算（与冰箱页同一口径）', async () => {
  mockGet([dish({ id: 'r1', name: '蒸蛋' })], { scope: 'mine' })
  renderPage()

  expect(await screen.findByText(/家里关了共享，这里只按你自己记的那些算/)).toBeTruthy()
})

it('被口味档案挡掉的菜要报数（不声不响地少几道，用户会以为是配不出来）', async () => {
  mockGet([dish({ id: 'r1', name: '蒸蛋' })], { filteredOut: 2 })
  renderPage()

  expect(await screen.findByText(/有 2 道被口味档案挡掉了/)).toBeTruthy()
})

/*
 * 这一页与冰箱页那块的关系是**同一份结果**（同一个接口、同一个顺序），
 * 只是把剩下的翻出来。所以第一页的请求参数必须与冰箱页那份**只在 limit/offset 上不同**——
 * 口味容忍度（`maxMissing`）两边各写一套的话，点进来就会换一批菜。
 *
 * 这里钉两件：第一页不带 `offset`（就是"从头取一段"），且 `maxMissing` 与冰箱页
 * 默认那份**是同一个值**（1 = 容忍差一样；写成 0 会突然只剩"不用买"的几道）。
 */
it('第一页的请求就是冰箱页那份结果的第一段（口径一致，默认都容忍差 1 样）', async () => {
  mockGet(many(3))
  renderPage()

  await screen.findByText('菜1')
  expect(calls[0]).not.toContain('offset=')
  expect(calls[0]).toContain('maxMissing=1')
})

it('「再看一页」的文案说得出还剩几道（数字不能凭感觉写）', async () => {
  const css = readFileSync(join(srcDir, 'pages/fridge/fridge.scss'), 'utf8')
  // 分开的样式也有 id 可查（防止哪天顺手删掉一页到底的收尾那句）
  expect(css).toContain('.cooklist__more')
  expect(css).toContain('.cooklist__end')
})
