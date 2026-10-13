import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { useAuth } from '@/stores/auth'

/**
 * 统一 API 客户端（F0-09 / F2-02）。
 * - baseURL 来自环境变量 VITE_API_BASE_URL（见 .env.example）
 * - 请求自动带上 access token
 * - 遇 401 自动用 refresh token 续期一次并重放原请求；续期失败则清空登录态（路由守卫会跳登录页）
 */
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api',
  timeout: 15_000,
})

/** 登录相关接口本身不需要令牌，也不该触发续期（否则"密码输错"会被包装成"续期失败"的怪异提示） */
const AUTH_FREE = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/options']

function isAuthFree(url: string | undefined): boolean {
  return Boolean(url && AUTH_FREE.some((path) => url.startsWith(path)))
}

apiClient.interceptors.request.use((config) => {
  const token = useAuth.getState().token
  if (token && !isAuthFree(config.url)) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

/** 同一时刻只允许一次续期，其余请求排队等它（避免并发 401 把刷新令牌重复轮换掉） */
let refreshing: Promise<string | null> | null = null

export function refreshSession(): Promise<string | null> {
  const { refreshToken } = useAuth.getState()
  if (!refreshToken) return Promise.resolve(null)
  refreshing ??= (async () => {
    try {
      const { data } = await axios.post<{ token: string; refreshToken: string }>(
        `${apiClient.defaults.baseURL}/auth/refresh`,
        { refreshToken },
        { timeout: 15_000 },
      )
      useAuth.getState().setTokens({ token: data.token, refreshToken: data.refreshToken })
      return data.token
    } catch {
      // 刷新令牌也失效了：彻底退出，交给路由守卫跳登录页
      useAuth.getState().clear()
      return null
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

interface RetriableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined
    if (error.response?.status === 401 && config && !config._retried && !isAuthFree(config.url)) {
      config._retried = true
      const token = await refreshSession()
      if (token) {
        config.headers.Authorization = `Bearer ${token}`
        return apiClient.request(config)
      }
    }
    return Promise.reject(error)
  },
)

/** 后端健康检查响应 */
export interface HealthResponse {
  status: string
  uptime?: number
  timestamp?: string
}

/** 探测后端是否可用（设置页/开发期自检用） */
export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await apiClient.get<HealthResponse>('/health')
  return data
}

/**
 * Nest 在限流与 5xx 时会把异常类名直接放进 message（真机上抓到的是 `ThrottlerException: Too Many Requests`）。
 * 这类字符串是给开发者看的，不能原样显示给用户。
 */
const RAW_EXCEPTION_MESSAGE = /^[A-Za-z]+(Exception|Error)\b/

/** 把 axios 错误转成能直接给用户看的一句话（页面统一用它，不各自猜错误结构） */
export function apiErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) return '操作失败，请稍后再试'
  // 断网时没有 response，优先给网络提示
  if (!error.response) return '连不上厨房服务，请检查网络'
  // 限流必须先判：后端总会带 message，若先透传 message，这条友好文案永远走不到
  if (error.response.status === 429) return '尝试太频繁了，请稍后再试'
  /*
   * 413 单独判：这句正文是 **body-parser 的英文原文**（`request entity too large`），
   * 不带 `Exception`/`Error` 前缀，会从下面那条"透传 message"溜出去——用户在打卡墙上
   * 看到的就是一行英文（2026-10-14 真机截图）。
   *
   * 两个来源要分开说：**图片本身太大**（客户端压完还是超了）与**请求体超限**
   * （服务端上限配小了）。用户能做的动作不同——前者要换张图，后者只能等修（这里已修）。
   * 后端正常时走不到这条：请求能进业务层，会拿到「单张照片不能超过 8MB」那句中文。
   */
  if (error.response.status === 413) return '这张图太大了，换张小一点的再传'
  const message = (error.response.data as { message?: string | string[] } | undefined)?.message
  const text = Array.isArray(message) ? String(message[0] ?? '') : typeof message === 'string' ? message : ''
  if (text && !RAW_EXCEPTION_MESSAGE.test(text)) return text
  if (error.response.status >= 500) return '厨房服务开小差了，请稍后再试'
  return '操作失败，请稍后再试'
}
