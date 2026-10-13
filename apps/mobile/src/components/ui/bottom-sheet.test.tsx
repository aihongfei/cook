/// <reference types="node" />
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/*
 * 下面三条是 2026-10-13 用户当场提的两件事（「上面直接超出屏幕了」/「有没有跟随手指拖动」）。
 *
 * jsdom 量不了像素，所以这里量的是**决定布局的那条规则**：
 * ① 面板高度封顶（`max-height`）——内容再长也不会顶出屏幕；
 * ② 外壳允许收缩（`min-height: 0`）+ 内容区自滚——这是"滚动落在内容区而不是整块面板"的要害
 *    （不写 min-height，flex 子项的最小尺寸是内容高度，照样顶出去）；
 * ③ 拖动的手势判定（阈值/方向/速度三档）——直接派发鼠标事件走一遍真实代码路径。
 *
 * 触摸事件在 jsdom 里可以构造，但**这套自动化只能产生鼠标事件**（见 RUNBOOK R-041），
 * 所以手势入口统一成"触摸与鼠标共用判定函数"：不然真机上能拖、这里永远验不了。
 */

/**
 * 派发一次拖动：从 (x, y0) 往下走 steps 步、每步 stepPx 像素（用 mouse 事件走同一套判定）。
 * 返回**每一步之后面板的像素位移**——跟手与否看这个序列。
 *
 * 用"每步之后同步读一次"而不是 MutationObserver：观察器的回调是微任务，
 * fireEvent 之后不会立刻跑，读到的会是一个空数组（第一版就是这么假绿的）。
 */
function dragDown(element: Element, y0: number, steps: number, stepPx: number): number[] {
  const frames: number[] = []
  const panel = body() as HTMLElement
  const read = () => {
    const match = /translateY\(([\d.]+)px\)/.exec(panel.style.transform)
    if (match) frames.push(Number(match[1]))
  }
  fireEvent.mouseDown(element, { clientX: 100, clientY: y0, bubbles: true })
  for (let i = 1; i <= steps; i += 1) {
    fireEvent.mouseMove(window, { clientX: 100, clientY: y0 + i * stepPx, bubbles: true })
    read()
  }
  fireEvent.mouseUp(window, { bubbles: true })
  return frames
}

it('面板高度封顶、外壳可收缩：内容再长也只在里面滚，不会顶出屏幕', async () => {
  render(
    <BottomSheet visible title="记一样食材" onClose={() => {}}>
      {/* 一段比屏幕高得多的内容：正是冰箱录入抽屉 882px / 844px 的那种情况 */}
      <div style={{ height: '1500px' }}>很长的表单</div>
    </BottomSheet>,
  )
  await screen.findByText('很长的表单')

  const panel = document.querySelector('.adm-popup-body') as HTMLElement
  expect(panel.style.maxHeight).toBe('88vh')
  // 面板得是"列方向 + 可收缩"的容器，否则里面的 flex: 1 无从谈起
  expect(panel.style.display).toBe('flex')
  expect(panel.style.flexDirection).toBe('column')

  const shell = screen.getByText('很长的表单').closest('.sheet__shell') as HTMLElement
  expect(shell).toBeTruthy()
  expect(screen.getByText('记一样食材').closest('.sheet__shell')).toBe(shell)
})

