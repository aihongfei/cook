// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { RecipeSummary } from '@/api/recipes'
import { useRecipeFilters } from '@/stores/recipe-filters'
import RecipeListPage from '@/pages/recipes/RecipeListPage'
import { readPlanTarget } from './plan-target'

// 「去安排」的目标要在 发现页 → 菜谱小书 → 菜谱详情 这一路上活下来（M4 / F4-02）。
// 只断言"链接上有 state"是不够的——真正会丢的是**中间某一跳忘了往下传**，
// 所以这里让路由真的走一遍，在目的地用 readPlanTarget 读回来。

const dish: RecipeSummary = {
  id: 'tomato', name: '番茄炒蛋', image: null, category: '素菜', cuisine: '家常',
  tags: ['快手'], calories: null, caloriesEstimated: false,
}
const clients: QueryClient[] = []

/** 详情页的位置探测器：显示"读回来的 target"是什么（复用产品代码里的读取口径） */
function TargetProbe() {
  const location = useLocation()
  const target = readPlanTarget(location.state)
  return <output data-testid="target">{target ? `${target.date}|${target.meal}|${target.label}` : 'no-target'}</output>
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useRecipeFilters.getState().reset()
  vi.spyOn(apiClient, 'get').mockImplementation(async (url) => ({
    data: url === '/recipes/filters'
      ? { categories: ['素菜'], cuisines: ['家常'] }
      : { items: [dish], total: 1, page: 1, pageSize: 12 },
  }))
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
})

it('目标经菜谱小书传到详情：日期、餐次、展示文案都还在', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  clients.push(client)
  const plan = { date: '2026-10-14', meal: 'DINNER' as const, label: '后天晚餐' }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/recipes', state: { from: '/discover', plan } }]}>
        <Routes>
          <Route path="/recipes" element={<RecipeListPage />} />
          <Route path="/recipes/:id" element={<TargetProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const card = (await screen.findByRole('link', { name: '查看番茄炒蛋菜谱' })) as HTMLAnchorElement
  card.click()
  expect((await screen.findByTestId('target')).textContent).toBe('2026-10-14|DINNER|后天晚餐')
})

it('没带目标时详情读到 null（普通浏览"想吃这道"不该被塞一个假目标）', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/recipes']}>
        <Routes>
          <Route path="/recipes" element={<RecipeListPage />} />
          <Route path="/recipes/:id" element={<TargetProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const card = (await screen.findByRole('link', { name: '查看番茄炒蛋菜谱' })) as HTMLAnchorElement
  card.click()
  expect((await screen.findByTestId('target')).textContent).toBe('no-target')
})

it('畸形/伪造的路由 state 读成 null（不把外部输入当可信数据）', () => {
  expect(readPlanTarget(null)).toBeNull()
  expect(readPlanTarget({ plan: null })).toBeNull()
  expect(readPlanTarget({ plan: { date: '2026/10/14', meal: 'DINNER' } })).toBeNull()
  expect(readPlanTarget({ plan: { date: '2026-10-14', meal: 'BREAKFAST' } })).toBeNull()
  expect(readPlanTarget({ plan: { meal: 'DINNER' } })).toBeNull()
  // label 缺失时退回日期本身（展示用，不能是空的）
  expect(readPlanTarget({ plan: { date: '2026-10-14', meal: 'DINNER' } })?.label).toBe('2026-10-14')
})
