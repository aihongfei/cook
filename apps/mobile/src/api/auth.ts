import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, type AuthUser } from '@/stores/auth'
import { apiClient, refreshSession } from './client'

export type { AuthUser }

export interface AuthResult {
  token: string
  refreshToken: string
  expiresIn: number
  user: AuthUser
}

export interface RegisterInput {
  account: string
  password: string
  nickname?: string
  avatar?: string
  /** 选填：填了就用于日后找回密码（F2-04） */
  email?: string
}

export interface AuthOptions {
  accountMaxLength: number
  passwordMinLength: number
  passwordMaxLength: number
  avatars: string[]
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const { data } = await apiClient.post<AuthResult>('/auth/register', input)
  return data
}

export async function login(input: { account: string; password: string }): Promise<AuthResult> {
  const { data } = await apiClient.post<AuthResult>('/auth/login', input)
  return data
}

/** 退出登录：先让后端吊销刷新令牌，再清本地（后端失败也要清本地，否则用户"退不出去"） */
export async function logout(): Promise<void> {
  const { refreshToken } = useAuth.getState()
  try {
    await apiClient.post('/auth/logout', { refreshToken })
  } catch {
    // 网络不通/令牌已失效都视为已退出
  } finally {
    useAuth.getState().clear()
  }
}

export async function fetchMe(): Promise<AuthUser> {
  const { data } = await apiClient.get<AuthUser>('/auth/me')
  return data
}

export async function updateProfile(input: { nickname?: string; avatar?: string; email?: string | null }): Promise<AuthUser> {
  const { data } = await apiClient.patch<AuthUser>('/auth/me', input)
  return data
}

export interface ForgotResult {
  sent: boolean
  /** 仅开发期（MAIL_TRANSPORT=console）返回，方便本机联调；真发信时后端不会带这个字段 */
  devResetUrl?: string
}

export async function requestPasswordReset(email: string): Promise<ForgotResult> {
  const { data } = await apiClient.post<ForgotResult>('/auth/password/forgot', { email })
  return data
}

export async function resetPassword(input: { token: string; password: string }): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>('/auth/password/reset', input)
  return data
}

export function useRequestPasswordReset() {
  return useMutation({ mutationFn: requestPasswordReset })
}

export function useResetPassword() {
  return useMutation({ mutationFn: resetPassword })
}

export async function fetchAuthOptions(): Promise<AuthOptions> {
  const { data } = await apiClient.get<AuthOptions>('/auth/options')
  return data
}

/** 当前账号（未登录不请求）；成功后写回 store，保证界面与后端一致 */
export function useMe() {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      const user = await fetchMe()
      useAuth.getState().setUser(user)
      return user
    },
    enabled: Boolean(token),
    staleTime: 5 * 60_000,
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: login,
    onSuccess: (result) => {
      useAuth.getState().setSession(result)
      queryClient.setQueryData(['auth', 'me'], result.user)
    },
  })
}

export function useRegister() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: register,
    onSuccess: (result) => {
      useAuth.getState().setSession(result)
      queryClient.setQueryData(['auth', 'me'], result.user)
    },
  })
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateProfile,
    onSuccess: (user) => {
      useAuth.getState().setUser(user)
      queryClient.setQueryData(['auth', 'me'], user)
    },
  })
}

export function useAuthOptions() {
  return useQuery({ queryKey: ['auth', 'options'], queryFn: fetchAuthOptions, staleTime: 60 * 60_000 })
}

/** 供测试与调试：主动续期一次 */
export { refreshSession }
