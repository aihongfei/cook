// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuth } from '@/stores/auth'
import { PatrolSync } from './patrol-sync'

/**
 * 后台巡查的接线层（M10 交付三）。规则在后端（`patrol.rules.test.ts`）、
 * 本地存储的规矩在 `api/patrol.test.ts`，**这里只盯"什么时候送配置、送的是什么"**：
 *
 * ① 登录后领一枚令牌并交给那段后台代码；
 * ② **退出登录要送一份"没有令牌"的**——不送的话那段代码手里还攥着旧令牌，
 *    退出之后仍然每 15 分钟取到"这家有什么提醒"（交付二在同类问题（清理逻辑被卸载）
 *    上踩过一次，所以这一条用 mock 断言钉住）；
 * ③ 浏览器里整套空转（不装到手机上时不该有任何动作）。
 */

const spies = vi.hoisted(() => ({
  fetchPatrolToken: vi.fn(async () => 'patrol-token-abc'),
  revokePatrolToken: vi.fn(async () => undefined),
  dispatchEvent: vi.fn(async (_options: Record<string, unknown>) => undefined),
  isNative: vi.fn(() => true),
}))

vi.mock('@/api/patrol', async () => {
  const actual = await vi.importActual<typeof import('@/api/patrol')>('@/api/patrol')
  return {
    ...actual,
    fetchPatrolToken: spies.fetchPatrolToken,
    revokePatrolToken: spies.revokePatrolToken,
  }
})

vi.mock('@capacitor/core', async () => {
  const actual = await vi.importActual<typeof import('@capacitor/core')>('@capacitor/core')
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: spies.isNative } }
})

vi.mock('@capacitor/background-runner', () => ({
  BackgroundRunner: { dispatchEvent: spies.dispatchEvent },
}))

const ME = { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: '' }

function renderSync() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PatrolSync />
    </QueryClientProvider>,
  )
}

type PushedConfig = { token: string | null; userId: string | null; apiBase: string }

/** 最后一次推给那段后台代码的配置（拿不到就 null） */
function lastConfig(): PushedConfig | null {
  const calls = spies.dispatchEvent.mock.calls
  if (calls.length === 0) return null
  const details = calls[calls.length - 1][0].details as { config?: PushedConfig }
  return details?.config ?? null
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
  Object.values(spies).forEach((spy) => spy.mockClear())
  spies.isNative.mockReturnValue(true)
  // Vitest 里 `import.meta.env.VITE_API_BASE_URL` 没配，默认是 undefined；
  // 这一条用例要验的是"送了什么"，所以用一个明确的地址
  vi.stubEnv('VITE_API_BASE_URL', 'http://127.0.0.1:3000/api')
})

afterEach(() => {
  vi.unstubAllEnvs()
  cleanup()
})

it('登录后领一枚令牌，并连**后端地址与账号**一起交给那段后台代码', async () => {
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
  renderSync()

  await waitFor(() => expect(spies.fetchPatrolToken).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(lastConfig()?.token).toBe('patrol-token-abc'))
  // 地址与账号都得进去：那段代码读不到 import.meta.env，也不知道现在是谁登录着
  expect(lastConfig()?.apiBase).toBe('http://127.0.0.1:3000/api')
  expect(lastConfig()?.userId).toBe('u1')
})

it('**退出登录要送一份"没有令牌"的**（否则那段代码还攥着旧令牌继续取）', async () => {
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
  renderSync()
  await waitFor(() => expect(lastConfig()?.token).toBe('patrol-token-abc'))

  useAuth.getState().clear()
  await waitFor(() => expect(lastConfig()?.token).toBeNull())
  expect(lastConfig()?.userId).toBeNull()
})

it('没登录时不领令牌（也不白弹一次插件的调用）', async () => {
  renderSync()
  await waitFor(() => expect(lastConfig()?.token).toBeNull())
  expect(spies.fetchPatrolToken).not.toHaveBeenCalled()
})

it('浏览器里整套空转（不装到手机上时"后台被唤起"这件事不存在）', async () => {
  spies.isNative.mockReturnValue(false)
  useAuth.getState().setSession({ token: 't', refreshToken: 'r', user: ME })
  renderSync()

  await waitFor(() => expect(spies.fetchPatrolToken).toHaveBeenCalled())
  // 领到了令牌，但**不推给插件**：浏览器里没有 runner 可推
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(spies.dispatchEvent).not.toHaveBeenCalled()
})
