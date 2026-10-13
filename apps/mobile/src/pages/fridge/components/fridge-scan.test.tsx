// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { FridgeScanDraft } from '@/api/ai'
import * as checkins from '@/api/checkins'
import { useAuth } from '@/stores/auth'
import { Toaster } from '@/components/ui/toast'
import FridgeScanSheet from './FridgeScanSheet'

/**
 * 冰箱拍照识别（F16-04；用户 2026-10-13：「冰箱ocr识别食材那块也可以开始干了」）。
 *
 * 这功能的护栏只有一条，但它是全部：**识别结果永远是草稿**，用户逐项看过、点下去才入库。
 * 所以这一组盯的是四件事：
 * ① **认完不写库**——只把清单摆出来让用户改，一个写请求都不该发生（照片一定会认错，
 *    而冰箱是「今日先吃」的输入，错一条会让人照着坏东西做菜）；
 * ② **改得动**——名字/数量/区都能就地改，不想要的能划掉（认错的那一条要能当场纠正）；
 * ③ **"猜的"要标出来**——存放区是模型推断的时候，不标的话猜错的区会安安静静待在那儿；
 * ④ **入库走用户自己那条 `POST /fridge`**（与手填同一个口），且**一件一件加**：
 *    某一条撞名失败时只留那一条，其余照常进去（整体失败会让用户重拍，而大部分是对的）。
 */

const clients: QueryClient[] = []

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <FridgeScanSheet visible onClose={() => {}} />
      <Toaster />
    </QueryClientProvider>,
  )
}

const PHOTO = 'data:image/jpeg;base64,QUJD'

/** 上传 + 识别两步的桩：`items` 就是"模型认出来的"。默认两条，其中一条的区是猜的 */
function mockScan({
  items = [
    { name: '鸡蛋', amount: '10 个', zone: '冷藏', zoneGuessed: false, note: null },
    { name: '薯片', amount: null, zone: '常温', zoneGuessed: true, note: null },
  ],
  summary = '看着像是一格冷藏 + 一包零食。',
  /** 连入库那一口也桩上（只关心"发出去的是什么"的用例用） */
  writes = false,
  /*
   * 显式标注参数类型：默认值那两条把 `note` 推成了 `null`，于是"模型给了备注"那些
   * 用例传进去的字符串会被判成类型错误（写测试时才发现的——那正是"默认值当类型"的坑）。
   * 用 `FridgeScanDraft[]` 才是这一路的真实契约。
   */
}: { items?: FridgeScanDraft[]; summary?: string; writes?: boolean } = {}) {
  const post = vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/ai/attachments') return Promise.resolve({ data: { id: 'att-1', mimeType: 'image/jpeg' } } as never)
    if (url === '/ai/scan-fridge') return Promise.resolve({ data: { items, summary } } as never)
    if (writes && url === '/fridge') return Promise.resolve({ data: { zones: [], summary: {}, soon: [] } } as never)
    throw new Error(`未预期的 POST：${url}`)
  })
  return { post }
}

