// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { ComboBoard } from '@/api/combos'
import { toast } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import CombosPage from './CombosPage'

/**
 * 常用组合（M4 / F4-04）。要盯住的事：
 * ① 一键加入要带**用户选的日期与餐次**（少一个后端就 400，"加入"永远失败）；
 * ② "跳过已有的"要**说出来**——点了没变却不解释，用户只会以为按钮坏了；
 * ③ 改/删只出现在 `canEdit` 的组合上（后端仍会校验，前端藏按钮不算权限）。
 */

const clients: QueryClient[] = []

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/combos', state: { from: '/discover' } }]}>
        <Routes>
          <Route path="/combos" element={<CombosPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAMILY = {
  id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
  createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
  myRole: 'EATER', myCapabilities: ['order.create'], members: [],
}

const MY_COMBO = {
  id: 'c1', name: '快手三菜一汤', note: '工作日的晚上', createdBy: '妈妈', canEdit: true,
  dishCount: 3,
  dishes: [
    { recipeId: 'r1', name: '番茄炒蛋', image: null },
    { recipeId: 'r2', name: '清炒菜心', image: null },
    { recipeId: 'r3', name: '青菜豆腐汤', image: null },
  ],
}

const OTHERS_COMBO = { ...MY_COMBO, id: 'c2', name: '周末硬菜', createdBy: '爸爸', canEdit: false }

const OPTIONS = {
  meals: [{ value: 'LUNCH', label: '午餐' }, { value: 'DINNER', label: '晚餐' }],
  statuses: [],
  dayOptions: [
    { value: '2026-10-12', label: '今天' },
    { value: '2026-10-13', label: '明天' },
    { value: '2026-10-14', label: '后天' },
  ],
}

let posted: { url: string; body: unknown }[] = []

function mockApi({
  combos = [MY_COMBO, OTHERS_COMBO] as ComboBoard['combos'],
  addResult = { added: ['清炒菜心'], skipped: ['番茄炒蛋'], card: { mealKey: '2026-10-13-DINNER' }, },
  addFails = false,
  family = FAMILY as typeof FAMILY | null,
} = {}) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/combos') return Promise.resolve({ data: { combos } } as never)
    if (url === '/orders/options') return Promise.resolve({ data: OPTIONS } as never)
    throw new Error(`未预期的请求：${url}`)
  })
  vi.spyOn(apiClient, 'post').mockImplementation((url: string, body: unknown) => {
    posted.push({ url, body })
    if (url.endsWith('/add')) {
      if (addFails) {
        return Promise.reject({ isAxiosError: true, response: { status: 409, data: { message: '这餐已经做好了，换个餐次再点吧' } } })
      }
      return Promise.resolve({ data: addResult } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
  const del = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { combos: [OTHERS_COMBO] } } as never)
  return { del }
}

/**
 * 默认落点跟着时钟走（下午 3 点前后不同）——涉及提交的用例都钉死时间，
 * 否则同一个测试白天绿、晚上红（这不是理论：它们是本文件里最先红的几条）。
 */
function pinMorning() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-12T10:00:00+08:00'))
}

