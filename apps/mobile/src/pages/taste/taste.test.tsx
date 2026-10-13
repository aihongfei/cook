// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { TasteFamily } from '@/api/taste'
import { Toaster } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import TastePage from './TastePage'

/**
 * 口味与忌口页（M8 / F8-01、F8-02）。
 *
 * 这一页写下的每个词都会真的改变别处的行为（推荐过滤、点菜提醒、AI 每轮对话），
 * 所以盯住四件事：
 * ① **过敏与忌口分开**，且过敏那一块要说清"会真的排掉这些菜"——混在一起的话，
 *    用户会按"我不爱吃芹菜"的随意程度去填过敏栏；
 * ② **"还没写的人"要点名**（这是这一页最容易骗到人的地方：显示"已设置"会让人
 *    以为全家都被护上了）；
 * ③ **存下去的是他点的那几项**（payload 里带对了词——这一层错了，别处全都白搭）；
 * ④ **只能改自己那份**（页面上没有改别人的入口）。
 */

const clients: QueryClient[] = []

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TastePage />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const EMPTY = {
  userId: 'u1', nickname: '妈妈', avatar: '🍳',
  spicyLevel: null, flavors: [], diet: null, allergies: [], dislikes: [], note: null,
  filled: false, updatedAt: null,
}

function familyFixture(over: Partial<TasteFamily> = {}): TasteFamily {
  return {
    me: { ...EMPTY },
    members: [
      { ...EMPTY },
      { ...EMPTY, userId: 'u2', nickname: '爸爸', avatar: '🧔' },
    ],
    missing: ['妈妈', '爸爸'],
    ...over,
  }
}

function mockApi(data: TasteFamily = familyFixture()) {
  const get = vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/taste/family') return Promise.resolve({ data } as never)
    if (url === '/taste/options') {
      return Promise.resolve({
        data: {
          spicyLevels: ['不吃辣', '微辣', '中辣', '重辣'],
          diets: ['无偏好', '多吃素', '全素'],
          allergies: ['花生', '鸡蛋', '虾'],
          dislikes: ['香菜', '芹菜'],
          flavors: ['清淡', '少盐'],
        },
      } as never)
    }
    throw new Error(`未预期的 GET：${url}`)
  })
  const patch = vi.spyOn(apiClient, 'patch').mockImplementation(() =>
    Promise.resolve({ data: { ...EMPTY, ...(vi.mocked(apiClient.patch).mock.calls[0]?.[1] as object), filled: true } } as never))
  return { get, patch }
}

beforeEach(() => {
  localStorage.clear()
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

it('**还没写的人要点名**（不能显示成"全家都护上了"）', async () => {
  mockApi()
  renderPage()

  // 用户看到具体名字才会去催；看到"还有 2 人"通常只会想"哦"
  await waitFor(() => expect(screen.getByText(/还有 妈妈、爸爸 没写/)).toBeTruthy())
  // 而且要说清后果——不然"没写"看起来只是无关紧要的空状态
  expect(screen.getByText(/没写的人，推荐里不会替他避开任何东西/)).toBeTruthy()
})

it('过敏与忌口分开，且过敏那一栏明说后果（填过敏栏该慎重）', async () => {
  mockApi(familyFixture({
    me: { ...EMPTY, allergies: ['花生'], dislikes: ['香菜'], filled: true },
    missing: ['爸爸'],
  }))
  renderPage()

  expect(await screen.findByText('花生')).toBeTruthy()
  expect(screen.getByText('香菜')).toBeTruthy()
  // 两栏的说明不一样：过敏是硬判据、忌口只是提醒
  expect(screen.getByText(/推荐里会排掉含这些的菜/)).toBeTruthy()
  expect(screen.getByText(/只是提醒，不会拦着你点/)).toBeTruthy()
})

it('点一个过敏词再存下来：payload 里带的是那个词', async () => {
  const { patch } = mockApi()
  renderPage()
  await waitFor(() => expect(screen.getByRole('button', { name: '开始写' })).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: '开始写' }))
  // 建议词点一下就填（不用手打——手打容易出"香莱"这种错词，而错词会让判据悄悄失效）
  fireEvent.click(await screen.findByRole('button', { name: '花生' }))
  fireEvent.click(screen.getByRole('button', { name: '不吃辣' }))
  fireEvent.click(screen.getByRole('button', { name: '存下来' }))

  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(patch.mock.calls[0][0]).toBe('/taste')
  expect(patch.mock.calls[0][1]).toMatchObject({ allergies: ['花生'], spicyLevel: 0 })
})

