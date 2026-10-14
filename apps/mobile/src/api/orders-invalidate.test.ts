// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { invalidateAfterMenuChange } from '@/api/orders'
import { useAuth } from '@/stores/auth'

/**
 * 改菜单之后要作废哪些缓存（用户 2026-10-14 报的第二件事的真身）。
 *
 * 用户的原话：「我加入订单后，说是选好了状态，采购清单那边就出现了，
 * 但是**实际是我点击开始做之后才出现的**」。
 *
 * 真身不在后端（后端在 PLANNED 那一刻就算出全部配料了，实测 19/19），
 * 而在前端：点菜/改状态只作废了 `orders`，**没作废 `shopping`**。
 * 清单页那份缓存 `staleTime` 是 30 秒，所以用户切过去看到的还是加菜之前的旧清单，
 * 等几十秒再回来（或碰上一次重挂载）才对——看起来就像"要点开始做才出现"。
 *
 * 这一组盯住的就是那张清单：**凡是按菜单算出来的域，一个都不能漏**。
 */

beforeEach(() => {
  useAuth.getState().setSession({
    token: 'test-token', refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => vi.restoreAllMocks())

it('改菜单后采购清单的缓存也被作废（这是用户报的那个漏）', async () => {
  const client = new QueryClient()
  // 清单页真正在用的键（与 `shoppingKey()` 一致）
  client.setQueryData(['shopping', 'list', 'default'], { items: [], toBuyCount: 0 })
  client.setQueryData(['orders', 'family', 'ALL'], { cards: [], counts: {} })

  invalidateAfterMenuChange(client)

  // 作废是异步的（invalidateQueries 返回 promise），等一轮微任务
  await Promise.resolve()
  expect(client.getQueryState(['shopping', 'list', 'default'])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['orders', 'family', 'ALL'])?.isInvalidated).toBe(true)
})

it('菜单推出来的那些域都在清单里（漏一个就是"页面看不见刚发生的事"）', async () => {
  const client = new QueryClient()
  const keys = [['orders'], ['shopping']]
  for (const key of keys) client.setQueryData(key, {})
  invalidateAfterMenuChange(client)
  await Promise.resolve()
  for (const key of keys) {
    expect(client.getQueryState(key)?.isInvalidated, `${key.join('/')} 没被作废`).toBe(true)
  }
})

it('备菜计划读的是 orders 的 plan 键：不单独列也该跟着走', async () => {
  /*
   * 备菜页（`/prep`）用的是 `usePlanBoard`，键是 `['orders', 'plan', days]`——
   * 它挂在 `orders` 下，所以作废 `orders` 就够了。
   * 这一条钉住那个前提：哪天它换了键（比如挪到 `['prep', ...]`），这条会红。
   */
  const client = new QueryClient()
  client.setQueryData(['orders', 'plan', 7], { days: [] })
  invalidateAfterMenuChange(client)
  await Promise.resolve()
  expect(client.getQueryState(['orders', 'plan', 7])?.isInvalidated).toBe(true)
})

it('点一道菜真的会同时作废清单（走真接口，不是只测那个函数）', async () => {
  /*
   * 上面几条验的是那个函数本身；这一条验的是**它真的接在点菜这条路上**——
   * 第一版的错就是"函数写对了但没人调它"，只测函数是抓不到的。
   */
  vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: {
      mealKey: '2026-10-14-DINNER', date: '2026-10-14', meal: 'DINNER', mealLabel: '晚餐',
      status: 'PENDING', statusLabel: '待确认', orderers: ['妈妈'], ordererCount: 1, dishCount: 1,
      dishes: [], items: [], mineCount: 1, dinerCount: null, photoCount: 0,
      confirmedBy: null, confirmedAt: null, doneBy: null, doneAt: null, canRepeat: false, nextActions: [],
      submittedAt: new Date().toISOString(),
    },
  } as never)

  const { renderHook, waitFor } = await import('@testing-library/react')
  const { QueryClientProvider } = await import('@tanstack/react-query')
  const { useAddOrderItem } = await import('@/api/orders')
  const { createElement } = await import('react')

  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  client.setQueryData(['shopping', 'list', 'default'], { items: [], toBuyCount: 0 })

  const { result } = renderHook(() => useAddOrderItem(), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  result.current.mutate({ recipeId: 'r1', mealDate: '2026-10-14', meal: 'DINNER' } as never)

  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  await waitFor(() => expect(client.getQueryState(['shopping', 'list', 'default'])?.isInvalidated).toBe(true))
})
