// @vitest-environment jsdom
import { AxiosError } from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient, apiErrorMessage, refreshSession } from '@/api/client'
import { useAuth } from '@/stores/auth'
import LoginPage from './LoginPage'
import RegisterPage from './RegisterPage'

// M2 的判定核心：未登录进不去、登录成功进厨房、令牌过节能自动续期、退出后回到登录页。
// 这些都用真实的路由与 store 行为验证，只把网络层替换成假的。

const clients: QueryClient[] = []

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/kitchen" element={<h1>厨房</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it('登录成功后写入登录态并跳转到厨房', async () => {
  vi.spyOn(apiClient, 'post').mockResolvedValue({
    data: {
      token: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 7200,
      user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🐰', email: null, createdAt: new Date().toISOString() },
    },
  } as never)

  renderAt('/login')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mama' } })
  fireEvent.change(screen.getByPlaceholderText('至少 8 位，含字母与数字'), { target: { value: 'cook2026pass' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))

  await waitFor(() => expect(screen.getByText('厨房')).toBeTruthy())
  expect(useAuth.getState().token).toBe('access-1')
  expect(useAuth.getState().user?.nickname).toBe('妈妈')
})

it('账号或密码错误时显示后端给的文案，且不写入登录态', async () => {
  // 用真实的 AxiosError（带 response），而不是手搓对象——否则 isAxiosError 不认
  const error = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 401, statusText: 'Unauthorized', data: { message: '账号或密码不对' }, headers: {}, config: {} as never,
  })
  vi.spyOn(apiClient, 'post').mockRejectedValue(error as never)

  renderAt('/login')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mama' } })
  fireEvent.change(screen.getByPlaceholderText('至少 8 位，含字母与数字'), { target: { value: 'wrongpass1' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))

  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('账号或密码不对'))
  expect(useAuth.getState().token).toBeNull()
})

it('注册时两次密码不一致直接拦下，不发请求', () => {
  const post = vi.spyOn(apiClient, 'post')
  renderAt('/register')

  fireEvent.change(screen.getByPlaceholderText(/手机号 \/ 邮箱 \/ 自定账号/), { target: { value: 'papa01' } })
  fireEvent.change(screen.getByPlaceholderText(/位，含字母与数字/), { target: { value: 'cook2026pass' } })
  fireEvent.change(screen.getByPlaceholderText('确认密码'), { target: { value: 'cook2026other' } })
  fireEvent.click(screen.getByRole('button', { name: '创建账号' }))

  expect(screen.getByRole('alert').textContent).toBe('两次输入的密码不一样')
  expect(post).not.toHaveBeenCalled()
})

it('已登录访问登录页会直接进厨房（不会绕回登录）', () => {
  useAuth.getState().setSession({
    token: 'access-1', refreshToken: 'refresh-1',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🐰', email: null, createdAt: new Date().toISOString() },
  })
  renderAt('/login')
  expect(screen.getByText('厨房')).toBeTruthy()
})

it('刷新令牌可用时自动续期并更新登录态', async () => {
  useAuth.getState().setSession({
    token: 'expired', refreshToken: 'refresh-1',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🐰', email: null, createdAt: new Date().toISOString() },
  })
  // refreshSession 走裸 axios（不带拦截器），这里替换全局实现的 post
  const axios = await import('axios')
  vi.spyOn(axios.default, 'post').mockResolvedValue({ data: { token: 'access-2', refreshToken: 'refresh-2' } } as never)

  const token = await refreshSession()
  expect(token).toBe('access-2')
  expect(useAuth.getState().token).toBe('access-2')
  expect(useAuth.getState().refreshToken).toBe('refresh-2')
})

it('刷新失败时清空登录态（守卫据此跳登录页）', async () => {
  useAuth.getState().setSession({
    token: 'expired', refreshToken: 'stale',
    user: { id: 'u1', account: 'mama', nickname: '妈妈', avatar: '🐰', email: null, createdAt: new Date().toISOString() },
  })
  const axios = await import('axios')
  vi.spyOn(axios.default, 'post').mockRejectedValue(new Error('401') as never)

  const token = await refreshSession()
  expect(token).toBeNull()
  expect(useAuth.getState().token).toBeNull()
  expect(useAuth.getState().user).toBeNull()
})

it('没有刷新令牌时不发请求', async () => {
  const axios = await import('axios')
  const post = vi.spyOn(axios.default, 'post')
  expect(await refreshSession()).toBeNull()
  expect(post).not.toHaveBeenCalled()
})

it('错误文案：限流与断网都给可读提示', () => {
  // 用例里必须带上后端**真实**的 message：
  // 之前这里用 data: {} 才让「429 先透传了 message」这个 bug 溜过去（真机上显示 ThrottlerException）
  expect(
    apiErrorMessage({ isAxiosError: true, response: { status: 429, data: { message: 'ThrottlerException: Too Many Requests' } } }),
  ).toBe('尝试太频繁了，请稍后再试')
  expect(apiErrorMessage({ isAxiosError: true, response: { status: 500, data: {} } })).toBe('厨房服务开小差了，请稍后再试')
  // 5xx 的异常类名不能原样给用户
  expect(
    apiErrorMessage({ isAxiosError: true, response: { status: 500, data: { message: 'PrismaClientKnownRequestError: boom' } } }),
  ).toBe('厨房服务开小差了，请稍后再试')
  // 业务错误（4xx）仍要按后端原话显示，例如账号密码不对
  expect(apiErrorMessage({ isAxiosError: true, response: { status: 401, data: { message: '账号或密码不对' } } })).toBe('账号或密码不对')
  expect(apiErrorMessage(new Error('boom'))).toBe('操作失败，请稍后再试')
})
