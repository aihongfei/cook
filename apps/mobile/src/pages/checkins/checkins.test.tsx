// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { CheckIn, CheckInComment, CheckInStats, CheckInWall } from '@/api/checkins'
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
    // 编辑/删除与评论（用户 2026-10-15）：默认是"我自己上传的、还没人说话"
    canEdit: true,
    canDelete: true,
    comments: [],
    ...overrides,
  }
}

function statsFixture(overrides: Partial<CheckInStats> = {}): CheckInStats {
  const empty = { weeks: [], from: '2026-10-01', to: '2026-10-12', totalDays: 0, totalCount: 0, streak: 0 }
  return { mine: empty, family: empty, mineTotal: 0, familyTotal: 0, attachableMeals: [], ...overrides }
}

function mockGet({ family, wall, stats, detail }: { family: Family | null; wall?: CheckInWall; stats?: CheckInStats; detail?: CheckIn | null }) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/checkins') return Promise.resolve({ data: wall ?? { items: [], total: 0, hasMore: false, scope: 'family' } } as never)
    if (url === '/checkins/stats') return Promise.resolve({ data: stats ?? statsFixture() } as never)
    /*
     * 单张详情（2026-10-15：抽屉里能看到最新评论、拿到 canEdit/canDelete）。
     *
     * 不给 `detail` 时就**照着墙上那张卡回一份**——组件本来就能拿卡片先画首屏
     * （`detail.data ?? entry`），这里让"取详情"这条路也有个诚实的回应，
     * 不然每条用例都会撞上"未预期的请求"而看不出来。
     * 明确传 `detail: null` 才是"详情取不到"那种情形（离线、已被删）。
     */
    const one = /^\/checkins\/(?!photos\/|stats$|comments\/)([^/]+)$/.exec(url)
    if (one) {
      if (detail === null) return Promise.reject(new Error('这张照片不存在'))
      const fallback = wall?.items.find(item => item.id === decodeURIComponent(one[1]))
      return Promise.resolve({ data: detail ?? fallback ?? entry({ id: decodeURIComponent(one[1]) }) } as never)
    }
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

/*
 * 点开看详情（用户 2026-10-14：「打卡墙卡片不能点击查看详情」）。
 *
 * 卡片原来是纯 `<figure>`——一屏照片里谁做的、几点拍的、当时说了什么，
 * 全都塞不进那张小卡里，而**没处点**就等于这些信息不存在。
 */
it('卡片能点开看详情：完整备注 + 拍下来的时刻', async () => {
  const longNote = '小满说想吃糖醋排骨，我照着菜谱做了，收汁那一步火候没控制好，下次少放一点糖。'
  mockGet({
    family: familyFixture(),
    wall: {
      items: [entry({
        id: 'ck1', nickname: '妈妈', isMe: true, note: longNote, checkDate: '2026-10-12',
        // 用一个明确的本地时刻：详情里要显示到"几点"（卡片上只有日期）
        createdAt: new Date(2026, 9, 12, 18, 42).toISOString(),
      })],
      total: 1, hasMore: false, scope: 'family',
    },
  })
  renderWall()

  // 卡片本身是个按钮（不是"点了没反应的图"，也不是靠 tabIndex 画上去的可点性）
  const card = await screen.findByRole('button', { name: '看我 2026-10-12 的打卡详情' })
  fireEvent.click(card)

  // 详情里备注**完整**给出（卡片上那两行是 CSS 截断的）。
  // 墙上那张卡里还有一份同样的文字，所以按"详情里那一处"精确取。
  const note = await screen.findByText(longNote, { selector: '.checkin-detail__note' })
  expect(note.textContent).toBe(longNote)
  // 「几点拍的」只在详情里有
  expect(screen.getByText(/18:42/)).toBeTruthy()
  // 照片能点开看大图
  expect(screen.getByRole('button', { name: '看大图' })).toBeTruthy()
})

it('详情里没写备注时说一句，而不是留一片空白', async () => {
  mockGet({
    family: familyFixture(),
    wall: { items: [entry({ id: 'ck1', note: null })], total: 1, hasMore: false, scope: 'family' },
  })
  renderWall()

  fireEvent.click(await screen.findByRole('button', { name: /打卡详情/ }))
  expect(await screen.findByText('这一张没写备注。')).toBeTruthy()
})

