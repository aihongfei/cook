import { categoryIcon } from './category-icons'

interface CategoryRowProps {
  categories: string[]
  onSelect: (category: string) => void
}

/** 厨房页顶部的品类入口：图文对应见 category-icons.ts */
export default function CategoryRow({ categories, onSelect }: CategoryRowProps) {
  return (
    <div className="cats">
      {categories.slice(0, 5).map((category) => (
        <button key={category} type="button" className="cats__item" onClick={() => onSelect(category)}>
          <img src={categoryIcon(category)} alt="" />
          <span>{category}</span>
        </button>
      ))}
    </div>
  )
}
