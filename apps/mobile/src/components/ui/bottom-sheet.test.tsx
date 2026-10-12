// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import BottomSheet, { type BottomSheetHandle } from './BottomSheet'

/**
 * 抽屉的动效契约（用户 2026-10-12：「底部 ai 对话出来时要加个滑动出来，不要这种生硬的」）。
 *
 * 这里盯的是**两件靠"看着对"绝对验不出来的事**：
 * ① 出现时真的在屏幕上滑动，而不是直接到位。jsdom 量不了像素，但能读到 Popup 上的
 *    inline transform——它由 react-spring 逐帧写成，所以"起始在屏幕外、随后归位"是可断言的；
 * ② 关闭是**渐进的**：先播退场，动画结束才回调 onClose。回调早了调用方立刻卸载，
 *    退场就没了（这正是原来"啪"地消失的原因）。
 *
 * 反证：把 BottomSheet 里的 shown 换回直接传 visible，①②③ 都会红（见 R-0xx）。
 */

/** 读 Popup 当前的纵向位移百分比（0 = 已到位，100 = 完全在屏幕外） */
function offsetPercent(element: Element | null): number {
  const transform = (element as HTMLElement | null)?.style.transform ?? ''
  const match = /translate\(0(?:px)?,?\s*(-?[\d.]+)%\)/.exec(transform)
  return match ? Math.abs(Number(match[1])) : Number.NaN
}

function body(): Element | null {
  return document.querySelector('.adm-popup-body')
}

afterEach(cleanup)

it('出现时是从屏幕外滑上来的（挂载那一刻还没到位）', async () => {
  render(
    <BottomSheet visible title="问 AI" onClose={() => {}}>
      <p>内容</p>
    </BottomSheet>,
  )
  expect(await screen.findByText('内容')).toBeTruthy()

  // 挂载那一刻的位移必须是"还没上来"。直接到位（旧写法）时这里是 0 —— 那就是"生硬"的来源
  expect(offsetPercent(body())).toBeGreaterThan(50)

  // 随后归位：说明中间是**走**过来的（spring 逐帧写 transform），不是瞬移
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })
})

it('关闭是渐进的：先退场，动画结束才回调 onClose', async () => {
  const onClose = vi.fn()
  render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })

  fireEvent.click(document.querySelector('.adm-mask') as Element)

  // 点完那一刻：内容还在（正在退场），且**还没**回调——调用方一旦收到 onClose 就把它卸载了
  expect(screen.queryByText('内容')).not.toBeNull()
  expect(onClose).not.toHaveBeenCalled()

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 })
})

it('连点两下遮罩只回调一次（退场过程中再点不该又关一次）', async () => {
  const onClose = vi.fn()
  render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })

  const mask = document.querySelector('.adm-mask') as Element
  fireEvent.click(mask)
  fireEvent.click(mask)

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 })
})

it('调用方自己把 visible 置 false 时不再回调 onClose（否则等于关两次）', async () => {
  const onClose = vi.fn()
  const { rerender } = render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')

  // 这就是 KitchenPage 的用法：抽屉常驻，靠 visible 开合（而不是条件渲染）
  rerender(
    <BottomSheet visible={false} title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )

  await waitFor(() => expect(screen.queryByText('内容')).toBeNull(), { timeout: 3000 })
  expect(onClose).not.toHaveBeenCalled()
})

it('ref.close() 也走同一条退场路径（写入成功后自动收起的页面用它）', async () => {
  const onClose = vi.fn()
  const sheet = createRef<BottomSheetHandle>()
  render(
    <BottomSheet ref={sheet} visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')

  sheet.current?.close()
  expect(onClose).not.toHaveBeenCalled()

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 })
})