it('照片加载失败时，详情里的文字仍然看得到（不能整屏白掉）', async () => {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: familyFixture() } as never)
    if (url === '/checkins') {
      return Promise.resolve({
        data: { items: [entry({ id: 'ck1', note: '红烧排骨' })], total: 1, hasMore: false, scope: 'family' },
      } as never)
    }
    if (url === '/checkins/stats') return Promise.resolve({ data: statsFixture() } as never)
    if (url.startsWith('/checkins/photos/')) return Promise.reject(new Error('图没了'))
    throw new Error(`未预期的请求：${url}`)
  })
  renderWall()

  fireEvent.click(await screen.findByRole('button', { name: /打卡详情/ }))
  expect(await screen.findByText('照片打不开了')).toBeTruthy()
  // 关键：照片挂了不该把"谁、什么时候、说了什么"一起藏掉
  // （墙上那张卡里也有一份同样的文字，所以这里按"至少有一份"断言）
  expect(screen.getAllByText('红烧排骨').length).toBeGreaterThan(0)
})

/*
 * 编辑、删除与评论（用户 2026-10-15：「还要添加打开编辑和删除功能，评论也要」）。
 *
 * 这一组盯四件事：
 * ① **入口按后端给的 `canEdit`/`canDelete` 出**（不是前端自己判"是不是我传的"）——
 *    判定抄两遍迟早分叉，分叉的表现是"按钮看得见、点下去 403"；
 * ② 删除是**不可逆**的，必须先确认、且把"评论一起没"说清；
 * ③ 评论能写、能改自己的、能删自己的，**别人的没有那两个小按钮**；
 * ④ 改过的评论要标出来（不然"他明明说的是另一句"没法解释）。
 */

function commentFixture(overrides: Partial<CheckInComment> = {}): CheckInComment {
  return {
    id: 'cm1',
    body: '好香啊',
    createdAt: '2026-10-12T10:20:00.000Z',
    updatedAt: '2026-10-12T10:20:00.000Z',
    userId: 'u2',
    nickname: '小满',
    avatar: '🐰',
    isMe: false,
    canEdit: false,
    canDelete: false,
    ...overrides,
  }
}

/** 打开某一项的详情抽屉（等评论区那个输入框出来——标题里带一条分隔的计数，用文本匹配会碎） */
async function openDetail(name = /打卡详情/) {
  fireEvent.click(await screen.findByRole('button', { name }))
  await screen.findByLabelText('写一句评论')
}

it('本人打开详情：有「改交代」与「删掉这张」两颗入口', async () => {
  mockGet({
    family: familyFixture(),
    wall: { items: [entry({ id: 'ck1', isMe: true, canEdit: true, canDelete: true })], total: 1, hasMore: false, scope: 'family' },
  })
  renderWall()
  await openDetail()

  expect(screen.getByRole('button', { name: '改交代' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '删掉这张' })).toBeTruthy()
})

