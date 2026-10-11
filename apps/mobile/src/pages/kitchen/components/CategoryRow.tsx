interface CategoryRowProps {
  categories: string[]
  onSelect: (category: string) => void
}

/** 分类标签来自 API，沿用五个笔绘分类按钮作为中性入口。 */
export default function CategoryRow({ categories, onSelect }: CategoryRowProps) {
  return (
    <div className="cats">
      {categories.slice(0, 5).map((category, index) => (
        <button key={category} type="button" className="cats__item" onClick={() => onSelect(category)}>
          <img src={`/img/cat-${index + 1}.png`} alt="" />
          <span>{category}</span>
        </button>
      ))}
    </div>
  )
}
