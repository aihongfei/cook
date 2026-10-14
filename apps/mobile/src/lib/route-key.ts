import { useContext } from 'react'
import { UNSAFE_LocationContext } from 'react-router-dom'

/**
 * 当前地址的 `key`（换页判据），**没有路由也能用**。
 *
 * 为什么不用 `useLocation()`：`ImageViewer` / `ConfirmDialog` 是通用 UI 组件，
 * 单独渲染（比如组件测试里）时不该因为"没有路由上下文"而抛错——
 * 它们要的只是"地址变了没有"这一件事，而没有路由时答案就是"没变"。
 *
 * `UNSAFE_LocationContext` 的值形如 `{ location, navigationType }`，默认 `null`。
 * 名字里的 UNSAFE 指的是它的**形状可能变**（不是"危险"）：这里只读 `key` 一个字段，
 * 升级 react-router 时跟着改一处即可（同一个上下文 `KeepAlivePages` 也在用，那一处更关键）。
 */
export function useRouteKey(): string | null {
  const context = useContext(UNSAFE_LocationContext) as { location?: { key?: string } } | null
  return context?.location?.key ?? null
}
