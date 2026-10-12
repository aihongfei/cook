// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import ForgotPasswordPage from './ForgotPasswordPage'
import ResetPasswordPage from './ResetPasswordPage'

// 找回密码（F2-04）：申请时**不泄漏邮箱是否存在**、重置时先挡下"两次输入不一致"。

const clients: QueryClient[] = []

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/forgot" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<h1>回来啦</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('申请重置：邮箱不存在时也提示同样的话（不泄漏账号是否存在）', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { sent: true } } as never)
  renderAt('/forgot')

  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'nobody@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: '发送重设链接' }))

  expect(await screen.findByText(/如果这个邮箱绑过账号，重设链接已经发出去了/)).toBeTruthy()
  expect(post).toHaveBeenCalledWith('/auth/password/forgot', { email: 'nobody@example.com' })
  // 邮箱不存在时后端不返回 devResetUrl，页面也就不该出现开发链接
  expect(screen.queryByText(/开发模式/)).toBeNull()
})

it('开发期（console 邮件）把重置链接显示出来，方便本机联调', async () => {
  vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: { sent: true, devResetUrl: 'http://127.0.0.1:5173/reset-password?token=abc' },
  } as never)
  renderAt('/forgot')

  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'mama@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: '发送重设链接' }))

  expect(await screen.findByText(/开发模式/)).toBeTruthy()
  expect(screen.getByRole('link', { name: /reset-password\?token=abc/ })).toBeTruthy()
})

it('重置页没有令牌时提示从邮件进来，且不发请求', async () => {
  const post = vi.spyOn(apiClient, 'post')
  renderAt('/reset-password')

  expect(await screen.findByText('链接不对')).toBeTruthy()
  expect(post).not.toHaveBeenCalled()
})

it('两次输入不一致时不发请求，直接在本地拦下', async () => {
  const post = vi.spyOn(apiClient, 'post')
  renderAt('/reset-password?token=tok-1')

  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'cook2026pass' } })
  fireEvent.change(screen.getByLabelText('再输一次'), { target: { value: 'cook2026pass2' } })
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))

  expect(await screen.findByText('两次输入的密码不一样')).toBeTruthy()
  expect(post).not.toHaveBeenCalled()
})

it('重置成功后提示旧密码已失效', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { ok: true } } as never)
  renderAt('/reset-password?token=tok-1')

  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'cook2026pass' } })
  fireEvent.change(screen.getByLabelText('再输一次'), { target: { value: 'cook2026pass' } })
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))

  expect(await screen.findByText('改好了')).toBeTruthy()
  await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/password/reset', { token: 'tok-1', password: 'cook2026pass' }))
})
