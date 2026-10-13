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
