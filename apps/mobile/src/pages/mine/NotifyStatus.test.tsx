// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import NotifyStatusRow from './NotifyStatus'

/**
 * 「手机提醒」那一行的现状（用户 2026-10-15 报「真机也没收到通知」之后加的）。
 *
 * 这一行存在的唯一理由是：**"没收到通知"在界面上原本完全看不出来**——
 * 是没排上、权限没给、还是本来就没有要提醒的事？所以这里要盯的不是文案好不好听，
 * 而是**四种情况各说各的话**（尤其权限被拒那一种：说错了他就永远收不到还不明原因），
 * 以及它**只读**（D-080 明确说过提醒不给开关，用户 2026-10-14：「这个是默认的，不用设置」）。
 *
 * 文案本身在 `local-notify.rules.test.ts` 里单测过了（纯函数），这里测的是**接线**：
 * `readNotifyStatus()` 读回来的东西真的摆到屏幕上、语气也跟着变。
 */

const notify = vi.hoisted(() => ({
  supported: true,
  status: {
    permission: 'granted' as 'granted' | 'denied' | 'prompt' | 'unsupported',
    pending: 2,
    next: { title: '晚餐该做饭了', at: new Date(2026, 9, 15, 18, 0) } as { title: string; at: Date } | null,
  },
}))

vi.mock('@/lib/local-notify', () => ({
  isSupported: () => notify.supported,
  readNotifyStatus: () => Promise.resolve(notify.status),
}))

const clients: QueryClient[] = []

function renderRow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <NotifyStatusRow />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  notify.supported = true
  notify.status = { permission: 'granted', pending: 2, next: { title: '晚餐该做饭了', at: new Date(2026, 9, 15, 18, 0) } }
})

it('网页里这一行不出现（没有"关掉页面还会响"这回事，就别多一句无关的话）', () => {
  notify.supported = false
  renderRow()

  expect(screen.queryByText('手机提醒')).toBeNull()
})

it('权限已开且排上了：报条数与最近一条，且**没有开关**（只读，D-080）', async () => {
  renderRow()

  expect(await screen.findByText('已排 2 条 · 最近的是 10 月 15 日 18:00「晚餐该做饭了」')).toBeTruthy()
  // 只读：整行里不该出现任何可点的东西（开关/按钮/链接）
  const row = document.querySelector('.row--status') as HTMLElement
  expect(row.querySelector('button, a, input, [role="switch"]')).toBeNull()
})

it('权限被拒：说清"发不出来"并指路系统设置，语气是警告色（说错了他就永远收不到还不明原因）', async () => {
  notify.status = { permission: 'denied', pending: 0, next: null }
  renderRow()

  const line = await screen.findByText(/系统里没允许通知/)
  expect(line.textContent).toContain('去手机设置里打开')
  expect(line.className).toContain('row__sub--warn')
})

it('权限已开但一条都没排上：说"没有要提醒的事"，**不写"0 条"**（那看着像"你没有消息"）', async () => {
  notify.status = { permission: 'granted', pending: 0, next: null }
  renderRow()

  const line = await screen.findByText(/现在没有要提醒的事/)
  expect(line.textContent).not.toContain('0 条')
  expect(line.className).not.toContain('row__sub--warn')
})

it('还没问过权限：说"还没问过"，不假装成"已开启"', async () => {
  notify.status = { permission: 'prompt', pending: 0, next: null }
  renderRow()

  expect(await screen.findByText(/系统还没问过通知权限/)).toBeTruthy()
})
