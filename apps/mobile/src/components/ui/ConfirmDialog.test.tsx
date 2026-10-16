// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
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

/*
 * 「换页就关掉」（D-083 那一轮加的）：这一层画在 `document.body` 上，页面被缓存时它不跟着藏，
 * 不自己关就会盖在**下一张页面**上面、还继续抢系统返回键。
 *
 * 这一条**原先没有测试**，于是漏掉了更基本的一处错位（见第二条用例）——
 * 真机现象就是用户 2026-10-15 报的「做好了点击不了」：点下去弹窗一闪就没了，
 * 看起来完全像按钮坏了（在订单页上，谁进过详情再回来、"做好了 / 取消这餐 / 退菜"
 * 这一排确认框就全都不出来了）。
 */
function Harness() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  return (
    <div>
      <button type="button" onClick={() => navigate('?tab=two')}>换个筛选</button>
      <button type="button" onClick={() => setOpen(true)}>打开确认</button>
      <ConfirmDialog
        open={open}
        title="删掉这一餐的记录？"
        message="删了不能恢复。"
        confirmText="删掉这条"
        tone="danger"
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </div>
  )
}

function renderHarness() {
  return render(
    <MemoryRouter initialEntries={['/order']}>
      <Routes>
        {/* 同一个路由元素、只换查询串 = 组件实例活下来（真机上"进详情再回来 / 换筛选"就是这种情形） */}
        <Route path="/order" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  )
}

it('打开之后换页：关掉（它画在 body 上，不关会盖在下一张页面上）', async () => {
  renderHarness()
  fireEvent.click(screen.getByRole('button', { name: '打开确认' }))
  expect(screen.getByRole('dialog')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '换个筛选' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('挂载之后先换过页、再打开：**要留在那儿**（记的是打开那一刻的地址，不是挂载那一刻的）', () => {
  renderHarness()
  // 用户先在页面里走几步：真机上是"进这一餐详情、再返回"，路由 key 已经不是挂载时那个了
  fireEvent.click(screen.getByRole('button', { name: '换个筛选' }))

  fireEvent.click(screen.getByRole('button', { name: '打开确认' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('删了不能恢复。')).toBeTruthy()
})

it('层级要盖得住抽屉、又压得住提示：confirm(1030) 在 antd 弹层之上、toast 之下', () => {
  /*
   * 用户 2026-10-16：「打卡墙的删除在弹窗层级下面」——确认框原来是 `z-index: 80`，
   * 而抽屉（antd-mobile Popup）是 1000/1010：从抽屉里点「删掉这张」，确认框整个落在抽屉底下，
   * 看着就是"点了没反应 / 删除没生效"。
   *
   * jsdom 不跑层叠，所以这里量的是**样式表里写的那个数**（与 bottom-sheet.test 里
   * toast 那条同一个思路）。全站顺序在 `.toaster` 的注释里定着：
   * 页面 < 悬浮球/弹窗(1000/1010) < 确认框(1030) < 提示(1050) < 看大图(1100)。
   *
   * ⚠️ 这三个数必须**都读自样式表**、不许写死：写死的话改了一个数，测试还是绿的。
   */
  const scss = readFileSync(join(process.cwd(), 'src/components/ui/ui.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const z = (rule: string) => Number(new RegExp(`\\.${rule}\\s*\\{[^}]*?z-index:\\s*(\\d+)`).exec(scss)?.[1] ?? 0)
  const confirmZ = z('confirm-mask')
  const toasterZ = z('toaster')
  const viewerZ = z('photo-viewer')

  expect(confirmZ).toBeGreaterThan(1010) // 抽屉的面板：从抽屉里点出来的确认框必须在它上面
  expect(confirmZ).toBeLessThan(toasterZ) // 在确认框里失败时，提示要盖在它上面（D-068 那条）
  expect(toasterZ).toBeLessThan(viewerZ) // 看大图时整屏让给图
  expect(new Set([confirmZ, toasterZ, viewerZ]).size).toBe(3) // 三个数不许撞在一起（同数就看后写的，层叠会变得不可预期）
})
