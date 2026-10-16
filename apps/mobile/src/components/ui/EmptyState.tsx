import Icon, { type IconName } from '@/components/icons/Icon'
import './ui.scss'

interface EmptyStateProps {
  /** 占位插画（手绘水彩图标，见 `components/icons/Icon.tsx`） */
  icon?: IconName
  title: string
  desc?: string
}

/** 列表空态：插画 + 一句引导文案 */
export default function EmptyState({ icon = 'plate', title, desc }: EmptyStateProps) {
  return (
    <div className="empty">
      {/*
       * 44px：空态是"这一页什么都没有"时的唯一主角，比行内的 16–20px 大一档。
       * 图标图是 128×128 的，放到 44 仍然锐利（高分屏 ×2 也够）。
       */}
      <div className="empty__icon">
        <Icon name={icon} size={44} />
      </div>
      <div className="empty__title">{title}</div>
      {desc && <div className="empty__desc">{desc}</div>}
    </div>
  )
}