/** 选一张图（相册那个控件；与「拍一张」只差 capture，回调同一条） */
function pickPhoto() {
  const input = document.getElementById('fridge-scan-album') as HTMLInputElement
  const file = new File(['x'], 'fridge.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
  // 缩图在 jsdom 里跑不动（没有 canvas 解码），直接给"缩好的"结果
  vi.spyOn(checkins, 'shrinkImage').mockResolvedValue(PHOTO)
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('两个来源入口：拍一张（带 capture 开相机）/ 从相册选', () => {
  mockScan()
  renderSheet()

  const camera = document.getElementById('fridge-scan-camera') as HTMLInputElement
  const album = document.getElementById('fridge-scan-album') as HTMLInputElement
  expect(camera.getAttribute('capture')).toBe('environment')
  expect(album.getAttribute('capture')).toBeNull()

  expect(screen.getByText('拍一张').getAttribute('for')).toBe('fridge-scan-camera')
  expect(screen.getByText('从相册选').getAttribute('for')).toBe('fridge-scan-album')
})

it('认完**不写库**：清单摆出来让用户改，一个写请求都没有', async () => {
  mockScan()
  const post = apiClient.post as unknown as { mock: { calls: [string][] } }
  renderSheet()
  pickPhoto()

  await waitFor(() => expect(screen.getByText('看着像是一格冷藏 + 一包零食。')).toBeTruthy())
  // 两条都摆出来了
  expect((screen.getByLabelText('第 1 样的名字') as HTMLInputElement).value).toBe('鸡蛋')
  expect((screen.getByLabelText('第 2 样的名字') as HTMLInputElement).value).toBe('薯片')

  // 这一步的全部意义：**还没有任何东西进冰箱**
  const writes = post.mock.calls.map((call) => call[0]).filter((url) => url === '/fridge')
  expect(writes).toHaveLength(0)
  // 按钮上也写清了会有几条进去（用户按下之前就知道会发生什么）
  expect(screen.getByRole('button', { name: '都记进去（2 样）' })).toBeTruthy()
})

it('"猜的"要标出来、改了区就撤掉标记（猜错的区不能安安静静待在那儿）', async () => {
  mockScan()
  renderSheet()
  pickPhoto()

  await waitFor(() => expect(screen.getByText('猜的')).toBeTruthy())
  // 只有那一条是猜的
  expect(document.querySelectorAll('.fridge-scan__guessed')).toHaveLength(1)

  fireEvent.change(screen.getByLabelText('第 2 样的存放区'), { target: { value: '冷冻' } })

  await waitFor(() => expect(document.querySelectorAll('.fridge-scan__guessed')).toHaveLength(0))
})

it('改得动：名字/数量就地改，整条能划掉（第 2 条不要了）', async () => {
  mockScan()
  renderSheet()
  pickPhoto()
  await waitFor(() => expect(screen.getByLabelText('第 1 样的名字')).toBeTruthy())

  fireEvent.change(screen.getByLabelText('第 1 样的名字'), { target: { value: '土鸡蛋' } })
  fireEvent.change(screen.getByLabelText('第 1 样的数量'), { target: { value: '12 个' } })
  fireEvent.click(screen.getByLabelText('不要第 2 样'))

  expect((screen.getByLabelText('第 1 样的名字') as HTMLInputElement).value).toBe('土鸡蛋')
  expect(screen.queryByDisplayValue('薯片')).toBeNull()
  // 条数跟着变（按钮上的数字与清单一致，用户按之前就知道会进去几条）
  expect(screen.getByRole('button', { name: '都记进去（1 样）' })).toBeTruthy()
})

it('点「都记进去」才真的入库：一件一件加，且发的是改过之后的内容', async () => {
  mockScan({
    items: [
      { name: '鸡蛋', amount: '10 个', zone: '冷藏', zoneGuessed: false, note: null },
      { name: '牛奶', amount: null, zone: '冷藏', zoneGuessed: false, note: null },
    ],
  })
  const post = vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/ai/attachments') return Promise.resolve({ data: { id: 'att-1', mimeType: 'image/jpeg' } } as never)
    if (url === '/ai/scan-fridge') {
      return Promise.resolve({
        data: {
          items: [
            { name: '鸡蛋', amount: '10 个', zone: '冷藏', zoneGuessed: false, note: null },
            { name: '牛奶', amount: null, zone: '冷藏', zoneGuessed: false, note: null },
          ],
          summary: '',
        },
      } as never)
    }
    if (url === '/fridge') return Promise.resolve({ data: { zones: [], summary: {}, soon: [] } } as never)
    throw new Error(`未预期的 POST：${url}`)
  })
  renderSheet()
  pickPhoto()
  await waitFor(() => expect(screen.getByLabelText('第 1 样的名字')).toBeTruthy())

  fireEvent.change(screen.getByLabelText('第 1 样的数量'), { target: { value: '12 个' } })
  fireEvent.click(screen.getByRole('button', { name: '都记进去（2 样）' }))

  await waitFor(() => {
    const writes = post.mock.calls.filter((call) => call[0] === '/fridge')
    expect(writes).toHaveLength(2)
  })
  // 走的是用户自己那条接口（与手填同一个口：校验、同名 409、共享权限全部继承）
  const writes = post.mock.calls.filter((call) => call[0] === '/fridge').map((call) => call[1])
  expect(writes[0]).toEqual({ name: '鸡蛋', amount: '12 个', zone: '冷藏', note: undefined })
  expect(writes[1]).toEqual({ name: '牛奶', amount: undefined, zone: '冷藏', note: undefined })
})