it('内容区自己滚、标题留在原地（滚动条不在整块面板上）', async () => {
  // 读样式文件：jsdom 不算布局，"滚动落在谁身上"只能从规则判定
  const scss = readFileSync(join(process.cwd(), 'src/components/ui/ui.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const shellRule = /\.sheet__shell\s*\{[^}]*\}/.exec(scss)?.[0] ?? ''
  const bodyRule = /\.sheet__body\s*\{[^}]*\}/.exec(scss)?.[0] ?? ''

  expect(shellRule).toMatch(/min-height:\s*0/)
  expect(bodyRule).toMatch(/overflow-y:\s*auto/)
  expect(bodyRule).toMatch(/min-height:\s*0/)
  // 滚到底别把滚动传给下面的页面（传出去很像"抽屉被拖歪了"）
  expect(bodyRule).toMatch(/overscroll-behavior:\s*contain/)
})

it('跟随手指下拖：拖得够远就关掉（且拖动过程中面板真的在动）', async () => {
  /*
   * 收尾那两行是用户当场报的 bug（「拖到一半松手会瞬间回到最高点再收回去」）：
   * 面板的位移有两个来源——我们的 inline 像素值、和 Popup 弹簧自己的百分比值。
   * 清掉 inline 值的那一刻，弹簧那个 **0%（完全打开）** 的值会立刻生效 →
   * 面板先跳回顶部、再被退场动画推下去。所以这里在 **onClose 被调用的那一瞬**取面板状态：
   * 必须是"已经藏起来 + 停在屏幕外"，而不可能是"没藏 + 位移被清空"。
   */
  const onClose = vi.fn()
  render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })

  const panel = body() as HTMLElement
  let atClose: { visibility: string } | null = null
  onClose.mockImplementation(() => {
    atClose = { visibility: panel.style.visibility }
  })

  const frames = dragDown(screen.getByText('内容'), 300, 16, 10) // 拖 160px

  // 跟手的证据：每一步都写过对应的位移（不是松手才跳一下），松手时停在屏幕外
  expect(frames.length).toBeGreaterThanOrEqual(10)
  expect(Math.max(...frames)).toBe(160)
  expect(panel.style.transform).toBe('translateY(100%)')

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 })
  /*
   * 到 onClose 那一刻，面板**必须还是藏着的**。
   * 不藏的话弹簧那 0%（完全打开）的值会立刻生效 = 用户看到"瞬间弹回最高点再收回去"。
   * 这里只断言"藏没藏"：这一刻 transform 归弹簧写（是百分比），不是我们的像素值。
   */
  expect(atClose).toEqual({ visibility: 'hidden' })
})

it('拖得不够远就弹回去（抽屉不关）——慢慢拖到一半也是弹回', async () => {
  const onClose = vi.fn()
  render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })

  const panel = body() as HTMLElement
  const frames = dragDown(screen.getByText('内容'), 300, 5, 10) // 只拖 50px

  // 拉到 50px 是真的跟手了，然后弹回 0（不关）
  expect(Math.max(...frames)).toBe(50)
  expect(panel.style.transform).toBe('translateY(0px)')
  await waitFor(() => expect(panel.style.transform).not.toContain('translateY'), { timeout: 2000 })
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.queryByText('内容')).not.toBeNull()
})

it('三件"不抢"：按下不动（手抖/点按钮）、横划、上划，都不该把面板带歪', async () => {
  const onClose = vi.fn()
  render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <p>内容</p>
    </BottomSheet>,
  )
  await screen.findByText('内容')
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })
  const panel = body() as HTMLElement
  const content = screen.getByText('内容')
  /** 拖动"没接"的判据：一共写过几次像素位移（0 次 = 完全没被带歪） */
  let written = 0
  const step = () => {
    if (/translateY\([\d.]+px\)/.test(panel.style.transform)) written += 1
  }

  // ① 点击时的抖动：按下 → 移动 3px（小于起手阈值 8px）→ 抬手
  fireEvent.mouseDown(content, { clientX: 100, clientY: 300, bubbles: true })
  fireEvent.mouseMove(window, { clientX: 100, clientY: 303, bubbles: true })
  step()
  fireEvent.mouseUp(window, { bubbles: true })

  // ② 横划（那是给上层的手势）
  fireEvent.mouseDown(content, { clientX: 100, clientY: 300, bubbles: true })
  fireEvent.mouseMove(window, { clientX: 180, clientY: 310, bubbles: true })
  step()
  fireEvent.mouseMove(window, { clientX: 260, clientY: 320, bubbles: true })
  step()
  fireEvent.mouseUp(window, { bubbles: true })

  // ③ 上划（用户是想看下面：那是滚动）
  fireEvent.mouseDown(content, { clientX: 100, clientY: 400, bubbles: true })
  fireEvent.mouseMove(window, { clientX: 100, clientY: 320, bubbles: true })
  step()
  fireEvent.mouseUp(window, { bubbles: true })

  expect(written).toBe(0)
  expect(onClose).not.toHaveBeenCalled()
})

it('输入框里按下并拖动是在选文字，不是要关抽屉', async () => {
  const onClose = vi.fn()
  render(
    <BottomSheet visible title="问 AI" onClose={onClose}>
      <input placeholder="如：一盒" defaultValue="一盒" />
    </BottomSheet>,
  )
  await screen.findByPlaceholderText('如：一盒')
  await waitFor(() => expect(offsetPercent(body())).toBeLessThan(1), { timeout: 3000 })

  const frames = dragDown(screen.getByPlaceholderText('如：一盒'), 300, 16, 10)

  expect(frames).toEqual([])
  expect(onClose).not.toHaveBeenCalled()
})
