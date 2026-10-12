// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it } from 'vitest'
import TabLayout from './TabLayout'

// 菜谱列表/详情不在底部 Tab 里，要借一个 Tab 表示"人在哪一块"。
// 用户报的正是这块：从发现页「摇一道」过去，底栏亮的却是厨房——
// 他点那个亮着的 Tab，落到的是厨房菜单页，而他是从发现页过来的。
//
// 盯的是**认定规则**（有来源认来源，认不出才回厨房）。高亮表现在两处：
// className 的 is-active（样式）与 aria-current="page"（无障碍），两个都验——
// 只验其中一个的话，另一个坏了照样静默通过。

function renderAt(pathname: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname, state }]}>
      <Routes>
        <Route element={<TabLayout />}>
          <Route path="*" element={<div data-testid="page" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

/** 底栏当前"亮着"的 Tab 文案（按 aria-current 判定） */
function activeTabs(): (string | null)[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent?.trim() ?? null)
}

function tabLink(label: string): HTMLElement {
  const link = screen.getAllByRole('link').find((item) => item.textContent?.trim() === label)
  if (!link) throw new Error(`底栏没有「${label}」这个 Tab`)
  return link
}

afterEach(cleanup)

it('从发现页摇进菜谱详情：亮的是「发现」，不是「厨房」', () => {
  renderAt('/recipes/r1', { from: '/discover' })

  expect(activeTabs()).toEqual(['发现'])
  // 底栏那个 Tab 指向 /discover——点它就是回发现页（这正是用户要的行为）
  expect(tabLink('发现').getAttribute('href')).toBe('/discover')
  // 借来的高亮不能顺带把"在厨房"也点亮（两份 active 会让人不知道该点哪个）
  expect(tabLink('厨房').getAttribute('aria-current')).toBeNull()
  expect(tabLink('厨房').className).not.toContain('is-active')
})

it('菜谱小书与详情同一套规则（列表页也认来源）', () => {
  renderAt('/recipes', { from: '/order' })
  expect(activeTabs()).toEqual(['订单'])
})

it('没有来源（直接敲地址/刷新丢了 state）退回厨房——菜谱库本来就归厨房', () => {
  renderAt('/recipes/r1')
  expect(activeTabs()).toEqual(['厨房'])
})

it('来源认不出来也退回厨房，不把未校验的值当高亮依据', () => {
  for (const bad of [{ from: '/nope' }, { from: 123 }, { from: ['/discover'] }, 'not-an-object']) {
    const view = renderAt('/recipes/r1', bad)
    expect(activeTabs()).toEqual(['厨房'])
    view.unmount()
  }
})

it('从菜谱小书自己跳过来（from 是菜谱小书）也回厨房——借不到 Tab 就退回归属', () => {
  renderAt('/recipes/r2', { from: '/recipes?q=鱼' })
  expect(activeTabs()).toEqual(['厨房'])
})

it('非菜谱页不借 Tab：高亮完全交给路由（冰箱页只有冰箱亮）', () => {
  renderAt('/fridge')
  expect(activeTabs()).toEqual(['冰箱'])
})
