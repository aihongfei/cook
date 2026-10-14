// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuth } from '@/stores/auth'
import KeepAlivePages from './KeepAlivePages'
import { evictKeys } from './keep-alive.rules'

/*
 * 页面缓存（用户 2026-10-14：「你是不是使用类似vue keepalive那种就行了，不光是滚动位置，
 * 就相当于是有缓存的，不是重新加载页面」）。
 *
 * 三条最要紧的性质：
 * ① **回到一页时它还在**（不重挂载）——这是用户要的"不重新加载"；
 * ② **缓存页读到的是它自己的地址**，不是当前地址（否则它的链接、`state.from` 全错）；
 * ③ **不涨**：超过上限丢最久没用过的，当前这一页永远不丢。
 */

const clients: QueryClient[] = []
/** 挂载次数记在模块级：重挂载会 +1，正是这里要看的 */
let mounts: Record<string, number> = {}

/** 这一页的第几次挂载：`useState` 的初始化函数**只在挂载时跑**，重渲染不会再加 */
function useMountNumber(name: string): number {
  const [count] = useState(() => {
    mounts[name] = (mounts[name] ?? 0) + 1
    return mounts[name]
  })
  return count
}

function Page({ name }: { name: string }) {
  const location = useLocation()
  const count = useMountNumber(name)
  return (
    <div>
      <span data-testid={`mounted-${name}`}>{count}</span>
      <span data-testid={`path-${name}`}>{location.pathname}</span>
      {/* 真实的路由跳转（MemoryRouter 里点这个 Link 与用户点页面里的链接同一条路） */}
      <Link to="/next">去下一页</Link>
    </div>
  )
}

function renderShell(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<KeepAlivePages activeTurnClass="" />}>
            <Route path="/a" element={<Page name="a" />} />
            <Route path="/b" element={<Page name="b" />} />
            <Route path="/c" element={<Page name="c" />} />
            <Route path="/next" element={<Page name="next" />} />
            <Route path="/meal/:mealKey" element={<MealPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 带参数的一页：读自己的地址，看"冻住的那份"有没有把参数带错 */
function MealPage() {
  const location = useLocation()
  const count = useMountNumber('meal')
  return (
    <div>
      <span data-testid="mounted-meal">{count}</span>
      <span data-testid="path-meal">{location.pathname}</span>
      <Link to="/a">去 A</Link>
    </div>
  )
}

beforeEach(() => {
  mounts = {}
  localStorage.clear()
  useAuth.getState().setSession({
    token: 't',
    refreshToken: 'r',
    user: { id: 'u1', account: 'a', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('回到一页时它还在：**不重挂载**（"不重新加载页面"的核心）', async () => {
  renderShell('/a')
  expect((await screen.findByTestId('mounted-a')).textContent).toBe('1')

  // 走一趟 B 页再回来（A 页那份组件树一直挂着，只是被藏起来）
  fireEvent.click(screen.getByRole('link', { name: '去下一页' }))
  await screen.findByTestId('mounted-next')

  // 回来：还是那一份，挂载次数没有涨（重挂载的话会是 2）
  expect(screen.getByTestId('mounted-a').textContent).toBe('1')
})

it('藏起来的那一页不显示、也不占位置；当前这一页显示着', async () => {
  renderShell('/a')
  await screen.findByTestId('mounted-a')
  fireEvent.click(screen.getByRole('link', { name: '去下一页' }))
  await screen.findByTestId('mounted-next')

  const wrapperOf = (testId: string) =>
    screen.getByTestId(testId).closest('.tab-layout__page') as HTMLElement
  expect(wrapperOf('mounted-a').hidden).toBe(true) // 缓存着但不显示
  expect(wrapperOf('mounted-next').hidden).toBe(false)
})

it('缓存页读到的是**它自己的地址**，不是当前地址（不然它的链接全指错）', async () => {
  renderShell('/a')
  await screen.findByTestId('path-a')
  fireEvent.click(screen.getByRole('link', { name: '去下一页' }))
  await screen.findByTestId('path-next')

  // A 页虽然还挂着，但它读到的仍然是 `/a`——不是 `/next`
  expect(screen.getByTestId('path-a').textContent).toBe('/a')
  expect(screen.getByTestId('path-next').textContent).toBe('/next')
})

it('带参数的详情页也缓存得住，参数不会被下一次跳转带错', async () => {
  renderShell('/meal/2026-10-14-DINNER')
  await screen.findByTestId('path-meal')

  fireEvent.click(screen.getByRole('link', { name: '去 A' }))
  await screen.findByTestId('mounted-a')

  // 那一页仍在（缓存着），读到的还是它自己那一餐
  expect(screen.getByTestId('path-meal').textContent).toBe('/meal/2026-10-14-DINNER')
  expect(screen.getByTestId('mounted-meal').textContent).toBe('1')
})

it('一个地址只占一份缓存：来回切多次也不增多、不重挂载', async () => {
  renderShell('/a')
  await screen.findByTestId('mounted-a')
  fireEvent.click(screen.getByRole('link', { name: '去下一页' }))
  await screen.findByTestId('mounted-next')

  expect(screen.getAllByTestId('mounted-a').length).toBe(1)
  expect(screen.getAllByTestId('mounted-next').length).toBe(1)
  expect(screen.getByTestId('mounted-next').textContent).toBe('1')
})

/*
 * 淘汰规则是纯函数，直接测它（组件那一层测"超过 6 页丢谁"要渲染七页，
 * 而判据全在这个函数里）。
 */
it('淘汰规则：保留当前页 + 最近用过的，超出的丢掉', () => {
  // 最近使用顺序：a 最旧、e 最新
  const keys = ['a', 'b', 'c', 'd', 'e']
  // 上限 3：留下当前页 e 与最近用过的 d、c，丢掉 a、b
  expect(evictKeys(keys, 'e', 3)).toEqual(['a', 'b'])
  // 当前页**永远不丢**，哪怕它是最旧的那个
  expect(evictKeys(keys, 'a', 3)).toEqual(['b', 'c'])
  // 没超上限就一个都不丢
  expect(evictKeys(keys, 'e', 9)).toEqual([])
})
