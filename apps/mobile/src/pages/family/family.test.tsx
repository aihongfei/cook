// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { can, type Family } from '@/api/family'
import { useAuth } from '@/stores/auth'
import FamilyPage from './FamilyPage'

// 家庭与成员（F2-05/06/07/09）的判定核心：
// 没家庭时给创建/加入、有家庭时按"能力"显示管理入口、普通成员看不到管理控件。
// 权限不是前端自己算的——myCapabilities 由后端下发，这里连"前端不硬编码"一起验。

const clients: QueryClient[] = []

function renderFamily(entry: string | { pathname: string; state?: unknown } = '/family') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry as never]}>
        <Routes>
          <Route path="/family" element={<FamilyPage />} />
          <Route path="/login" element={<h1>登录</h1>} />
          <Route path="/mine" element={<h1>我的页</h1>} />
          <Route path="/kitchen" element={<h1>厨房页</h1>} />
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
    myCapabilities: ['order.create', 'menu.manage', 'menu.confirm', 'member.manage', 'invite.reset', 'family.edit'],
    members: [
      { userId: 'u1', nickname: '妈妈', avatar: '🍳', role: 'OWNER', joinedAt: new Date().toISOString(), isMe: true },
      { userId: 'u2', nickname: '小满', avatar: '🐰', role: 'EATER', joinedAt: new Date().toISOString(), isMe: false },
    ],
    ...overrides,
  }
}

/** 让 /auth/me 与 /family 各返回各自的数据（页面同时用了这两个接口） */
function mockGet({ family, me = { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() } }: { family: Family | null; me?: unknown }) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/family/options') {
      return Promise.resolve({
        data: {
          roles: [
            { value: 'OWNER', label: '掌勺人', capabilities: ['member.manage', 'invite.reset', 'family.edit'] },
            { value: 'COOK', label: '帮厨', capabilities: ['menu.manage'] },
            { value: 'EATER', label: '吃货', capabilities: ['order.create'] },
          ],
          memberLimit: 10,
        },
      } as never)
    }
    if (url === '/auth/me') return Promise.resolve({ data: me } as never)
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  // 家庭页要求已登录（无 token 会跳登录页）。
  // 直接写 store 而不是 localStorage：persist 只在**模块加载时**读一次 localStorage，
  // 在 beforeEach 里写已经晚了，store 里仍然是 null。
  useAuth.getState().setSession({
    token: 'test-token',
    refreshToken: 'test-refresh',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🍳', email: null, createdAt: new Date().toISOString() },
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  useAuth.getState().clear()
  vi.restoreAllMocks()
})

it('还没加入家庭时显示创建与加入两个入口', async () => {
  mockGet({ family: null })
  renderFamily()

  expect(await screen.findByText('我来建一个家')).toBeTruthy()
  expect(screen.getByText('用邀请码加入')).toBeTruthy()
  expect(screen.getByRole('button', { name: '创建家庭' })).toBeTruthy()
  // 邀请码没填满 6 位时不能提交（避免打无效请求）
  const joinButton = screen.getByRole('button', { name: '加入家庭' }) as HTMLButtonElement
  expect(joinButton.disabled).toBe(true)
  fireEvent.change(screen.getByPlaceholderText('例如 7AQ27R'), { target: { value: 'H65WA' } })
  expect(joinButton.disabled).toBe(true)
  fireEvent.change(screen.getByPlaceholderText('例如 7AQ27R'), { target: { value: 'H65WAJ' } })
  expect(joinButton.disabled).toBe(false)
})

it('输入的小写邀请码会转成大写显示', async () => {
  mockGet({ family: null })
  renderFamily()

  const input = (await screen.findByPlaceholderText('例如 7AQ27R')) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'h65waj' } })
  expect(input.value).toBe('H65WAJ')
})

it('掌勺人看到邀请码、成员角色控件与共享开关', async () => {
  mockGet({ family: familyFixture() })
  renderFamily()

  expect(await screen.findByText('H65WAJ')).toBeTruthy()
  expect(screen.getByText('小满一家')).toBeTruthy()
  expect(screen.getByText('2/10 位成员 · 我是掌勺人')).toBeTruthy()
  // 成员行：别人有角色下拉与移出，自己没有（不能移出自己）
  expect(screen.getByLabelText('设置 小满 的角色')).toBeTruthy()
  expect(screen.getByRole('button', { name: '移出' })).toBeTruthy()
  expect(screen.queryByLabelText('设置 妈妈 的角色')).toBeNull()
  expect(screen.getByRole('switch', { name: '家庭共享开关' }).getAttribute('aria-checked')).toBe('true')
})