it('不常见的词能自己写（建议词里没有的，如折耳根）', async () => {
  const { patch } = mockApi()
  renderPage()
  await waitFor(() => expect(screen.getByRole('button', { name: '开始写' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '开始写' }))

  // 过敏那一块的"自己写…"（两块都有这个按钮，取第一块）
  fireEvent.click((await screen.findAllByRole('button', { name: '自己写…' }))[0])
  const input = screen.getByPlaceholderText('打一个词，如：折耳根')
  fireEvent.change(input, { target: { value: '折耳根' } })
  fireEvent.click(screen.getByRole('button', { name: '加上' }))

  fireEvent.click(screen.getByRole('button', { name: '存下来' }))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(patch.mock.calls[0][1]).toMatchObject({ allergies: ['折耳根'] })
})

it('再点一次那个词 = 取消选择（不用去删一个看不见的东西）', async () => {
  const { patch } = mockApi(familyFixture({
    me: { ...EMPTY, allergies: ['花生'], filled: true },
    missing: ['爸爸'],
  }))
  renderPage()
  await waitFor(() => expect(screen.getByRole('button', { name: '改一改' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '改一改' }))

  // 已经选中的"花生"再点一下 → 取消
  fireEvent.click(screen.getByRole('button', { name: '花生' }))
  fireEvent.click(screen.getByRole('button', { name: '存下来' }))

  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(patch.mock.calls[0][1]).toMatchObject({ allergies: [] })
})

it('荤素明说"不会把肉菜藏起来"（免得用户以为设了它肉菜就看不见）', async () => {
  mockApi()
  renderPage()
  await waitFor(() => expect(screen.getByRole('button', { name: '开始写' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '开始写' }))

  expect(await screen.findByText(/只影响推荐倾向，不会把肉菜藏起来/)).toBeTruthy()
})

it('全家那块只读：没有改别人的入口（谁的档案谁能改）', async () => {
  mockApi(familyFixture({
    me: { ...EMPTY, allergies: ['花生'], filled: true },
    members: [
      { ...EMPTY, allergies: ['花生'], filled: true },
      { ...EMPTY, userId: 'u2', nickname: '爸爸', avatar: '🧔' },
    ],
    missing: ['爸爸'],
  }))
  renderPage()

  expect(await screen.findByText('爸爸')).toBeTruthy()
  // 爸爸那一行只有"还没写"，没有任何能点进去改他的东西
  expect(screen.getByText('还没写')).toBeTruthy()
  expect(screen.getByText(/只能改自己那一份/)).toBeTruthy()
})

it('还没写过时明说"填了会怎样"，不是一片空白', async () => {
  mockApi()
  renderPage()
  await waitFor(() => expect(screen.getByText(/还没写过。填了之后/)).toBeTruthy())
})

/*
 * 「改一改」是**抽屉弹上来的**（2026-10-13 用户：「改一改不要在下面，使用弹窗」）。
 *
 * 改前它是挂在页尾的一段（`.taste-editor`）：点「改一改」时它在**首屏之外**
 * （实测 top≈803，可视区 768）——屏幕上没有任何变化，用户以为"这块没法点击"。
 * 所以这里钉住它现在确实是个弹层（`.adm-popup` = BottomSheet 的容器）。
 *
 * ⚠️ 断言用类名不用 `role="dialog"`：BottomSheet 包的是 antd-mobile 的 Popup，
 * 它**不带**对话框语义（本项目所有抽屉都是这样，FridgeItemSheet 的测试同样按类名断言）。
 * 完整弹层语义要改共享的 BottomSheet，不在这一刀的范围里。
 */
it('「改一改」弹出抽屉（不是页面下面铺开一段），标题说清在改什么', async () => {
  mockApi()
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '开始写' }))

  await waitFor(() => expect(document.querySelector('.adm-popup')).toBeTruthy())
  // 编辑内容在弹层里（不是页面流里另外挂一段）
  const sheet = document.querySelector('.adm-popup') as HTMLElement
  expect(sheet.querySelector('.sheet__title')?.textContent).toBe('写口味与忌口')
  expect(sheet.querySelector('.taste-editor__chips')).toBeTruthy()
  expect(sheet.querySelector('.taste-editor__save')?.textContent).toBe('存下来')
  // 页面流里**没有**那段编辑内容了（否则就是"弹窗 + 下面还铺一段"）
  expect(document.querySelector('.page .taste-editor')).toBeNull()
})

it('写过的人点进来时抽屉标题是「改一改」（与页面上那颗按钮同一件事）', async () => {
  mockApi(familyFixture({
    me: { ...EMPTY, allergies: ['花生'], filled: true },
    missing: [],
  }))
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '改一改' }))

  await waitFor(() => expect(document.querySelector('.adm-popup')).toBeTruthy())
  const sheet = document.querySelector('.adm-popup') as HTMLElement
  expect(sheet.querySelector('.sheet__title')?.textContent).toBe('改一改')
  // 已选的词要带着选中态进来（不然用户以为没存上）
  const peanut = Array.from(sheet.querySelectorAll('.taste-chip')).find((n) => n.textContent === '花生')
  expect(peanut?.className).toContain('is-active')
})

it('「先不改」收起抽屉但不发请求（点选是探索，不是每次都在改全家的推荐）', async () => {
  const { patch } = mockApi()
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '开始写' }))
  await waitFor(() => expect(document.querySelector('.adm-popup')).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: '先不改' }))

  await waitFor(() => expect(document.querySelector('.adm-popup')).toBeNull())
  expect(patch).not.toHaveBeenCalled()
})
