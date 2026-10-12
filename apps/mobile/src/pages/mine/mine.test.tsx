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

function mockGet() {
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
    if (url === '/family') return Promise.resolve({ data: null } as never)
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
