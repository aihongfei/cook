// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Toaster, toast, useToasts } from './toast'

// 共用 toast（统一反馈）：只验证对外承诺的几条行为——成功/失败两种语气、
// 同文案不堆叠、会自动消失、可点掉。

beforeEach(() => {
  useToasts.setState({ items: [] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('成功提示显示文案并带 status 语义', async () => {
  render(<Toaster />)
  toast.success('邀请码已复制，发给家里人就行')

  const item = await screen.findByRole('status')
  expect(item.textContent).toContain('邀请码已复制，发给家里人就行')
  expect(item.className).toContain('toast--success')
})

it('失败提示用 alert 语义且是另一种语气', async () => {
  render(<Toaster />)
  toast.error('这个操作需要更高的家庭角色')

  const item = await screen.findByRole('alert')
  expect(item.textContent).toContain('这个操作需要更高的家庭角色')
  expect(item.className).toContain('toast--error')
})

it('同一条文案不重复堆叠（连点两下只提示一次）', async () => {
  render(<Toaster />)
  toast.success('已复制')
  toast.success('已复制')

  const items = await screen.findAllByText('已复制')
  expect(items).toHaveLength(1)
})

it('到时间会自己消失', async () => {
  render(<Toaster />)
  toast.success('资料已更新')
  expect(await screen.findByText('资料已更新')).toBeTruthy()

  /*
   * 真实计时器，不用假表：消失的定时器是 push 时用当时那个 setTimeout 注册的，
   * 之后再 vi.useFakeTimers() 也接管不了它，假表只会让这条断言假过。
   * 成功提示 2.2 秒后自动消失，所以给 4 秒余量。
   */
  await waitFor(() => expect(screen.queryByText('资料已更新')).toBeNull(), { timeout: 4000 })
}, 8000)

it('点一下可以立刻关掉', async () => {
  render(<Toaster />)
  toast.success('已退出家庭')

  fireEvent.click(await screen.findByRole('status'))
  await waitFor(() => expect(screen.queryByText('已退出家庭')).toBeNull())
})

it('没有提示时不占位（不挡住页面）', () => {
  const { container } = render(<Toaster />)
  expect(container.querySelector('.toaster')).toBeNull()
})
