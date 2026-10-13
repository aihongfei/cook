// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import MinePage from './MinePage'

// 我的页（F2-03 资料）：账号展示、编辑资料、退出登录。
// 头像选择器那段是重点：它的选中态只体现在 class 上（`mine-edit__avatar is-active`），
// 曾经因为少一个空格拼成 `mine-edit__avataris-active`，连基础样式（38×38 圆形）都一起丢了。

const AVATARS = ['🍳', '🐰', '🐻']
const clients: QueryClient[] = []

function renderMine() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <MinePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const ME = {
  id: 'u1',
  account: 'mama',
  nickname: '妈妈',
  avatar: '🍳',
  email: 'mama@example.com',
  createdAt: new Date().toISOString(),
}

function mockGet(family: unknown = null) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/auth/options') {
      return Promise.resolve({
        data: {
          accountMaxLength: 20,
          passwordMinLength: 6,
          passwordMaxLength: 64,
          avatars: AVATARS,
        },
      } as never)
    }
    if (url === '/auth/me') return Promise.resolve({ data: ME } as never)
    if (url === '/family') return Promise.resolve({ data: family } as never)
    if (url === '/checkins/stats') {
      return Promise.resolve({
        data: {
          mine: {
            weeks: [], from: '2026-06-15', to: '2026-10-12',
            totalDays: 1, totalCount: 4, streak: 1,
          },
          family: { weeks: [], from: '2026-06-15', to: '2026-10-12', totalDays: 2, totalCount: 5, streak: 1 },
          mineTotal: 4,
          familyTotal: 5,
          attachableMeals: [],
        },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
  useAuth.getState().setSession({ token: 'access-1', refreshToken: 'refresh-1', user: ME })
  mockGet()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

async function openEditor() {
  renderMine()
  fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }))
}

it('展示账号与邮箱，邮箱为空时给出去绑的说明', async () => {
  renderMine()
  expect(await screen.findByText('账号：mama')).toBeTruthy()
  expect(screen.getByText('邮箱：mama@example.com')).toBeTruthy()
})

it('编辑资料时当前头像标为选中，点头像能换选中态', async () => {
  await openEditor()

  const current = screen.getByRole('button', { name: '选择头像 🍳' })
  // 两个 class 都要在：少一个修饰类只是没高亮，丢了基础类会让 38×38 圆形整个消失
  expect(current.classList.contains('mine-edit__avatar')).toBe(true)
  expect(current.classList.contains('is-active')).toBe(true)
  expect(current.getAttribute('aria-pressed')).toBe('true')

  const next = screen.getByRole('button', { name: '选择头像 🐰' })
  expect(next.classList.contains('is-active')).toBe(false)

  fireEvent.click(next)
  expect(next.classList.contains('is-active')).toBe(true)
  expect(next.getAttribute('aria-pressed')).toBe('true')
  expect(current.classList.contains('is-active')).toBe(false)
})

it('保存把昵称、头像与邮箱发给后端，成功后收起表单并提示', async () => {
  const patch = vi
    .spyOn(apiClient, 'patch')
    .mockResolvedValue({ data: { ...ME, nickname: '小艾', avatar: '🐰' } } as never)
  await openEditor()

  fireEvent.change(screen.getByDisplayValue('妈妈'), { target: { value: '小艾' } })
  fireEvent.click(screen.getByRole('button', { name: '选择头像 🐰' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/auth/me', {
      nickname: '小艾',
      avatar: '🐰',
      email: 'mama@example.com',
    }),
  )
  expect(await screen.findByText('资料已更新')).toBeTruthy()
})

/*
 * 「我的菜谱」入口（F1-12）：与「我收藏的菜」同一个形状（`.me-entry`），
 * 顺序上紧跟它放在「我的菜」这一节里——两行都是"翻我自己的菜"。
 */
it('「我的菜谱」入口在「我的菜」里，指向 /recipes/mine 并带上来源', async () => {
  renderMine()

  const link = await screen.findByRole('link', { name: /我的菜谱/ })
  expect(link.getAttribute('href')).toBe('/recipes/mine')
  expect(link.classList.contains('me-entry')).toBe(true)
  // 数量拿不到时给说明文字（与收藏那一行同一条口径：有数报数，没有就说它是干什么的）
  expect(link.textContent).toContain('自己上传的菜，随时能改')
})

it('打卡块的张数只出现一处，且打卡墙入口在"连续打卡"同一行的右侧', async () => {  const FAMILY = {
    id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
    myRole: 'OWNER', myCapabilities: [], members: [],
  }
  mockGet(FAMILY)
  renderMine()

  // 入口与"连续打卡"同处一行（head 里）
  const head = (await screen.findByText(/连续打卡/)).closest('.me-checkin__head')
  expect(head).toBeTruthy()
  const link = screen.getByRole('link', { name: /去打卡墙看看/ })
  expect(link.getAttribute('href')).toBe('/checkins')
  expect(head!.contains(link)).toBe(true)

  // 张数只留热力图图例里那处（曾经同时挂着「共 N 张」和「全家一起攒了 M 张」，三个数字互相打架）
  const counts = screen.getAllByText(/共 \d+ 张/)
  expect(counts).toHaveLength(1)
  expect(counts[0].textContent).toContain('1 天有打卡')
  expect(screen.queryByText(/全家一起攒了/)).toBeNull()
})

it('邮箱清空时传 null（解绑），不是空字符串', async () => {
  const patch = vi
    .spyOn(apiClient, 'patch')
    .mockResolvedValue({ data: { ...ME, email: null } } as never)
  await openEditor()

  fireEvent.change(screen.getByDisplayValue('mama@example.com'), { target: { value: '  ' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/auth/me', expect.objectContaining({ email: null })),
  )
})

/*
 * 「我的设置」这一段的口径（用户 2026-10-13：「口味与忌口和我的设置中的重复了，
 * 保留我的设置中的」「下面又有一堆菜单，太乱了」）。
 *
 * 要盯住两件事：
 * ① **口味与忌口只有一个入口**（原来「我的菜」下面还独立成一节，两个入口说同一件事）；
 * ② **设置行要么能点、要么明说还没做**——改前「AI 设置」那两行带箭头却点了没反应，
 *    而 AI 根本是部署时用 .env 配的（D-009），用户改不了。
 */
it('口味与忌口只有一个入口（在「我的设置」里），且它真的能点', async () => {
  renderMine()

  const links = await screen.findAllByRole('link', { name: /口味/ })
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href')).toBe('/taste')
  // 副标题说清现状（几项忌口 / 几位家人还没写），不是一个箭头了事
  expect(links[0].className).toContain('row')
})

it('设置里不画点不动的箭头：没做的功能标「还没做」，AI 设置整节不再出现', async () => {
  renderMine()
  await screen.findByRole('link', { name: /口味/ })

  // 消息提醒（M10）还没做：留一行说明，但**不是链接、没有箭头**，而是一颗「还没做」
  const soon = screen.getByText('家庭消息提醒').closest('.row') as HTMLElement
  expect(soon.className).toContain('row--soon')
  expect(soon.querySelector('.row__arrow')).toBeNull()
  expect(soon.querySelector('.row__tag')?.textContent).toBe('还没做')
  expect(soon.closest('a')).toBeNull()

  // AI 是部署时配的（.env / D-009），界面上没有可改的东西 —— 那两行连同整节都下线了
  expect(screen.queryByText('AI 模型配置')).toBeNull()
  expect(screen.queryByText('提示词模板')).toBeNull()
  expect(screen.queryByText('AI 设置')).toBeNull()
})
