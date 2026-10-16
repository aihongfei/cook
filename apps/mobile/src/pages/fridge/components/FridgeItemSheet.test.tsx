// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { FridgeItem } from '@/api/fridge'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import { ALL_PRESETS } from '../ingredients'
import FridgeItemSheet from './FridgeItemSheet'

// 记一样食材的抽屉（M6 / F6-03 手动录入）。用户 2026-10-13 的要求原话：
// 「那些配料添加的时候，要有一些内置的可以自己选的，然后还需要图片展示」。
// 所以这里盯住三件事：
// ① **内置食材点一下就进**（48 样、带图），而且填好名字/存放区/常见数量——
//    填完**不提交**：数量与保质期还想改的人得有个地方改；
// ② **图和名字要对得上**（错图比没有图更糟：用户会以为自己记错了那个东西）；
// ③ 保质期快捷按钮算的是**今天往后推**，且**不默认填**——
//    替用户猜一个到期日，他会以为那盒奶真的那天坏。

const clients: QueryClient[] = []

function item(over: Partial<FridgeItem> = {}): FridgeItem {
  return {
    id: 'i1',
    name: '牛奶',
    amount: '一盒',
    zone: '冷藏',
    expiresOn: null,
    expiryLabel: null,
    attention: false,
    note: null,
    addedBy: '妈妈',
    addedAt: '2026-10-13T01:00:00.000Z',
    addedLabel: '刚刚',
    ...over,
  }
}

