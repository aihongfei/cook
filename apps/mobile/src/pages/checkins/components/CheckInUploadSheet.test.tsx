// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { PHOTO_MAX_EDGE, PHOTO_QUALITY, shrinkImage, type CheckInStats } from '@/api/checkins'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import CheckInUploadSheet from './CheckInUploadSheet'

// 打卡上传（M9 / F9-07、F9-08）。两个关键点：
// ① 上传前必须缩图（手机原图 3–10MB，缩到 1600px 后通常 < 500KB）；
// ② 从「已做好」的点单卡进来时要预选那一餐，即使它不在"最近 10 餐"里也要能看见。
//
// jsdom 既不解码图片也不实现 canvas（`getContext('2d')` 返回 null、`toDataURL` 会抛），
// 真实浏览器里不会被注意到的分支在测试里反而成为主路径。所以这里把三样东西换成可观察的假实现
// （FileReader / Image / canvas），这样测到的是**真正的缩图分支**，而不是碰巧的降级路径。

const clients: QueryClient[] = []

/** FileReader 读出来的"原图" */
const ORIGINAL_DATA_URL = 'data:image/png;base64,T1JJR0lOQUw='
/** canvas 编码出来的"缩过的图" */
const SHRUNK_DATA_URL = 'data:image/jpeg;base64,U0NBTEVE'

/** 记录 canvas 实际按多大尺寸画、用什么参数编码 */
let drawn: { width: number; height: number }[] = []
let encoded: { type: string; quality?: number }[] = []

function renderSheet(props: { presetMealKey?: string; onUploaded?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <CheckInUploadSheet visible onClose={() => {}} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function statsFixture(overrides: Partial<CheckInStats> = {}): CheckInStats {
  const empty = { weeks: [], from: '2026-10-01', to: '2026-10-12', totalDays: 0, totalCount: 0, streak: 0 }
  return {
    mine: empty,
    family: empty,
    mineTotal: 0,
    familyTotal: 0,
    attachableMeals: [
      { mealKey: '2026-10-12-DINNER', label: '10 / 12 · 晚餐' },
      { mealKey: '2026-10-11-LUNCH', label: '10 / 11 · 午餐' },
    ],
    ...overrides,
  }
}

function imageFile(name = 'dish.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
}

function stubFileReader(dataUrl = ORIGINAL_DATA_URL) {
  class FakeReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL() {
      setTimeout(() => {
        this.result = dataUrl
        this.onload?.()
      }, 0)
    }
  }
  vi.stubGlobal('FileReader', FakeReader as never)
}

function stubFileReaderFailure() {
  class FailingReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL() {
      setTimeout(() => this.onerror?.(), 0)
    }
  }
  vi.stubGlobal('FileReader', FailingReader as never)
}

/** 一张"解码成功"的图，默认 3000×2000（手机原图尺寸，必然要缩） */
function stubDecodableImage(width = 3000, height = 2000) {
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    width = width
    height = height
    set src(_value: string) {
      setTimeout(() => this.onload?.(), 0)
    }
  }
  vi.stubGlobal('Image', FakeImage as never)
}

/** 一张"解不开"的图（损坏文件、伪装成图片的文本） */
function stubBrokenImage() {
  class BrokenImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    width = 0
    height = 0
    set src(_value: string) {
      setTimeout(() => this.onerror?.(), 0)
    }
  }
  vi.stubGlobal('Image', BrokenImage as never)
}

/** 解码请求发出后永远不回调（jsdom 的默认行为，真实世界里的卡死） */
function stubSilentImage() {
  class SilentImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {}
  }
  vi.stubGlobal('Image', SilentImage as never)
}

