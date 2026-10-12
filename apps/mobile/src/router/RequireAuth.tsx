import type { PropsWithChildren } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/stores/auth'

/**
 * 路由守卫（F2-02）：未登录一律跳登录页，并记住原本想去的地址，登录后原路返回。
 * D-008 明确"未登录不可使用"，所以这里没有"游客可看"的白名单分支。
 */
export default function RequireAuth({ children }: PropsWithChildren) {
  const location = useLocation()
  const token = useAuth((state) => state.token)
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return <>{children}</>
}