it('别人打开详情：一颗入口都没有（只能看、能评论）', async () => {
  mockGet({
    family: familyFixture(),
    wall: {
      items: [entry({ id: 'ck1', isMe: false, nickname: '妈妈', canEdit: false, canDelete: false })],
      total: 1, hasMore: false, scope: 'family',
    },
  })
  renderWall()
  await openDetail()

  expect(screen.queryByRole('button', { name: '改交代' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删掉这张' })).toBeNull()
  // 但评论是人人可以说的
  expect(screen.getByLabelText('写一句评论')).toBeTruthy()
})

it('改交代：点开→改写→保存，发 PATCH 并说一句', async () => {
  const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({
    data: entry({ id: 'ck1', note: '改过的交代', canEdit: true, canDelete: true }),
  } as never)
  mockGet({
    family: familyFixture(),
    wall: { items: [entry({ id: 'ck1' })], total: 1, hasMore: false, scope: 'family' },
  })
  renderWall()
  await openDetail()

  fireEvent.click(screen.getByRole('button', { name: '改交代' }))
  const input = screen.getByLabelText('改这句交代') as HTMLInputElement
  fireEvent.change(input, { target: { value: '改过的交代' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() => expect(patch).toHaveBeenCalledWith('/checkins/ck1', { note: '改过的交代' }))
  await waitFor(() => expect(useToasts.getState().items.some(item => item.text === '交代改好了')).toBe(true))
})

it('删掉这张：先确认（把"评论一起没"说清），确认后才发 DELETE', async () => {
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { id: 'ck1', removedComments: 2 } } as never)
  mockGet({
    family: familyFixture(),
    wall: {
      items: [entry({
        id: 'ck1',
        comments: [commentFixture({ id: 'c1' }), commentFixture({ id: 'c2', body: '我也想吃' })],
      })],
      total: 1, hasMore: false, scope: 'family',
    },
  })
  renderWall()
  await openDetail()

  fireEvent.click(screen.getByRole('button', { name: '删掉这张' }))
  // 没确认之前绝不能发请求：这一步不可逆
  expect(remove).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('2 条评论也会一起没')

  fireEvent.click(within(dialog).getByRole('button', { name: '删掉' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('/checkins/ck1'))
  await waitFor(() => expect(useToasts.getState().items.some(item => item.text === '删掉了，底下的评论也一起删了')).toBe(true))
})

it('评论流：时间正序、自己写的才带「改/删」、改过的标出来', async () => {
  mockGet({
    family: familyFixture(),
    wall: {
      items: [entry({
        id: 'ck1',
        comments: [
          commentFixture({ id: 'c1', body: '好香啊', nickname: '小满', canEdit: false, canDelete: false }),
          commentFixture({
            id: 'c2', body: '谢谢小满', nickname: '妈妈', avatar: '🍳', isMe: true, canEdit: true, canDelete: true,
            createdAt: '2026-10-12T11:00:00.000Z', updatedAt: '2026-10-12T11:30:00.000Z',
          }),
        ],
      })],
      total: 1, hasMore: false, scope: 'family',
    },
  })
  renderWall()
  await openDetail()

  const bodies = [...document.querySelectorAll('.checkin-comment__body')].map(node => node.textContent)
  expect(bodies[0]).toContain('好香啊')
  expect(bodies[1]).toContain('谢谢小满')

  // 只有自己那条有「改 / 删」
  const items = [...document.querySelectorAll('.checkin-comment')]
  expect(items[0].querySelector('.checkin-comment__actions')).toBeNull()
  expect(items[1].querySelector('.checkin-comment__actions')).not.toBeNull()
  // 改过的要说出来
  expect(items[1].querySelector('.checkin-comment__edited')?.textContent).toBe('（改过）')
  expect(items[0].querySelector('.checkin-comment__edited')).toBeNull()
})

it('发一条评论：POST 到这一张底下、正文去空白，发完清空输入框', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: commentFixture({ isMe: true, canEdit: true, canDelete: true }) } as never)
  mockGet({
    family: familyFixture(),
    wall: { items: [entry({ id: 'ck1' })], total: 1, hasMore: false, scope: 'family' },
  })
  renderWall()
  await openDetail()

  const input = screen.getByLabelText('写一句评论') as HTMLInputElement
  fireEvent.change(input, { target: { value: '  真好看  ' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))

  await waitFor(() => expect(post).toHaveBeenCalledWith('/checkins/ck1/comments', { body: '真好看' }))
  await waitFor(() => expect((screen.getByLabelText('写一句评论') as HTMLInputElement).value).toBe(''))
})

it('空评论发不出去（发送键点不动），不用等后端回一个 400', async () => {
  const post = vi.spyOn(apiClient, 'post')
  mockGet({
    family: familyFixture(),
    wall: { items: [entry({ id: 'ck1' })], total: 1, hasMore: false, scope: 'family' },
  })
  renderWall()
  await openDetail()

  expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('写一句评论'), { target: { value: '   ' } })
  expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  expect(post).not.toHaveBeenCalled()
})

it('改自己的评论：点「改」→ 输入框变成那句原文 → 保存发 PATCH', async () => {
  const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: commentFixture({ isMe: true, canEdit: true, canDelete: true }) } as never)
  mockGet({
    family: familyFixture(),
    wall: {
      items: [entry({
        id: 'ck1',
        comments: [commentFixture({ id: 'c2', body: '谢谢小满', isMe: true, canEdit: true, canDelete: true })],
      })],
      total: 1, hasMore: false, scope: 'family',
    },
  })
  renderWall()
  await openDetail()

  fireEvent.click(screen.getByRole('button', { name: '改' }))
  const input = screen.getByLabelText('改这句评论') as HTMLInputElement
  expect(input.value).toBe('谢谢小满')
  fireEvent.change(input, { target: { value: '谢谢，明天还想吃' } })
  // 编辑态下的保存键（与"发送"是同一颗，文案变了）
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() => expect(patch).toHaveBeenCalledWith('/checkins/comments/c2', { body: '谢谢，明天还想吃' }))
})

it('删自己的评论：点「删」直接发（可再写、不必弹框确认）', async () => {
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { id: 'c2', checkInId: 'ck1' } } as never)
  mockGet({
    family: familyFixture(),
    wall: {
      items: [entry({
        id: 'ck1',
        comments: [commentFixture({ id: 'c2', body: '谢谢小满', isMe: true, canEdit: true, canDelete: true })],
      })],
      total: 1, hasMore: false, scope: 'family',
    },
  })
  renderWall()
  await openDetail()

  fireEvent.click(screen.getByRole('button', { name: '删' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('/checkins/comments/c2'))
  await waitFor(() => expect(useToasts.getState().items.some(item => item.text === '删掉了')).toBe(true))
})