beforeEach(() => {
  localStorage.clear()
  posted = []
  useAuth.getState().setSession({
    token: 't', refreshToken: 'r',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('列出家里的组合：菜名、谁组的、以及能不能改', async () => {
  mockApi()
  renderPage()

  expect(await screen.findByText('快手三菜一汤')).toBeTruthy()
  // 两个 fixture 的菜名单一样，所以按"出现两次"断言（各属于一张卡）
  expect(screen.getAllByText('番茄炒蛋 · 清炒菜心 · 青菜豆腐汤')).toHaveLength(2)
  expect(screen.getByText('妈妈 组的')).toBeTruthy()
  // 「删除」只在我能改的那一组上（后端也会再校验一次）
  expect(screen.getAllByText('删除')).toHaveLength(1)
  expect(screen.getByText('周末硬菜')).toBeTruthy()
})

it('一键加入带着用户选的日期与餐次（少一个后端就 400）', async () => {
  // 固定在上午 10 点：默认"下一餐"= 今天晚餐
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-12T10:00:00+08:00'))
  try {
    mockApi()
    renderPage()

    fireEvent.click((await screen.findAllByText('加进某一餐'))[0])
    // 抽屉里的默认：今天 + 晚餐（与手点同一套规则）
    await waitFor(() => expect(document.querySelector('.order-sheet__group')).toBeTruthy())
    const groups = [...document.querySelectorAll('.order-sheet__group')].slice(0, 2)
    expect([...groups[0].querySelectorAll('.order-sheet__choice')].find((b) => b.classList.contains('is-active'))?.textContent).toBe('今天')
    expect([...groups[1].querySelectorAll('.order-sheet__choice')].find((b) => b.classList.contains('is-active'))?.textContent).toBe('晚餐')

    // 改到"明天 + 午餐"，提交
    const dayButtons = [...groups[0].querySelectorAll('button')]
    fireEvent.click(dayButtons.find((b) => b.textContent === '明天') as Element)
    const mealButtons = [...groups[1].querySelectorAll('button')]
    fireEvent.click(mealButtons.find((b) => b.textContent === '午餐') as Element)

    fireEvent.click(screen.getByText(/整组加进明天午餐/))
    await waitFor(() => expect(posted.some((call) => call.url === '/combos/c1/add')).toBe(true))
    const call = posted.find((item) => item.url === '/combos/c1/add')
    expect(call?.body).toEqual({ mealDate: '2026-10-13', meal: 'LUNCH' })
  } finally {
    vi.useRealTimers()
  }
})

it('「跳过已有的」要说出来（点了没变却不解释，用户只会以为按钮坏了）', async () => {
  pinMorning()
  try {
    const error = vi.spyOn(toast, 'error')
    // toast 由应用根部的 <Toaster/> 渲染（测试树里没有），所以断言**调用**而不是渲染出的文字
    const success = vi.spyOn(toast, 'success')
    mockApi()
    renderPage()

    fireEvent.click((await screen.findAllByText('加进某一餐'))[0])
    await waitFor(() => expect(screen.getByText(/整组加进今天晚餐/)).toBeTruthy())
    fireEvent.click(screen.getByText(/整组加进今天晚餐/))

    // 两句提示：加进去几道 + 哪几道本来就有（跳过不解释的话，用户只会以为按钮坏了）
    await waitFor(() => expect(success).toHaveBeenCalledWith('已把 1 道加进今天晚餐'))
    expect(success).toHaveBeenCalledWith('番茄炒蛋 本来就有，没重复加')
    expect(error).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('整组都在这一餐里时说实话（不是"加入成功"）', async () => {
  pinMorning()
  try {
    mockApi({ addResult: { added: [], skipped: ['番茄炒蛋', '清炒菜心', '青菜豆腐汤'], card: { mealKey: 'x' } } })
    renderPage()

    const success = vi.spyOn(toast, 'success')
    fireEvent.click((await screen.findAllByText('加进某一餐'))[0])
    await waitFor(() => expect(screen.getByText(/整组加进今天晚餐/)).toBeTruthy())
    fireEvent.click(screen.getByText(/整组加进今天晚餐/))

    await waitFor(() => expect(success).toHaveBeenCalledWith('「快手三菜一汤」这组菜在今天晚餐都有了'))
    // 一句就够：不要再单独报一遍"哪几道跳过了"（用户看到的本来就是"没变"）
    expect(success).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

it('后端拒绝时把话术显示出来（如"这餐已经做好了"），抽屉不关', async () => {
  pinMorning()
  try {
    const error = vi.spyOn(toast, 'error')
    mockApi({ addFails: true })
    renderPage()

    fireEvent.click((await screen.findAllByText('加进某一餐'))[0])
    await waitFor(() => expect(screen.getByText(/整组加进今天晚餐/)).toBeTruthy())
    fireEvent.click(screen.getByText(/整组加进今天晚餐/))

    await waitFor(() => expect(error).toHaveBeenCalledWith('这餐已经做好了，换个餐次再点吧'))
  } finally {
    vi.useRealTimers()
  }
})

it('删组合先问一句（删了全家人就不能用了）', async () => {
  const { del } = mockApi()
  renderPage()

  fireEvent.click(await screen.findByText('删除'))
  expect(await screen.findByText(/把「快手三菜一汤」删掉？/)).toBeTruthy()
  // 还没确认：不能先删
  expect(del).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '删掉' }))
  await waitFor(() => expect(del).toHaveBeenCalledWith('/combos/c1'))
})

it('一个组合都没有时指路怎么建（这一页自己不能凭空造组合）', async () => {
  mockApi({ combos: [] })
  renderPage()

  expect(await screen.findByText('还没有常用组合')).toBeTruthy()
  expect(screen.getByText(/在点菜单里把这一餐的菜存成组合/)).toBeTruthy()
})

it('没加入家庭时给引导，并且不请求组合接口', async () => {
  const get = mockApi({ family: null }).del && apiClient.get
  renderPage()

  expect(await screen.findByText(/组合是家里人一起用的/)).toBeTruthy()
  const calls = (get as unknown as { mock: { calls: unknown[][] } }).mock.calls
  expect(calls.some((call) => call[0] === '/combos')).toBe(false)
})
