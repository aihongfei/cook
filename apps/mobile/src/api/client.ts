import axios, { type AxiosError } from 'axios'

/**
 * 统一 API 客户端（F0-09）。
 * - baseURL 来自环境变量 VITE_API_BASE_URL（见 .env.example）
 * - 预留鉴权 token 注入与统一错误提示的拦截器位置
 */
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api',
  timeout: 15_000,
})

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('ys_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // 401 交给登录流程处理（M2 接入后补跳转）
    if (error.response?.status === 401) {
      localStorage.removeItem('ys_token')
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
