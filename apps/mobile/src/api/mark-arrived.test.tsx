// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { AxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { NotificationBoard } from '@/api/notifications'
import { useMarkArrived } from '@/api/notifications'
import { boardFixture, notificationFixture } from '@/api/notifications.testkit'
import { useAuth } from '@/stores/auth'

/*
 * 「到过那条提醒指向的地方」就算看过（用户 2026-10-14：「我点进去怎么还是菜单啊，
 * 没有去掉红点啊」）。
 *
 * 判据是**后端给的那个 `to`**，不是每个页面各写一条规则——所以这里测的就是那条等式：
 * 地址与 `to` 一致 → 标已读；不一致 → 一条都不动。`/order/<mealKey>`、`/prep`、
 * `/fridge` 三处共用这一份判断，以后加新类别也不用回来改。
 */

const clients: QueryClient[] = []

function Board() {
  useMarkArrived(window.location.pathname)
  return null
}

function mockBoard(items: NotificationBoard['items']) {
  const posts: { url: string; body: unknown }[] = []
  // 那三个未读数由夹具按 items 算（与后端同一份投影），用例不必手写
  vi.spyOn(apiClient, 'get').mockImplementation(() => Promise.resolve({ data: boardFixture({ items }) } as never))
  vi.spyOn(apiClient, 'post').mockImplementation((url: string, body: unknown, _config?: AxiosRequestConfig) => {
    posts.push({ url, body })
    return Promise.resolve({ data: { read: 1 } } as never)
  })
  return posts
}

function item(patch: Partial<NotificationBoard['items'][number]>) {
  return notificationFixture({
    id: 'plan:2026-10-14-LUNCH',
    kind: 'plan',
    title: '今天午餐的菜单定下来了',
    body: null,
    at: '2026-10-14T10:00:00.000Z',
    to: '/order/2026-10-14-LUNCH',
    mealKey: '2026-10-14-LUNCH',
    tag: '选好了',
    unread: true,
    ...patch,
  })
}

function renderAt(pathname: string) {
  window.history.replaceState({}, '', pathname)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Board />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
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

it('到了那条提醒指向的地方：把它标成已读（红点因此灭掉）', async () => {
  const posts = mockBoard([item({})])
  renderAt('/order/2026-10-14-LUNCH')

  await waitFor(() => expect(posts.length).toBe(1))
  expect(posts[0].url).toBe('/notifications/read-all')
  expect(posts[0].body).toEqual({ ids: ['plan:2026-10-14-LUNCH'] })
})

it('地址对不上就一条都不动（不能"到过订单就把订单的事全清了"）', async () => {
  const posts = mockBoard([
    item({}),
    item({ id: 'done:2026-10-13-DINNER', kind: 'done', to: '/order/2026-10-13-DINNER', mealKey: '2026-10-13-DINNER', tag: '做好了' }),
    item({ id: 'prep:2026-10-14', kind: 'prep', to: '/prep', mealKey: null, tag: '备菜' }),
  ])
  renderAt('/order/2026-10-14-LUNCH')

  await waitFor(() => expect(posts.length).toBe(1))
  // 只有**当前这一页**那一条（别的餐、别的类别的都没动）
  expect(posts[0].body).toEqual({ ids: ['plan:2026-10-14-LUNCH'] })
})

it('已经读过的不再提交（省一次没必要的写）', async () => {
  const posts = mockBoard([item({ unread: false })])
  renderAt('/order/2026-10-14-LUNCH')

  // 等一轮，确认没有提交
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(posts.length).toBe(0)
})

it('备菜那类也走同一条路：到了 /prep 就把它标掉', async () => {
  const posts = mockBoard([item({ id: 'prep:2026-10-14', kind: 'prep', to: '/prep', mealKey: null, tag: '备菜' })])
  renderAt('/prep')

  await waitFor(() => expect(posts.length).toBe(1))
  expect(posts[0].body).toEqual({ ids: ['prep:2026-10-14'] })
})
