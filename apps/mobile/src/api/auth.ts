import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, type AuthUser } from '@/stores/auth'
import { useAiAssistantSession } from '@/stores/ai-assistant-session'
import { apiClient, refreshSession } from './client'
import { releasePatrol } from '@/lib/patrol-sync'

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
  const { refreshToken, user } = useAuth.getState()
  /*
   * **巡查令牌先交还**（M10 交付三）：它要凭登录态调，所以必须排在清会话之前。
   * 不交还的话，退出之后那台手机仍然每 15 分钟在后台取到"这家有什么提醒"——
   * 本地清了、服务端还认，那是没退干净（与下面 AI 对话同一类隐私问题）。
   * `releasePatrol` 自己吞掉网络错误，不阻塞退出。
   */
  if (user?.id) await releasePatrol(user.id)
  try {
    await apiClient.post('/auth/logout', { refreshToken })
  } catch {
    // 网络不通/令牌已失效都视为已退出
  } finally {
    useAuth.getState().clear()
    /*
     * **AI 助手的对话也一起清掉**（用户 2026-10-13：「会话历史也要保留」的对价）。
     *
     * 那些对话里有**这家冰箱的内容**（"记了酸奶""牛奶快到期了"）——同一台手机上换个账号
     * 登录就该是空白的。不清的话，上一个人退出了、下一个人点开悬浮球就看见别人家里有什么，
     * 这是实打实的隐私事故（比"历史丢了"严重得多）。所以这里不是"顺手清一下"，
     * 而是持久化这份历史的前提。
     */
    useAiAssistantSession.getState().clearAll()
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
