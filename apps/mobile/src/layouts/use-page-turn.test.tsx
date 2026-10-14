// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { PAGE_TURN_MS, usePageTurn } from './use-page-turn'

/**
 * 换页方向与**动画类到点摘掉**（用户 2026-10-14：「前进后退没有那种左右翻页的效果」）。
 *
 * 这里只验 hook 的行为，节点上的类名就是切换动画的那根开关。
 * 下面第二条是**保命的那一条**——它对应的是 2026-10-14 装机时真撞上的故障：
 * 模拟器上打开应用，内容区空白了两分多钟，点一下底栏才画出来。
 * 原因是页面那一层挂着 `opacity: 0` 的入场动画，而**动画一直没跑**
 * （WebView 被节流），于是永远停在第一帧。
 *
 * 所以规矩是：**内容的可见性不许依赖动画跑没跑**。动画类必须在一小段时间后被摘掉，
 * 让这一层回到基础样式（完全可见的那一份）。
 */

function Probe() {
  const className = usePageTurn()
  return <div data-testid="page" className={['tab-layout__page', className].filter(Boolean).join(' ')} />
}

function Nav() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" onClick={() => navigate('/recipes/abc', { state: { from: '/recipes' } })}>进详情</button>
      <button type="button" onClick={() => navigate('/recipes')}>回列表</button>
      <button type="button" onClick={() => navigate('/recipes?category=汤')}>切品类汤</button>
      <button type="button" onClick={() => navigate('/recipes?category=面')}>切品类面</button>
    </>
  )
}

function renderAt(path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[state ? { pathname: path, state } : path]}>
      <Probe />
      <Nav />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  )
}

const pageClass = () => screen.getByTestId('page').className

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('进二级页挂 --forward，退回来挂 --back（两个方向不再一样）', async () => {
  renderAt('/recipes')
  // 首屏是那条中性的淡入
  expect(pageClass()).toContain('tab-layout__page--fade')

  act(() => screen.getByRole('button', { name: '进详情' }).click())
  expect(pageClass()).toContain('tab-layout__page--forward')

  // 等第一页的动画类收工再回退（否则看到的还是上一次留下的类）
  await act(async () => { await new Promise((r) => setTimeout(r, PAGE_TURN_MS + 120)) })
  act(() => screen.getByRole('button', { name: '回列表' }).click())
  expect(pageClass()).toContain('tab-layout__page--back')
})

it('动画类到点就摘掉：不能留着让页面永远停在 opacity:0（装机时真撞上过）', async () => {
  vi.useFakeTimers()
  renderAt('/recipes')
  expect(pageClass()).toContain('tab-layout__page--fade')

  // 走完一整趟：过一小会儿这一层不该再挂任何动画类
  act(() => { vi.advanceTimersByTime(PAGE_TURN_MS + 120) })
  expect(pageClass()).toBe('tab-layout__page')

  // 换页之后同样会收工（每一页都要收，不是只有第一页）
  act(() => screen.getByRole('button', { name: '进详情' }).click())
  expect(pageClass()).toContain('tab-layout__page--forward')
  act(() => { vi.advanceTimersByTime(PAGE_TURN_MS + 120) })
  expect(pageClass()).toBe('tab-layout__page')
})

it('摘掉之后不再挂回来（换页那一刻挂一次，之后一直干净）', async () => {
  vi.useFakeTimers()
  renderAt('/recipes')
  act(() => { vi.advanceTimersByTime(PAGE_TURN_MS + 120) })
  expect(pageClass()).toBe('tab-layout__page')

  // 再等很久也不该有变化
  act(() => { vi.advanceTimersByTime(5000) })
  expect(pageClass()).toBe('tab-layout__page')
})

/**
 * 用户 2026-10-15：「这三个切换时，页面会抖；还有首页那些 tab 的，没加载过的第一次点会闪现一下」。
 *
 * 根因是"换页"的判据拿了整条地址：`/recipes/mine?tab=收藏的` 与 `?tab=原创的` 被当成两个页面，
 * 于是点一个 tab 就**整页重播入场动画**（页头、标题、tab 条一起变透明再从右边滑进来）。
 * 页面内那些把状态存进查询串的控件改的是**同一个页面**的内容，不是换了一页。
 */
it('只改查询串不算换页：页内 tab 不该重播整页动画（用户报的"抖/闪"）', async () => {
  vi.useFakeTimers()
  renderAt('/recipes')
  act(() => { vi.advanceTimersByTime(PAGE_TURN_MS + 120) })
  expect(pageClass()).toBe('tab-layout__page')

  // 切一个品类（只改 ?category=）：动画类不许挂回来
  act(() => screen.getByRole('button', { name: '切品类汤' }).click())
  expect(pageClass()).toBe('tab-layout__page')

  // 再切一个（也已经收工）同样干净
  act(() => screen.getByRole('button', { name: '切品类面' }).click())
  expect(pageClass()).toBe('tab-layout__page')

  // 而且等多久都不会"迟到地"播一下
  act(() => { vi.advanceTimersByTime(1000) })
  expect(pageClass()).toBe('tab-layout__page')
})

it('动画还没收工时改查询串：不重播（类名不变，CSS 动画就不会重头来）', async () => {
  vi.useFakeTimers()
  renderAt('/recipes')
  // 首屏那条淡入还在跑的时候切品类
  act(() => { vi.advanceTimersByTime(40) })
  expect(pageClass()).toContain('--fade')
  act(() => screen.getByRole('button', { name: '切品类汤' }).click())
  // 还是那一条，没有换成 --forward
  expect(pageClass()).toContain('--fade')

  act(() => { vi.advanceTimersByTime(PAGE_TURN_MS + 120) })
  expect(pageClass()).toBe('tab-layout__page')
})

it('换页面照旧播（别把这条规则做没了）', async () => {
  vi.useFakeTimers()
  renderAt('/recipes')
  act(() => { vi.advanceTimersByTime(PAGE_TURN_MS + 120) })

  // 先切品类（同页，不播），再进详情（换页，要播）
  act(() => screen.getByRole('button', { name: '切品类汤' }).click())
  expect(pageClass()).toBe('tab-layout__page')
  act(() => screen.getByRole('button', { name: '进详情' }).click())
  expect(pageClass()).toContain('--forward')
})
