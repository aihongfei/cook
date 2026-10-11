import './ui.scss'

interface SectionTitleProps {
  title: string
  /** 右侧说明或操作文案 */
  more?: string
  onMoreClick?: () => void
}

/** 区块标题：手绘小箭头装饰 + 右侧「全部 ›」 */
export default function SectionTitle({ title, more, onMoreClick }: SectionTitleProps) {
  return (
    <div className="section-title">
      <div className="section-title__text">
        <span className="section-title__orn">❯❯</span>
        {title}
      </div>
      {more && (
        <button type="button" className="section-title__more" onClick={onMoreClick}>
          {more} <span>→</span>
        </button>
      )}
    </div>
  )
}
