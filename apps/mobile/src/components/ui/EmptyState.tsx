import './ui.scss'

interface EmptyStateProps {
  /** 占位插画（emoji 或后续换成笔绘 SVG） */
  emoji?: string
  title: string
  desc?: string
}

/** 列表空态：插画 + 一句引导文案 */
export default function EmptyState({ emoji = '🍽️', title, desc }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__emoji">{emoji}</div>
      <div className="empty__title">{title}</div>
      {desc && <div className="empty__desc">{desc}</div>}
    </div>
  )
}