it('**一条撞名不该拖垮整批**：成功那几条照常进去，只留失败的那条让用户改', async () => {
  /*
   * 后端 `POST /fridge` 对"同名同区"回 409。认出来的名字撞上库里已有的很正常
   * （昨天买的那袋还在冰箱里）。这时候整体失败是最糟的处理——大部分行都是对的，
   * 让用户重拍一张等于把对的也丢掉了。
   */
  vi.spyOn(apiClient, 'post').mockImplementation((url: string, body?: unknown) => {
    if (url === '/ai/attachments') return Promise.resolve({ data: { id: 'att-1', mimeType: 'image/jpeg' } } as never)
    if (url === '/ai/scan-fridge') {
      return Promise.resolve({
        data: {
          items: [
            { name: '鸡蛋', amount: null, zone: '冷藏', zoneGuessed: false, note: null },
            { name: '酱油', amount: null, zone: '保鲜', zoneGuessed: false, note: null },
          ],
          summary: '',
        },
      } as never)
    }
    if (url === '/fridge') {
      const name = (body as { name?: string } | undefined)?.name
      if (name === '酱油') {
        return Promise.reject({
          isAxiosError: true,
          response: { status: 409, data: { message: '保鲜区里已经有一瓶酱油了' } },
        })
      }
      return Promise.resolve({ data: { zones: [], summary: {}, soon: [] } } as never)
    }
    throw new Error(`未预期的 POST：${url}`)
  })
  renderSheet()
  pickPhoto()
  await waitFor(() => expect(screen.getByLabelText('第 1 样的名字')).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: '都记进去（2 样）' }))

  // 失败那一条留在清单里，且说清是哪一条、为什么（用户要能一眼找到它去改）
  await waitFor(() => expect(screen.getByText('「酱油」没记成：保鲜区里已经有一瓶酱油了')).toBeTruthy())
  expect(screen.getByDisplayValue('酱油')).toBeTruthy()
  // 成功那条从待提交清单里消失（不能让他重复提交）
  expect(screen.queryByDisplayValue('鸡蛋')).toBeNull()
  // 面板没关：改个名字再点一次就行，不必从头再来
  expect(screen.getByRole('button', { name: '都记进去（1 样）' })).toBeTruthy()
})

it('一条都没认出来：明说"没认出食材"并给下一步（不是假装成功，也不是一句报错）', async () => {
  /*
   * 模型按提示词"看不清的一律不写"，所以空清单是**正常结果**而不是错误。
   * 但要说清下一步（换张清楚的 / 手动记一样），否则用户以为功能坏了。
   */
  mockScan({ items: [], summary: '' })
  renderSheet()
  pickPhoto()

  await waitFor(() => expect(screen.getByText(/这张照片里没认出食材/)).toBeTruthy())
  // 没有任何可提交的东西：按钮不该出现（点一颗"都记进去（0 样）"是荒唐的）
  expect(screen.queryByRole('button', { name: /都记进去/ })).toBeNull()
  expect(screen.getByRole('button', { name: '重拍一张' })).toBeTruthy()
})

it('识别失败（接口报错）：如实转达，并退回"选图"那一步（不是把面板卡在转圈里）', async () => {
  vi.spyOn(apiClient, 'post').mockImplementation((url: string) => {
    if (url === '/ai/attachments') return Promise.resolve({ data: { id: 'att-1', mimeType: 'image/jpeg' } } as never)
    if (url === '/ai/scan-fridge') {
      return Promise.reject({ isAxiosError: true, response: { status: 503, data: { message: 'AI 还没配好' } } })
    }
    throw new Error(`未预期的 POST：${url}`)
  })
  renderSheet()
  pickPhoto()

  await waitFor(() => expect(screen.getByText('AI 还没配好')).toBeTruthy())
  // 回到能重新选图的那一步（不然用户只能关掉面板重开）
  expect(screen.getByText('拍一张')).toBeTruthy()
})

it('备注也摆出来能改、能看——**用户没看过的字段不该被写进库**', async () => {
  /*
   * 这是浏览器实测抓到的静默通道：模型爱把"灰色蛋托中可见六枚"这种**描述**写进备注，
   * 而审核界面原来不显示备注——于是它悄悄跟着入库了，用户根本没机会看。
   * 提示词那边也收紧了，但**界面必须看得见**才是"逐项确认"（提示词治不了每一次发挥）。
   */
  const { post } = mockScan({
    items: [{ name: '鸡蛋', amount: null, zone: '冷藏', zoneGuessed: false, note: '灰色蛋托中可见六枚' }],
    writes: true,
  })
  renderSheet()
  pickPhoto()

  const note = await screen.findByLabelText('第 1 样的备注') as HTMLInputElement
  // 模型写的备注看得见
  expect(note.value).toBe('灰色蛋托中可见六枚')

  fireEvent.change(note, { target: { value: '土鸡蛋' } })
  fireEvent.click(screen.getByRole('button', { name: '都记进去（1 样）' }))

  const writes = () => post.mock.calls.filter((call) => call[0] === '/fridge')
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(writes()[0][1]).toEqual({ name: '鸡蛋', amount: undefined, zone: '冷藏', note: '土鸡蛋' })
})

it('备注清空之后按"没写"发出去（不是把空字符串写进库）', async () => {
  const { post } = mockScan({
    items: [{ name: '小葱', amount: null, zone: '冷藏', zoneGuessed: false, note: '白色根部，绿色葱叶' }],
    writes: true,
  })
  renderSheet()
  pickPhoto()

  const note = await screen.findByLabelText('第 1 样的备注') as HTMLInputElement
  fireEvent.change(note, { target: { value: '  ' } })
  fireEvent.click(screen.getByRole('button', { name: '都记进去（1 样）' }))

  const writes = () => post.mock.calls.filter((call) => call[0] === '/fridge')
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect((writes()[0][1] as { note?: string }).note).toBeUndefined()
})
