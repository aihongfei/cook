import { categories } from '@/data/demo'

interface CategoryRowProps {
  activeId?: string
  onSelect?: (id: string) => void
}

/** 分类入口：5 个独立按钮，图标是笔绘水彩方块（cat-1..5.png），标签是手写字体真实文字 */
export default function CategoryRow({ activeId, onSelect }: CategoryRowProps) {
  return (
    <div className="cats">
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`cats__item${c.id === activeId ? ' is-active' : ''}`}
          aria-pressed={c.id === activeId}
          onClick={() => onSelect?.(c.id)}
        >
          <img src={c.image} alt="" />
          <span>{c.name}</span>
        </button>
      ))}
    </div>
  )
}