function stubCanvas() {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return {
      drawImage: () => {
        drawn.push({ width: this.width, height: this.height })
      },
    }
  } as never
  HTMLCanvasElement.prototype.toDataURL = function (type?: string, quality?: number) {
    encoded.push({ type: type ?? '', quality })
    return SHRUNK_DATA_URL
  } as never
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
  drawn = []
  encoded = []
  useAuth.getState().setSession({
    token: 'test-token',
    refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
  stubFileReader()
  stubCanvas()
  stubDecodableImage()
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/checkins/stats') return Promise.resolve({ data: statsFixture() } as never)
    throw new Error(`未预期的请求：${url}`)
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('可选的餐只列「已做好」的餐（后端给的 attachableMeals）', async () => {
  renderSheet()
  expect(await screen.findByRole('option', { name: '10 / 12 · 晚餐' })).toBeTruthy()
  expect(screen.getByRole('option', { name: '不挂，就是随手打卡' })).toBeTruthy()
})

it('从点单卡进来时预选那一餐；不在最近列表里也要显示出来', async () => {
  renderSheet({ presetMealKey: '2026-10-01-DINNER' })
  const select = await screen.findByLabelText('挂到哪一餐（可以不选）') as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('2026-10-01-DINNER'))
  // 兜底选项要在，否则选择器里看不到自己被选中（"刚才那一餐"）
  expect(screen.getByRole('option', { name: '刚才那一餐' })).toBeTruthy()
})

it('还没选照片时提交按钮是禁用的（不让人点下去没反应）', async () => {
  renderSheet()
  const submit = await screen.findByRole('button', { name: '传上去' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
})

it('选图后先缩再传：提交带的是缩过的 JPEG dataURL，而不是原图', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { id: 'ck1', mealKey: null } } as never)
  renderSheet()

  const input = await screen.findByLabelText('选择照片')
  fireEvent.change(input, { target: { files: [imageFile()] } })

  const preview = await screen.findByAltText('待上传的照片预览')
  expect(preview.getAttribute('src')).toBe(SHRUNK_DATA_URL)

  // 3000×2000 缩到最长边 1600 → 1600×1067（比例保持，只缩不放）
  expect(drawn).toEqual([{ width: 1600, height: 1067 }])
  expect(encoded).toEqual([{ type: 'image/jpeg', quality: PHOTO_QUALITY }])

  fireEvent.click(screen.getByRole('button', { name: '传上去' }))
  await waitFor(() => expect(post).toHaveBeenCalled())
  const body = post.mock.calls[0][1] as { image: string; note?: string; mealKey?: string }
  expect(body.image).toBe(SHRUNK_DATA_URL)
  expect(body.image).not.toBe(ORIGINAL_DATA_URL)
  expect(body.note).toBeUndefined()
  expect(body.mealKey).toBeUndefined()
})

it('填了备注与餐次就一起传上去，并提示成功', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { id: 'ck2', mealKey: '2026-10-12-DINNER' } } as never)
  const uploaded = vi.fn()
  renderSheet({ onUploaded: uploaded })

  fireEvent.change(await screen.findByLabelText('选择照片'), { target: { files: [imageFile()] } })
  await waitFor(() => expect(screen.getByAltText('待上传的照片预览')).toBeTruthy())

  fireEvent.change(screen.getByPlaceholderText('如：给小满做的生日面'), { target: { value: '今晚的红烧排骨' } })
  fireEvent.change(screen.getByLabelText('挂到哪一餐（可以不选）'), { target: { value: '2026-10-12-DINNER' } })
  fireEvent.click(screen.getByRole('button', { name: '传上去' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/checkins', expect.objectContaining({ note: '今晚的红烧排骨', mealKey: '2026-10-12-DINNER' })),
  )
  expect(await screen.findByText('成品照已上传，家里人能看到啦')).toBeTruthy()
  expect(uploaded).toHaveBeenCalled()
})

it('后端拒绝时把话术显示出来（如不是图片、太大）', async () => {
  vi.spyOn(apiClient, 'post').mockRejectedValue({
    isAxiosError: true,
    response: { status: 400, data: { message: '这个文件不是图片（只支持 JPEG / PNG / WebP）' } },
  } as never)
  renderSheet()

  fireEvent.change(await screen.findByLabelText('选择照片'), { target: { files: [imageFile('fake.png')] } })
  await waitFor(() => expect(screen.getByAltText('待上传的照片预览')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '传上去' }))

  expect(await screen.findByText('这个文件不是图片（只支持 JPEG / PNG / WebP）')).toBeTruthy()
})

it('图片解不开时回退原图（交给后端的类型校验去拒，不是本地静默失败）', async () => {
  stubBrokenImage()
  const result = await shrinkImage(imageFile('broken.png'))
  expect(result).toBe(ORIGINAL_DATA_URL)
  expect(encoded).toEqual([])
})

it('文件读不出来时抛出可读的话（不静默吞掉）', async () => {
  stubFileReaderFailure()
  await expect(shrinkImage(imageFile('bad.png'))).rejects.toThrow('这个文件读不出来')
})

it('解码一直不回调也不会永远转圈：超时后回退原图', async () => {
  vi.useFakeTimers()
  stubSilentImage()
  const pending = shrinkImage(imageFile())
  await vi.advanceTimersByTimeAsync(15_000)
  await expect(pending).resolves.toBe(ORIGINAL_DATA_URL)
})

it('缩图参数是 1600px / JPEG 0.85（与后端 8MB 上限配套）', () => {
  expect(PHOTO_MAX_EDGE).toBe(1600)
  expect(PHOTO_QUALITY).toBe(0.85)
})
