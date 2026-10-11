import { useState } from 'react'
import { FilterIcon, SearchIcon } from '@/components/icons/TabIcons'

interface SearchBarProps {
  placeholder?: string
  onFilterClick?: () => void
  onSearch: (query: string) => void
}

/** 厨房搜索以提交进入列表，输入过程中不切换页面。 */
export default function SearchBar({
  placeholder = '搜菜名、食材、口味…',
  onFilterClick,
  onSearch,
}: SearchBarProps) {
  const [query, setQuery] = useState('')
  return (
    <form className="search" role="search" onSubmit={(event) => { event.preventDefault(); onSearch(query) }}>
      <div className="search__box">
        <SearchIcon width={16} height={16} color="#B08C6C" />
        <input
          className="search__input"
          type="search"
          aria-label="搜索菜谱"
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          enterKeyHint="search"
        />
        <button type="submit" className="search__submit">搜索</button>
        <button type="button" className="search__filter" onClick={onFilterClick} aria-label="筛选菜谱">
          <FilterIcon width={18} height={18} />
        </button>
      </div>
    </form>
  )
}
