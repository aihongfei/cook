import { Skeleton } from 'antd-mobile'

/** 骨架屏（F0-05）：列表/详情加载占位 */
export default function SkeletonBlock({
  rows = 3,
  withTitle = true,
}: {
  rows?: number
  withTitle?: boolean
}) {
  return (
    <div className="skeleton-block">
      {withTitle && <Skeleton.Title animated />}
      <Skeleton.Paragraph lineCount={rows} animated />
    </div>
  )
}
