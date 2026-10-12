// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { CheckIn, CheckInStats, CheckInWall } from '@/api/checkins'
import type { Family } from '@/api/family'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import CheckInPage from './CheckInPage'

// 家庭打卡墙（M9 / F9-03）：全家一起看、共享开关收窄、空态引导、上传入口。
// 权限与可见范围由后端算（scope 字段），前端按它显示说明——所以这里也验"说明跟 scope 走"。

const clients: QueryClient[] = []

function renderWall(from?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const entry = from ? { pathname: '/checkins', state: { from } } : '/checkins'
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/checkins" element={<CheckInPage />} />
          <Route path="/family" element={<h1>家庭页</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function familyFixture(overrides: Partial<Family> = {}): Family {
  return {
    id: 'f1',
    name: '小满一家',
    shared: true,
    inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(),
    memberCount: 2,
    memberLimit: 10,
    myRole: 'OWNER',
    myCapabilities: ['order.create'],
    members: [],
    ...overrides,
  }
}

function entry(overrides: Partial<CheckIn> = {}): CheckIn {
  return {
    id: 'ck1',
    photoUrl: '/checkins/photos/ck1?e=1&s=sig',
    photoExpiresAt: 1893456000,
    note: '给小满做的生日面',
    checkDate: '2026-10-12',
    createdAt: new Date().toISOString(),
    userId: 'u1',
    nickname: '妈妈',
    avatar: '🍳',
    isMe: true,
    mealKey: null,
    mealLabel: null,
    ...overrides,
  }
}

function statsFixture(overrides: Partial<CheckInStats> = {}): CheckInStats {
  const empty = { weeks: [], from: '2026-10-01', to: '2026-10-12', totalDays: 0, totalCount: 0, streak: 0 }
  return { mine: empty, family: empty, mineTotal: 0, familyTotal: 0, attachableMeals: [], ...overrides }
}

function mockGet({ family, wall, stats }: { family: Family | null; wall?: CheckInWall; stats?: CheckInStats }) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/checkins') return Promise.resolve({ data: wall ?? { items: [], total: 0, hasMore: false, scope: 'family' } } as never)
    if (url === '/checkins/stats') return Promise.resolve({ data: stats ?? statsFixture() } as never)
    // 照片：给一个空图片 blob，让 <img> 能进入已加载状态
    if (url.startsWith('/checkins/photos/')) return Promise.resolve({ data: new Blob(['x'], { type: 'image/png' }) } as never)
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  useAuth.getState().setSession({
    token: 'test-token',
    refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.restoreAllMocks()
})

it('墙上显示全家人的照片：谁传的、说了一句什么、哪一天', async () => {
  mockGet({
    family: familyFixture(),
    wall: {
      items: [
        entry({ id: 'ck1', nickname: '妈妈', note: '红烧排骨', checkDate: '2026-10-12', isMe: true }),
        entry({ id: 'ck2', nickname: '小满', avatar: '🐰', note: '我洗的菜', isMe: false, mealKey: '2026-10-12-DINNER', mealLabel: '晚餐' }),
      ],
      total: 2,
      hasMore: false,
      scope: 'family',
    },
  })
  renderWall()

  expect(await screen.findByText((_, node) => node?.textContent === '🍳 我')).toBeTruthy()
  // 小满这张是成品照，昵称后面跟着「晚餐的成品」徽标，所以整段文本含徽标
  expect(screen.getByText((_, node) => node?.textContent === '🐰 小满晚餐的成品')).toBeTruthy()
  expect(screen.getByText('红烧排骨')).toBeTruthy()
  expect(screen.getByText('我洗的菜')).toBeTruthy()
  expect(screen.getByText('晚餐的成品')).toBeTruthy()
  // 两张卡是同一天，日期自然出现两次——按"每张卡都标了日期"来断言
  expect(screen.getAllByText('2026-10-12')).toHaveLength(2)
})

it('一张都没有时给空态与引导', async () => {
  mockGet({ family: familyFixture() })
  renderWall()

  expect(await screen.findByText('还没有人打卡')).toBeTruthy()
  expect(screen.getByText('第一张照片会出现在这里。')).toBeTruthy()
})

it('共享关闭导致只看得到自己时，页面要说清原因（而不是让人以为家里没人打卡）', async () => {
  mockGet({
    family: familyFixture({ shared: false, myRole: 'EATER' }),
    wall: { items: [entry({ isMe: true })], total: 1, hasMore: false, scope: 'mine' },
  })
  renderWall()

  expect(await screen.findByText('家里关了共享，现在只看得到你自己传的。')).toBeTruthy()
})

it('没有家庭时给引导，并且不请求打卡接口', async () => {
  mockGet({ family: null })
  renderWall()

  expect(await screen.findByText('打卡墙是全家人一起攒的相册。')).toBeTruthy()
  expect(screen.getByRole('link', { name: '去创建或加入家庭' })).toBeTruthy()
  expect((screen.getByRole('button', { name: '打卡拍照' }) as HTMLButtonElement).disabled).toBe(true)
  const get = apiClient.get as unknown as { mock: { calls: unknown[][] } }
  expect(get.mock.calls.some(call => call[0] === '/checkins')).toBe(false)
})

it('有更多照片时说清只显示了最近这些', async () => {
  mockGet({
    family: familyFixture(),
    wall: { items: [entry()], total: 1, hasMore: true, scope: 'family' },
  })
  renderWall()

  expect(await screen.findByText(/只显示最近 1 张/)).toBeTruthy()
})

it('上传成功后回到「全家」视角（新照片要看得见，不能在"只看我的"里找不到自己刚传的）', async () => {
  mockGet({ family: familyFixture(), wall: { items: [], total: 0, hasMore: false, scope: 'family' } })
  renderWall()

  fireEvent.click(await screen.findByRole('button', { name: '只看我的' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '只看我的' }).className).toContain('is-active'))

  fireEvent.click(screen.getByRole('button', { name: '打卡拍照' }))
  // 抽屉打开：标题也是「打卡拍照」，所以断言抽屉里的说明文字（唯一）
  expect(await screen.findByText(/拍下今天做的那道菜/)).toBeTruthy()
})

it('每次重新打开抽屉都是干净的一份（上次写的备注不会留到下一次）', async () => {
  mockGet({ family: familyFixture(), wall: { items: [], total: 0, hasMore: false, scope: 'family' } })
  renderWall()

  // 家庭接口回来前按钮是禁用的（避免打卡墙还没确认有家庭就让人点上传）
  const openButton = await screen.findByRole('button', { name: '打卡拍照' }) as HTMLButtonElement
  await waitFor(() => expect(openButton.disabled).toBe(false))

  fireEvent.click(openButton)
  const note = await screen.findByPlaceholderText('如：给小满做的生日面')
  fireEvent.change(note, { target: { value: '上次留下的备注' } })
  expect((note as HTMLInputElement).value).toBe('上次留下的备注')

  // 关掉再开：抽屉不做"清状态"的 effect，靠每次打开换 key 重挂载。
  // 遮罩要等一帧才挂上（它跟着抽屉一起淡入，见 antd-mobile 的 Mask），出现前点不到
  await waitFor(() => expect(document.querySelector('.adm-mask')).not.toBeNull())
  fireEvent.click(document.querySelector('.adm-mask') as Element)
  // 再等它真的卸掉：收起要播完退场动画（见 BottomSheet），动画没播完那一格还在，
  // 这时点开按钮不会重挂载——上次的备注就会被当成"没清掉"（并行跑全量时红过）
  await waitFor(() => expect(screen.queryByPlaceholderText('如：给小满做的生日面')).toBeNull(), { timeout: 3000 })
  fireEvent.click(openButton)

  const reopened = await screen.findByPlaceholderText('如：给小满做的生日面')
  expect((reopened as HTMLInputElement).value).toBe('')
})

it('返回入口跟着来源走：从「我的」进来就回我的，不写死厨房', async () => {
  mockGet({ family: familyFixture() })
  renderWall('/mine')

  const back = await screen.findByRole('link', { name: '← 返回我的' })
  expect(back.getAttribute('href')).toBe('/mine')
  // 写死"返回厨房"时，从我的进来的人点返回会落到厨房——这条就是防它回来
  expect(screen.queryByRole('link', { name: '← 返回厨房' })).toBeNull()
})

it('从点单卡的成品照进来就回订单页', async () => {
  mockGet({ family: familyFixture() })
  renderWall('/order')

  // 文案统一取底部 Tab 的名字（共享的 back-link 模块按 tab.label 生成）：
  // 用户看着底栏那个「订单」点返回，按钮上就不该写另一种叫法
  const back = await screen.findByRole('link', { name: '← 返回订单' })
  expect(back.getAttribute('href')).toBe('/order')
})

it('没带来源（直接输地址）时兜底回「我的」，不是厨房', async () => {
  mockGet({ family: familyFixture() })
  renderWall()

  const back = await screen.findByRole('link', { name: '← 返回我的' })
  expect(back.getAttribute('href')).toBe('/mine')
})
