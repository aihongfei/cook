// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'

// 共用确认弹窗：它把关的是"不可逆或影响别人"的操作，所以行为口径要稳：
// 居中模态、取消优先、Esc 与点遮罩都算取消、进行中不许再点。

afterEach(cleanup)

it('打开时是模态框：居中、遮罩隔离、语义正确', () => {
  render(
    <ConfirmDialog
      open
      title="移出成员"
      message="把小满移出家庭？"
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )

  const dialog = screen.getByRole('dialog')
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(dialog.getAttribute('aria-labelledby')).toBe('confirm-title')
  expect(dialog.getAttribute('aria-describedby')).toBe('confirm-message')
  expect(screen.getByText('移出成员')).toBeTruthy()
  expect(screen.getByText('把小满移出家庭？')).toBeTruthy()
  // 遮罩层在：点它才算取消，点卡片本身不算
  expect(document.querySelector('.confirm-mask')).toBeTruthy()
})

it('关闭时不渲染任何东西（不占位、不挡点击）', () => {
  const { container } = render(
    <ConfirmDialog
      open={false}
      title="移出成员"
      message="…"
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )
  expect(container.querySelector('.confirm-mask')).toBeNull()
  expect(document.querySelector('.confirm-mask')).toBeNull()
})

it('确认与取消各自触发对应回调', () => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ConfirmDialog
      open
      title="解散家庭"
      message="解散后不能恢复"
      confirmText="解散"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '解散' }))
  expect(onConfirm).toHaveBeenCalledTimes(1)
  expect(onCancel).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(onCancel).toHaveBeenCalledTimes(1)
})

it('点遮罩算取消，点卡片本身不算', () => {
  const onCancel = vi.fn()
  render(
    <ConfirmDialog
      open
      title="退出家庭"
      message="确定吗"
      onConfirm={() => {}}
      onCancel={onCancel}
    />,
  )

  fireEvent.click(screen.getByRole('dialog'))
  expect(onCancel).not.toHaveBeenCalled()

  fireEvent.click(document.querySelector('.confirm-mask') as Element)
  expect(onCancel).toHaveBeenCalledTimes(1)
})

it('按 Esc 取消', () => {
  const onCancel = vi.fn()
  render(
    <ConfirmDialog
      open
      title="退出家庭"
      message="确定吗"
      onConfirm={() => {}}
      onCancel={onCancel}
    />,
  )

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onCancel).toHaveBeenCalledTimes(1)
})

it('危险操作的确认键用砖红，普通确认用品牌色', () => {
  const { unmount } = render(
    <ConfirmDialog
      open
      tone="danger"
      title="移出"
      message="…"
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )
  expect(document.querySelector('.confirm__btn--danger')).toBeTruthy()
  unmount()

  render(<ConfirmDialog open title="确定" message="…" onConfirm={() => {}} onCancel={() => {}} />)
  expect(document.querySelector('.confirm__btn--danger')).toBeNull()
})

it('进行中两个键都禁用：避免重复提交，也避免中途取消留下半执行的状态', () => {
  render(
    <ConfirmDialog
      open
      pending
      title="移出"
      message="…"
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )

  const buttons = screen.getAllByRole('button')
  expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
  expect(screen.getByRole('button', { name: '处理中…' })).toBeTruthy()
})

it('打开时锁住背景滚动，关闭后恢复', async () => {
  const { unmount } = render(
    <ConfirmDialog open title="移出" message="…" onConfirm={() => {}} onCancel={() => {}} />,
  )
  expect(document.body.style.overflow).toBe('hidden')

  unmount()
  await waitFor(() => expect(document.body.style.overflow).toBe(''))
})
