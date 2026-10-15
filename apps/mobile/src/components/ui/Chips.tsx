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

/**
 * 横向滚动的筛选胶囊组。
 *
 * `data-no-swipe`：这一行自己会横着滚（"看后面还有什么选项"），所以在它上面左右划动
 * **不该**被外层的翻页面当成"换一页"（见 `SwipePager` / `lib/tab-swipe.rules.ts`）。
 * 标记打在这个共享组件里，用它的页面不用记着加。
 */
export default function Chips({ items, value, onChange }: ChipsProps) {
  return (
    <div className="chips" data-no-swipe>
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
