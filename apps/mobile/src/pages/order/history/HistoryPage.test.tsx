/// <reference types="node" />
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { OrderHistory } from '@/api/orders'
import { useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import HistoryPage from './HistoryPage'

/**
 * 点单历史与美食日记（F3-09）。它是为 `RISKS.md` R-19 做的：列表只看得到最近 60 张卡
 * （约一个月），更早的点单数据还在库里、界面上看不到。所以这里要盯住：
 * ① **确实按日期区间往前翻**（不是再给一份有上限的列表）；
 * ② 翻下一页时**不能与上一页重叠**（游标挪错一天就会出现重复的日子）；
 * ③ 到头了要说"再往前没有记录了"，而不是让按钮消失得莫名其妙。
 */

const clients: QueryClient[] = []

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/order/history', state: { from: '/order' } }]}>
        <Routes>
          <Route path="/order/history" element={<HistoryPage />} />
          {/* 点单列表只看今明后三天，更早的那些餐在这里回看——所以行链接要去**这一餐的详情**
              （指回列表会是死路：那一餐根本不在列表的窗口里）*/}
          <Route path="/order/:mealKey" element={<div data-testid="meal-detail" />} />
          <Route path="/family" element={<div data-testid="family-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'OWNER', myCapabilities: ['menu.manage'], members: [],
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    meal: 'LUNCH' as const, label: '午餐', state: 'none' as const, status: null, statusLabel: '没有安排',
    dishes: [], dishCount: 0, ordererCount: 0, dinerCount: null, mealKey: 'x-LUNCH', photoCount: 0, canAdd: true,
    ...overrides,
  }
}

function page(overrides: Partial<OrderHistory> = {}): OrderHistory {
  return {
    scope: 'family',
    from: '2026-09-13',
    to: '2026-10-13',
    pageSize: 31,
    hasMore: false,
    days: [
      {
        date: '2026-10-13', weekday: '周二',
        meals: [
          row({
            meal: 'DINNER', label: '晚餐', state: 'settled', status: 'DONE', statusLabel: '已做好',
            dishes: ['番茄炒蛋'], dishCount: 1, ordererCount: 1, dinerCount: 3,
            mealKey: '2026-10-13-DINNER',
          }),
          row({ mealKey: '2026-10-13-LUNCH' }),
        ],
      },
      {
        date: '2026-10-12', weekday: '周一',
        meals: [row({ mealKey: '2026-10-12-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-12-DINNER' })],
      },
    ],
    ...overrides,
  }
}