it('普通成员看不到管理控件，且提示权限归掌勺人', async () => {
  mockGet({
    family: familyFixture({
      myRole: 'EATER',
      myCapabilities: ['order.create'],
      members: [
        { userId: 'u1', nickname: '妈妈', avatar: '🍳', role: 'OWNER', joinedAt: new Date().toISOString(), isMe: false },
        { userId: 'u2', nickname: '小满', avatar: '🐰', role: 'EATER', joinedAt: new Date().toISOString(), isMe: true },
      ],
    }),
  })
  renderFamily()

  expect(await screen.findByText('H65WAJ')).toBeTruthy()
  // 管理入口一个都不该出现（后端也会再拦一次，这是第二道）
  expect(screen.queryByLabelText('设置 妈妈 的角色')).toBeNull()
  expect(screen.queryByRole('button', { name: '移出' })).toBeNull()
  expect(screen.queryByRole('button', { name: '改家庭名' })).toBeNull()
  expect(screen.queryByRole('button', { name: '换一个' })).toBeNull()
  expect(screen.getByText('邀请码只有掌勺人能换。')).toBeTruthy()
  expect(screen.getByText('共享开关只有掌勺人能改。')).toBeTruthy()
  // 共享开关即使渲染了也是禁用状态
  expect((screen.getByRole('switch', { name: '家庭共享开关' }) as HTMLButtonElement).disabled).toBe(true)
})

it('掌勺人家里还有人时不显示退出按钮（避免撞后端 409）', async () => {
  mockGet({ family: familyFixture() })
  renderFamily()

  expect(await screen.findByText('你是掌勺人：把「掌勺人」交给一位家人后，才能退出这个家。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '解散家庭' })).toBeNull()
})

it('掌勺人独自一人时可以解散，且要先确认', async () => {
  mockGet({
    family: familyFixture({
      memberCount: 1,
      members: [{ userId: 'u1', nickname: '妈妈', avatar: '🍳', role: 'OWNER', joinedAt: new Date().toISOString(), isMe: true }],
    }),
  })
  renderFamily()

  fireEvent.click(await screen.findByRole('button', { name: '解散家庭' }))
  expect(screen.getByText('解散后这个家就没了，成员关系也会一起清掉。确定吗？')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '再想想' }))
  expect(screen.queryByText('解散后这个家就没了，成员关系也会一起清掉。确定吗？')).toBeNull()
})

it('切换共享开关会调用接口并在成功后更新文案', async () => {
  mockGet({ family: familyFixture({ shared: true }) })
  const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: familyFixture({ shared: false }) } as never)
  renderFamily()

  fireEvent.click(await screen.findByRole('switch', { name: '家庭共享开关' }))
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/family', { shared: false }))
  expect(await screen.findByText('已关闭家庭共享')).toBeTruthy()
  // 缓存被最新家庭替换后，开关状态跟着变
  await waitFor(() => expect(screen.getByRole('switch', { name: '家庭共享开关' }).getAttribute('aria-checked')).toBe('false'))
})

it('返回入口按来源显示：从厨房进来就回厨房', async () => {
  mockGet({ family: familyFixture() })
  renderFamily({ pathname: '/family', state: { from: '/kitchen' } })

  const back = await screen.findByRole('link', { name: '← 返回厨房' })
  expect(back.getAttribute('href')).toBe('/kitchen')
})

it('返回入口默认回"我的"（直接输地址进来时也走得回去）', async () => {
  mockGet({ family: familyFixture() })
  renderFamily()

  const back = await screen.findByRole('link', { name: '← 返回我的' })
  expect(back.getAttribute('href')).toBe('/mine')
})

it('来源不在白名单时不乱跳，仍回"我的"', async () => {
  mockGet({ family: familyFixture() })
  renderFamily({ pathname: '/family', state: { from: 'https://evil.example.com' } })

  expect((await screen.findByRole('link', { name: '← 返回我的' })).getAttribute('href')).toBe('/mine')
})

it('can() 只看后端下发的能力清单（前端不自己推角色）', () => {
  const family = familyFixture({ myRole: 'EATER', myCapabilities: ['order.create'] })
  expect(can(family, 'order.create')).toBe(true)
  expect(can(family, 'member.manage')).toBe(false)
  expect(can(null, 'order.create')).toBe(false)
  expect(can(undefined, 'member.manage')).toBe(false)
})
