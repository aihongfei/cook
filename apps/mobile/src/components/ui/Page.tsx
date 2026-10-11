import type { PropsWithChildren } from 'react'
import './ui.scss'

/**
 * 页面容器：统一底部留白。
 * 需要通栏内容（如 hero 插画）时直接用；局部需要 16px 栏距时包一层 <div className="pad">。
 */
export default function Page({ children }: PropsWithChildren) {
  return <div className="page">{children}</div>
}