function mockGet(handler: (url: string, params?: Record<string, unknown>) => unknown) {
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/family') return Promise.resolve({ data: FAMILY } as never)
    return Promise.resolve({ data: handler(url, config?.params) } as never)
  }) as never)
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().setSession({
    token: 'test-token',
    refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('按天铺开：有记录的那一餐显示菜名、人数与状态，没安排的那格明说"没有安排"', async () => {
  mockGet(() => page())
  renderHistory()

  expect(await screen.findByText('番茄炒蛋')).toBeTruthy()
  expect(screen.getByText('3 人吃')).toBeTruthy()
  expect(screen.getByText('已做好')).toBeTruthy()
  // 没安排的那几格也要在（"那天没张罗"本身就是回看时要看的信息）
  expect(screen.getAllByText('没有安排').length).toBeGreaterThan(0)
})

it('页头说清这一页看的是哪一段，并给出有记录的天数', async () => {
  mockGet(() => page())
  renderHistory()

  expect(await screen.findByText(/09-13 ～ 10-13/)).toBeTruthy()
  expect(screen.getByText(/2 天，有记录 1 天/)).toBeTruthy()
})

it('能往前翻：点「再往前一页」要带上一页第一天的**前一天**当新的结束日', async () => {
  const seen: (Record<string, unknown> | undefined)[] = []
  mockGet((_url, params) => {
    seen.push(params)
    if (seen.length === 1) return page({ hasMore: true })
    return page({ from: '2026-08-13', to: '2026-09-12', hasMore: false })
  })
  renderHistory()

  const more = await screen.findByRole('button', { name: /再往前一页/ })
  fireEvent.click(more)

  await waitFor(() => expect(seen.length).toBe(2))
  // 第一页 from=09-13 → 下一页的 to 必须是 09-12（挪一天），否则两页会**重叠一天**
  expect(seen[1]?.to).toBe('2026-09-12')
})

it('翻到第二页会把两页的日子接在一起（不覆盖、不重复）', async () => {
  let call = 0
  mockGet(() => {
    call += 1
    return call === 1
      ? page({ hasMore: true })
      : page({ from: '2026-09-11', to: '2026-09-12', hasMore: false, days: [{ date: '2026-09-12', weekday: '周六', meals: [row({ mealKey: '2026-09-12-LUNCH' }), row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-09-12-DINNER' })] }] })
  })
  renderHistory()

  fireEvent.click(await screen.findByRole('button', { name: /再往前一页/ }))

  // 第一页的 10-13 与第二页的 09-12 都在
  expect(await screen.findByText('2026-09-12')).toBeTruthy()
  expect(screen.getByText('2026-10-13')).toBeTruthy()
})

it('到头了说"再往前没有记录了"，不给一个点不动的按钮', async () => {
  mockGet(() => page({ hasMore: false }))
  renderHistory()

  expect(await screen.findByText('再往前没有记录了。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /再往前一页/ })).toBeNull()
})

it('一条记录都没有：说清楚是"还没有点单记录"，不是页面坏了', async () => {
  mockGet(() => page({ days: [], hasMore: false }))
  renderHistory()

  expect(await screen.findByText('还没有点单记录。')).toBeTruthy()
})

it('有内容的那一格落到**这一餐的详情**（改状态、看成品照、再点一次都在那边）', async () => {
  mockGet(() => page())
  renderHistory()

  const link = await screen.findByRole('link', { name: '番茄炒蛋' })
  // 直接去那一餐的详情（2026-10-16 起列表只画今明后三天，历史里的餐回列表是找不到的）
  expect(link.getAttribute('href')).toBe('/order/2026-10-13-DINNER')

  fireEvent.click(link)
  expect(screen.getByTestId('meal-detail')).toBeTruthy()
})

it('共享关闭时说明为什么看到的少（不能让人以为家里没张罗）', async () => {
  mockGet(() => page({ scope: 'mine' }))
  renderHistory()

  expect(await screen.findByText(/家里关了共享/)).toBeTruthy()
})

it('没有家庭时给引导，不去撞后端 404', async () => {
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
    if (url === '/family') return Promise.resolve({ data: null } as never)
    throw new Error(`没有家庭时不该请求：${url}`)
  }) as never)
  renderHistory()

  expect(await screen.findByText(/先创建家庭或用邀请码加入/)).toBeTruthy()
})

/*
 * 裸文本块要与卡片对齐（用户 2026-10-13：「这个和上面对齐」——指着 `09-13 ～ 10-13（…）` 那行）。
 *
 * 实测过改前：卡片 x=16（`.card` 自带 `margin: 14px var(--spacing-page) 0`），
 * 而这行 x=0、占满 391。修法是给这几个裸块**同样的横向外边距**——
 * 不是给容器加 padding（那会让卡片在自带 margin 之外再缩进一次）。
 * 所以这条同时守住"有边距"与"没改成容器 padding"。
 */
it('裸文本块（摘要 / 收窄说明 / 翻页 / 到头了）都与卡片同一条竖线', () => {
  const css = readFileSync(join(__dirname, './history.scss'), 'utf8')
  /*
   * ⚠️ 断言前必须**剥掉注释**：这几条规则的注释里正好引用了 `.card` 的写法
   * `margin: 14px var(--spacing-page) 0`，不剥的话注释本身就能让断言通过——
   * 把真正的 margin 改回贴边它照样绿（第一版就是这么埋的假绿，反证时才抓到）。
   */
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (name: string) => {
    const block = css.match(new RegExp(`\\.history__${name}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
    return { raw: block, code: strip(block) }
  }
  // `end` **不**在这个名单里：它嵌在 `.history__more-wrap` 内部（两者二选一渲染），
  // 父级已留边距，再给一次会缩进成 32px（实测 32 vs 卡片 16，看着就是没对齐）
  for (const cls of ['summary', 'scope', 'more-wrap']) {
    const { raw, code } = rule(cls)
    expect(raw, `没读到 .history__${cls} 规则`).toBeTruthy()
    expect(code, `.history__${cls} 要给 var(--spacing-page) 的横向外边距，才能和卡片对齐`)
      .toMatch(/margin\s*:[^;]*var\(--spacing-page\)/)
    // 光有变量还不够：必须是**横向**那一段（写在 margin 里而不是 padding 里）
    expect(code, `.history__${cls} 的边距要写在 margin 上`).toMatch(/margin\s*:\s*[^;]*var\(--spacing-page\)[^;]*;/)
  }
  // 容器**不能**加横向 padding：卡片自带 margin，再加一层就双倍缩进
  const page = css.match(/\.history-page\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  expect(page, '没读到 .history-page 规则').toBeTruthy()
  expect(page, '.history-page 不该加横向 padding（卡片自带 margin，会双倍缩进）')
    .not.toMatch(/padding(-inline)?\s*:[^;]*spacing-page/)
})

// ---------------------------------------------------------------------------
// 删整条记录（交付二 / D-085）：只有"已经定局"的两档给，且不可逆要说清代价
// ---------------------------------------------------------------------------

/** 一页里同时摆着「已做好」「已取消」「已安排」「没有安排」四种，用来验按钮只出现在该出现的地方 */
function fourKinds() {
  return page({
    days: [{
      date: '2026-10-13', weekday: '周二',
      meals: [
        row({
          meal: 'DINNER', label: '晚餐', state: 'settled', status: 'DONE', statusLabel: '已做好',
          dishes: ['番茄炒蛋', '米饭'], dishCount: 2, ordererCount: 1, photoCount: 2,
          mealKey: '2026-10-13-DINNER',
        }),
        row({
          meal: 'LUNCH', label: '午餐', state: 'settled', status: 'CANCELED', statusLabel: '已取消',
          dishes: ['青菜'], dishCount: 1, ordererCount: 1, mealKey: '2026-10-13-LUNCH',
        }),
      ],
    }, {
      date: '2026-10-12', weekday: '周一',
      meals: [
        row({
          status: 'PLANNED', statusLabel: '已安排', state: 'open',
          dishes: ['红烧肉'], dishCount: 1, ordererCount: 1, mealKey: '2026-10-12-LUNCH',
        }),
        row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-12-DINNER' }),
      ],
    }],
  })
}

it('「删除」只给已做好与已取消：还在收集/已安排/没安排的格子不给（与服务端 canDeleteMeal 同一条判据）', async () => {
  mockGet(() => fourKinds())
  renderHistory()

  await screen.findByText(/番茄炒蛋/)
  // 已做好 + 已取消 各一颗，别的格子一颗没有
  const drops = screen.getAllByRole('button', { name: /删掉 .*的记录/ })
  expect(drops.length).toBe(2)
  expect(drops.map((b) => b.getAttribute('aria-label'))).toEqual([
    '删掉 2026-10-13 晚餐的记录',
    '删掉 2026-10-13 午餐的记录',
  ])
})

it('删除是不可逆的：先弹确认把代价说清（几道菜 + 照片会留下来），没确认绝不发请求', async () => {
  mockGet(() => fourKinds())
  const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: {} } as never)
  renderHistory()

  fireEvent.click(await screen.findByRole('button', { name: '删掉 2026-10-13 晚餐的记录' }))

  expect(remove).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('删掉 2026-10-13 晚餐 的记录？')
  expect(dialog.textContent).toContain('2 道点单记录会被删掉')
  // CheckIn 是 SetNull：照片退回成"没挂餐次"的独立打卡，这句话必须说（用户最担心的就是照片）
  expect(dialog.textContent).toContain('拍的 2 张成品照会留下来')

  // 取消＝什么都没发生
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(remove).not.toHaveBeenCalled()
})

it('确认后发 DELETE，并把"删过什么"当场回报；删完那一格回到「没有安排」', async () => {
  let gone = false
  mockGet(() => {
    if (!gone) return fourKinds()
    // 删掉之后后端再给这一页时，"已做好"那一格已经不在了（历史里那一格回到"没有安排"）
    const after = fourKinds()
    after.days[0].meals = [
      row({ meal: 'DINNER', label: '晚餐', mealKey: '2026-10-13-DINNER' }),
      after.days[0].meals[1],
    ]
    return after
  })
  const remove = vi.spyOn(apiClient, 'delete').mockImplementation((() => {
    gone = true
    return Promise.resolve({
      data: {
        mealKey: '2026-10-13-DINNER', date: '2026-10-13', meal: 'DINNER',
        mealLabel: '晚餐', dishCount: 2, photoCount: 2,
      },
    })
  }) as never)
  renderHistory()

  fireEvent.click(await screen.findByRole('button', { name: '删掉 2026-10-13 晚餐的记录' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删掉这条' }))

  await waitFor(() => expect(remove).toHaveBeenCalledWith('/orders/2026-10-13-DINNER'))
  // 回执写的是"删掉了什么、什么留下了"（不是一句含糊的"删除成功"）
  await waitFor(() => expect(
    useToasts.getState().items.some((item) => item.text === '删掉了 10-13 晚餐的记录，2 张照片留了下来'),
  ).toBe(true))
  // 弹窗收走、页面上那一格真的翻新了（作废+重取，不是在前端假装删掉）
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(screen.queryByText(/番茄炒蛋/)).toBeNull())
  expect(screen.getAllByText('没有安排').length).toBeGreaterThan(0)
})

it('没有照片的那一餐不硬提照片（有几分照片说几分）', async () => {
  mockGet(() => fourKinds())
  vi.spyOn(apiClient, 'delete').mockResolvedValue({
    data: {
      mealKey: '2026-10-13-LUNCH', date: '2026-10-13', meal: 'LUNCH',
      mealLabel: '午餐', dishCount: 1, photoCount: 0,
    },
  } as never)
  renderHistory()

  fireEvent.click(await screen.findByRole('button', { name: '删掉 2026-10-13 午餐的记录' }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).not.toContain('成品照会留下来')

  fireEvent.click(within(dialog).getByRole('button', { name: '删掉这条' }))
  await waitFor(() => expect(
    useToasts.getState().items.some((item) => item.text === '删掉了 10-13 午餐的记录'),
  ).toBe(true))
})

it('删不掉时把后端那句话说出来，且弹窗留着（用户可以取消或再试）', async () => {
  mockGet(() => fourKinds())
  vi.spyOn(apiClient, 'delete').mockRejectedValue({
    isAxiosError: true,
    response: { status: 409, data: { message: '还在「准备中」，删记录得先有定局' } },
  } as never)
  renderHistory()

  fireEvent.click(await screen.findByRole('button', { name: '删掉 2026-10-13 晚餐的记录' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删掉这条' }))

  await waitFor(() => expect(
    useToasts.getState().items.some((item) => item.text === '还在「准备中」，删记录得先有定局'),
  ).toBe(true))
  expect(screen.getByRole('dialog')).toBeTruthy()
})
