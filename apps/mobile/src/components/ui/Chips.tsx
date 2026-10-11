import './ui.scss'

export interface ChipItem {
  id: string
  label: string
  /** 可选的计数，显示在标签后（如「全部 2」） */
  count?: number
}

interface ChipsProps {
  items: readonly ChipItem[]
  value: string
  onChange: (id: string) => void
}

/** 横向滚动的筛选胶囊组 */
export default function Chips({ items, value, onChange }: ChipsProps) {
  return (
    <div className="chips">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`chip${item.id === value ? ' is-active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {typeof item.count === 'number' ? ` ${item.count}` : ''}
        </button>
      ))}
    </div>
  )
}
