import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** 登录账号的公开信息（后端永不返回密码相关字段） */
export interface AuthUser {
  id: string
  account: string
  nickname: string
  avatar: string
  createdAt: string
}

interface AuthState {
  token: string | null
  refreshToken: string | null
  user: AuthUser | null
  /** 登录/注册成功后落一整份会话 */
  setSession: (session: { token: string; refreshToken: string; user: AuthUser }) => void
  /** 只更新用户信息（改资料、/auth/me 刷新） */
  setUser: (user: AuthUser) => void
  /** 刷新令牌轮换后更新令牌 */
  setTokens: (tokens: { token: string; refreshToken: string }) => void
  clear: () => void
}

/**
 * 登录态（F2-02）。
 *
 * 令牌持久化到 localStorage，所以刷新页面/重开 App 仍是登录状态（"自动登录"），
 * 前端同时用 access token（2 小时）+ refresh token（30 天）：过期时由 client.ts 自动续期。
 * 这说明里刻意写清一点：**本机存储的令牌只在自家 App 的 WebView 里使用**，
 * 页面不加载任何第三方脚本，XSS 面很小；真正的凭证校验始终在后端。
 */
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
      user: null,
      setSession: ({ token, refreshToken, user }) => set({ token, refreshToken, user }),
      setUser: (user) => set({ user }),
      setTokens: ({ token, refreshToken }) => set({ token, refreshToken }),
      clear: () => set({ token: null, refreshToken: null, user: null }),
    }),
    {
      name: 'yushan-auth',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
)

/** 是否已登录（路由守卫与页面共用） */
export const selectIsLoggedIn = (state: AuthState): boolean => Boolean(state.token)
