// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuth } from '@/stores/auth'
import { LocalNotifySync } from './local-notify-sync'

/**
 * 排程的**接线层**（M10 交付二）。规则本身在 `local-notify.rules.test.ts` 里测，
 * 这里只盯三件"错了用户看得见、而纯规则测不到"的事：
 *
 * ① 登录后才做事（没登录不该白读一遍数据）；
 * ② **退出登录要清干净**——这条是真踩过的：原先同步器挂在 `TabLayout` 上，
 *    退出登录会把那个布局卸载，清理代码因此永远不跑，实测"退出后 9 条闹钟还在"；
 * ③ 没问过权限就自动问一次（用户要的"默认开着、不用设置"）。
 */

const spies = vi.hoisted(() => ({
  cancelAll: vi.fn(async () => undefined),
  rescheduleAll: vi.fn(async () => 0),
  requestPermission: vi.fn(async () => 'granted' as const),
  // 返回类型放宽成 NotifyPermission：用例里要把它改成 'prompt'（"从没问过"那条路）
  syncScheduled: vi.fn(async (): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'> => 'granted'),
}))

vi.mock('./local-notify', () => ({
  cancelAll: spies.cancelAll,
  rescheduleAll: spies.rescheduleAll,
  requestPermission: spies.requestPermission,
  syncScheduled: spies.syncScheduled,
}))

// 数据来自两个查询；这里不关心内容，只关心"要不要读、变了要不要重排"
vi.mock('@/api/orders', () => ({
  usePlanBoard: () => ({ data: undefined, refetch: vi.fn() }),
}))
vi.mock('@/api/fridge', () => ({
  useFridge: () => ({ data: undefined, refetch: vi.fn() }),
}))

const ME = { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' }

function renderSync() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LocalNotifySync />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
  Object.values(spies).forEach((spy) => spy.mockClear())
})

afterEach(cleanup)

it('没登录时不排、只把可能残留的撤掉（上一次会话留下的提醒不该活到这一次）', async () => {
  renderSync()
  /*
   * 未登录时**会**调一次 `cancelAll()`，这是有意的：App 冷启动时登录态可能已经过期，
   * 而系统里可能还留着上一次会话排的提醒（句子里带着菜名与人数）。撤一次是幂等的。
   */
  await waitFor(() => expect(spies.cancelAll).toHaveBeenCalledTimes(1))
  expect(spies.syncScheduled).not.toHaveBeenCalled()
})

it('登录后要一次权限并同步一次排程', async () => {
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
  renderSync()
  // `undefined` 表示"这一趟只要权限、先别排"（启动时那条）
  await waitFor(() => expect(spies.syncScheduled).toHaveBeenCalledWith(undefined))
})

it('从没问过权限时自动问一次（"默认开着、不用设置"）', async () => {
  spies.syncScheduled.mockResolvedValueOnce('prompt')
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
  renderSync()
  await waitFor(() => expect(spies.requestPermission).toHaveBeenCalledTimes(1))
})

it('**退出登录要把已排的提醒撤干净**（那些句子里带着这家今天吃什么）', async () => {
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
  renderSync()
  await waitFor(() => expect(spies.syncScheduled).toHaveBeenCalled())
  spies.cancelAll.mockClear()

  // 退出登录 → `enabled` 由 true 变 false
  useAuth.getState().clear()
  await waitFor(() => expect(spies.cancelAll).toHaveBeenCalled())

  /*
   * 这条断言的意义在于**它必须挂在根层才成立**：同一个组件如果被放在
   * `TabLayout` 里，退出登录会把它连根卸载，这个 effect 不会重跑，
   * `cancelAll` 也就不会被调用（那是本项目真实踩过的一回）。
   */
})
