import { FilterIcon, SearchIcon } from '@/components/icons/TabIcons'

interface SearchBarProps {
  placeholder?: string
  onFilterClick?: () => void
}

/** 圆角搜索条（后续接 M1 的菜谱搜索） */
export default function SearchBar({
  placeholder = '搜菜名、食材、口味…',
  onFilterClick,
}: SearchBarProps) {
  return (
    <div className="search">
      <div className="search__box">
        <SearchIcon width={16} height={16} color="#B08C6C" />
        <input className="search__input" placeholder={placeholder} readOnly />
        <button type="button" className="search__filter" onClick={onFilterClick} aria-label="筛选">
          <FilterIcon width={18} height={18} />
        </button>
      </div>
    </div>
  )
}