function renderSheet({ item: editing, onClose = vi.fn() }: { item?: FridgeItem; onClose?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <FridgeItemSheet visible item={editing} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { view, onClose }
}

/** 收尾要等退场动画（见 BottomSheet 的 ⚠️）：不是点完立刻回调 onClose */
function ok(data: unknown) {
  return vi.spyOn(apiClient, 'post').mockResolvedValue({ data } as never)
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('内置食材都带图，成组摆出来（图与名字一一对应）', async () => {
  vi.spyOn(apiClient, 'post')
  renderSheet()

  // 按组名确认分类在（用户要"自己选的"，分组才找得到）
  expect(await screen.findByText('蛋奶豆')).toBeTruthy()
  for (const group of ['蔬菜', '肉蛋水产', '主食', '调味', '水果']) {
    expect(screen.getByText(group)).toBeTruthy()
  }
  const buttons = document.querySelectorAll('.fridge-sheet__preset')
  expect(buttons).toHaveLength(ALL_PRESETS.length)
  // 每个预设的图正好是它自己的那张（不是同一张图铺满）
  for (const preset of ALL_PRESETS) {
    const button = Array.from(buttons).find((node) => node.textContent === preset.name)
    expect(button, `没找到预设「${preset.name}」`).toBeTruthy()
    expect(button?.querySelector('img')?.getAttribute('src')).toBe(`/img/ingredients/${preset.id}.png`)
  }
})

it('点一个内置食材：名字、存放区、常见数量都填好，但**不直接提交**', async () => {
  const post = vi.spyOn(apiClient, 'post')
  renderSheet()

  const egg = await screen.findByRole('button', { name: /鸡蛋/ })
  fireEvent.click(egg)

  expect((screen.getByPlaceholderText('如：鸡蛋') as HTMLInputElement).value).toBe('鸡蛋')
  expect((screen.getByPlaceholderText('如：一盒、半颗、约 500g') as HTMLInputElement).value).toBe('一盒')
  expect(screen.getByRole('button', { name: '冷藏' }).getAttribute('aria-pressed')).toBe('true')
  // 关键：只是填好，还没发请求（用户还能改数量/保质期）
  expect(post).not.toHaveBeenCalled()
  // 名字旁边要出图：一眼确认"记的是我以为的那个东西"
  expect(document.querySelector('.fridge-sheet__name-pic')?.getAttribute('src')).toBe('/img/ingredients/egg.png')
})

it('自己打的字也认：命中别名就出图，认不出就给中性占位', async () => {
  vi.spyOn(apiClient, 'post')
  renderSheet()

  const name = await screen.findByPlaceholderText('如：鸡蛋')
  fireEvent.change(name, { target: { value: '番茄' } })
  expect(document.querySelector('.fridge-sheet__name-pic')?.getAttribute('src')).toBe('/img/ingredients/tomato.png')

  fireEvent.change(name, { target: { value: '外婆做的酱' } })
  // 认不出就不出食材图，只给一张通用盘子占位（2026-10-16 由 🍽 换成图片）
  const pic = document.querySelector('.fridge-sheet__name-pic')
  expect(pic?.tagName).toBe('SPAN')
  expect(pic?.querySelector('img')?.getAttribute('src')).toBe('/img/icons/plate.png')
})

it('搜内置食材：按名字或别名都能搜到，搜不到就说"直接写"', async () => {
  vi.spyOn(apiClient, 'post')
  renderSheet()

  const search = await screen.findByPlaceholderText('找常用食材（也可以自己在下面写）')
  // 「番茄」是「西红柿」的别名：用户心里那个词得搜得到
  fireEvent.change(search, { target: { value: '番茄' } })
  expect(document.querySelectorAll('.fridge-sheet__preset')).toHaveLength(1)
  expect(screen.getByRole('button', { name: /西红柿/ })).toBeTruthy()

  fireEvent.change(search, { target: { value: '这个东西世上没有' } })
  expect(document.querySelectorAll('.fridge-sheet__preset')).toHaveLength(0)
  expect(screen.getByText(/常用食材里没有「这个东西世上没有」/)).toBeTruthy()
})

it('什么都不填就点"记进冰箱"是不可能的（名字是唯一必填）', async () => {
  const post = vi.spyOn(apiClient, 'post')
  renderSheet()

  const submit = (await screen.findByRole('button', { name: '记进冰箱' })) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  fireEvent.click(submit)
  expect(post).not.toHaveBeenCalled()
})

it('保质期快捷按钮按"今天往后推"算，而且**默认不填**（不替用户猜哪天坏）', async () => {
  // 只假 Date（见 R-31）：假 timers 会把 rAF 也停掉，抽屉的入场动画就不播了
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-13T09:00:00+08:00'))
  vi.spyOn(apiClient, 'post')
  renderSheet()

  const date = async () => {
    await screen.findByPlaceholderText('如：鸡蛋') // 等抽屉内容挂上（入场动画那一帧之后）
    return document.querySelector('.fridge-sheet__input--date') as HTMLInputElement
  }
  expect((await date()).value).toBe('') // 不默认填

  fireEvent.click(screen.getByRole('button', { name: '今天' }))
  expect((document.querySelector('.fridge-sheet__input--date') as HTMLInputElement).value).toBe('2026-10-13')
  fireEvent.click(screen.getByRole('button', { name: '三天后' }))
  expect((document.querySelector('.fridge-sheet__input--date') as HTMLInputElement).value).toBe('2026-10-16')
  fireEvent.click(screen.getByRole('button', { name: '一周后' }))
  expect((document.querySelector('.fridge-sheet__input--date') as HTMLInputElement).value).toBe('2026-10-20')
  // 填错了要能清掉（清掉 = 没写，不是某个日期）
  fireEvent.click(screen.getByRole('button', { name: '清掉' }))
  expect((document.querySelector('.fridge-sheet__input--date') as HTMLInputElement).value).toBe('')
  vi.useRealTimers()
})

it('提交只发该发的字段，成了就说一句并收起抽屉', async () => {
  const post = ok({ scope: 'family', zones: [], summary: { total: 1, attention: 0, expired: 0, withExpiry: 0 }, soon: [] })
  const { onClose } = renderSheet()

  fireEvent.change(await screen.findByPlaceholderText('如：鸡蛋'), { target: { value: '鸡蛋' } })
  fireEvent.change(screen.getByPlaceholderText('如：一盒、半颗、约 500g'), { target: { value: '一盒' } })
  fireEvent.change(screen.getByPlaceholderText('如：给奶奶买的、开口了要先吃'), { target: { value: '给奶奶买的' } })
  fireEvent.click(screen.getByRole('button', { name: '记进冰箱' }))

  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post.mock.calls[0][0]).toBe('/fridge')
  expect(post.mock.calls[0][1]).toEqual({ name: '鸡蛋', amount: '一盒', zone: '冷藏', expiresOn: '', note: '给奶奶买的' })
  expect(await screen.findByText('「鸡蛋」记进冰箱了')).toBeTruthy()
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('后端说"已经记过一条"时，那句话原样给用户（它指的是正确操作）', async () => {
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true,
    response: { status: 409, data: { message: '「鸡蛋」已经记了一条（冷藏），直接改它就行' } },
  })
  const { onClose } = renderSheet()

  fireEvent.change(await screen.findByPlaceholderText('如：鸡蛋'), { target: { value: '鸡蛋' } })
  fireEvent.click(screen.getByRole('button', { name: '记进冰箱' }))

  expect(await screen.findByText('「鸡蛋」已经记了一条（冷藏），直接改它就行')).toBeTruthy()
  /*
   * 失败不能把抽屉收掉：用户还得在这儿改（多半就是去改数量）。
   * 这里必须**等过退场兜底那 420ms**（见 BottomSheet 的 EXIT_FALLBACK_MS）再断言——
   * 立刻断言的话，就算实现真的把抽屉收了，动画也还没走完、onClose 还没回调，测试会假绿。
   */
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(onClose).not.toHaveBeenCalled()
})

it('编辑那一条：标题写清改的是谁，提交走 PATCH，还能"拿出来了"', async () => {
  const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: {} } as never)
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: {} } as never)
  const { onClose } = renderSheet({ item: item({ name: '牛奶', amount: '一盒' }) })

  expect(await screen.findByText('改「牛奶」')).toBeTruthy()
  // 编辑时不出"内置食材"那一段：这条已经存在了，找图那步没有意义
  expect(document.querySelectorAll('.fridge-sheet__preset')).toHaveLength(0)

  // 数量删空 = 真的删掉（发空串，后端归一成 null），不能变成"没改动"
  fireEvent.change(screen.getByPlaceholderText('如：一盒、半颗、约 500g'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '改好了' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(patch.mock.calls[0][0]).toBe('/fridge/i1')
  expect((patch.mock.calls[0][1] as { amount: string }).amount).toBe('')
  expect(await screen.findByText('「牛奶」改好了')).toBeTruthy()
  await waitFor(() => expect(onClose).toHaveBeenCalled())

  fireEvent.click(screen.getByRole('button', { name: '拿出来了' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('/fridge/i1'))
  expect(await screen.findByText('「牛奶」拿出来了')).toBeTruthy()
})

it('动作行两颗按钮：并排、一样高、底边齐（用户 2026-10-16「冰箱这个底部没对齐」）', () => {
  /*
   * 照片里那颗「拿出来了」比「改好了」矮一截、还悬在半空中。两个原因叠在一起：
   * ① `.recipe-button` 自带 `margin-top: 12px`（给"单独一颗按钮"留的），并排时没归零；
   * ② 两颗高度本来就不同（字号与内边距各一套：42.5 对 45.4），而行是 `align-items: center`
   *    ——矮的那颗在行里居中，底边就短了 7.5px。
   *
   * jsdom 不算布局，所以这里量的是**决定这两件事的规则**（与 bottom-sheet.test 里
   * "内容区自己滚"那条同一个思路）：高度交给行（stretch），外边距在行内归零，
   * 两颗的纵向内边距/字号是同一套。真正的像素差在浏览器里另验（见 RUNBOOK）。
   */
  const scss = readFileSync(join(process.cwd(), 'src/pages/fridge/fridge.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (name: string) => new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(scss)?.[1] ?? ''
  const actions = rule('fridge-sheet__actions')
  const drop = rule('fridge-sheet__drop')

  expect(actions).toMatch(/align-items:\s*stretch/) // 高度由这一行说了算，不许各自高矮
  // 那个 12px 必须在**行内**归零（选择器得比 `.recipe-button` 更具体，同权重会看加载顺序）
  expect(actions).toMatch(/\.recipe-button\s*\{[^}]*margin-top:\s*0/)
  // 两颗的纵向内边距与字号同为一档（`.recipe-button` 是 10px / 13px）
  expect(drop).toMatch(/padding:\s*10px\s+14px/)
  expect(drop).toMatch(/font-size:\s*13px/)
})
