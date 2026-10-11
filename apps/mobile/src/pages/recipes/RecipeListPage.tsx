import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { recipeErrorMessage, useRecipeFilters as useFilterOptions, useRecipes } from '@/api/recipes'
import FilterTabs from '@/components/ui/FilterTabs'
import Page from '@/components/ui/Page'
import { useRecipeFilters } from '@/stores/recipe-filters'
import DishCard from '@/pages/kitchen/components/DishCard'
import RecipeStatus from './components/RecipeStatus'
import './recipes.scss'

export default function RecipeListPage() {
  const [params, setParams] = useSearchParams()
  const preferences = useRecipeFilters()
  const q = params.get('q') || ''
  const category = params.get('category') ?? preferences.category
  const cuisine = params.get('cuisine') ?? preferences.cuisine
  const [input, setInput] = useState(q)
  const [composing, setComposing] = useState(false)
  const filters = useFilterOptions()
  const recipes = useRecipes({ q, category, cuisine })
  const sentinel = useRef<HTMLDivElement>(null)
  const items = recipes.data?.pages.flatMap((page) => page.items) || []
  const total = recipes.data?.pages[0]?.total || 0

  // URL 入口优先；只持久化品类与菜系，搜索词不会进入本地存储。
  useEffect(() => {
    if (params.has('category')) preferences.setCategory(params.get('category') || '')
    if (params.has('cuisine')) preferences.setCuisine(params.get('cuisine') || '')
  }, [params, preferences.setCategory, preferences.setCuisine])

  useEffect(() => { setInput(q) }, [q])

  const updateSearch = (next: { q?: string; category?: string; cuisine?: string }, replace = false) => {
    const values = { q, category, cuisine, ...next }
    const updated = new URLSearchParams()
    if (values.q.trim()) updated.set('q', values.q.trim())
    if (values.category) updated.set('category', values.category)
    if (values.cuisine) updated.set('cuisine', values.cuisine)
    setParams(updated, { replace })
  }

  useEffect(() => {
    if (composing || input.trim() === q) return
    const timer = window.setTimeout(() => {
      const updated = new URLSearchParams(params)
      if (input.trim()) updated.set('q', input.trim())
      else updated.delete('q')
      setParams(updated, { replace: true })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [input, composing, q, params, setParams])

  useEffect(() => {
    const target = sentinel.current
    if (!target || !recipes.hasNextPage || recipes.isFetching || recipes.isFetchNextPageError || !window.IntersectionObserver) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void recipes.fetchNextPage()
    }, { root: target.closest('.tab-layout__body'), rootMargin: '160px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [recipes.hasNextPage, recipes.isFetching, recipes.isFetchNextPageError, recipes.fetchNextPage, items.length])

  const reset = () => {
    preferences.reset()
    setInput('')
    setParams(new URLSearchParams())
  }

  return (
    <Page>
      <div className="recipes-page">
        <header className="recipes-heading">
          <Link to="/kitchen" className="recipe-back">← 厨房</Link>
          <h1>菜谱小书</h1>
          <p>一菜一味，把日子煮得暖暖的</p>
        </header>
        <form className="recipes-search" role="search" onSubmit={(event) => {
          event.preventDefault()
          if (!composing) updateSearch({ q: input }, true)
        }}>
          <input
            type="search"
            aria-label="搜索菜名、食材、口味或标签"
            placeholder="搜菜名、食材、口味、标签…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            enterKeyHint="search"
          />
          <button type="submit">搜索</button>
        </form>
        <section className="recipes-filters" aria-label="菜谱筛选">
          <div className="recipes-filters__heading"><span>按口味翻一翻</span><button type="button" onClick={reset}>清除搜索与筛选</button></div>
          {filters.isPending && <RecipeStatus title="分类加载中…" loading />}
          {filters.isError && <RecipeStatus title="筛选分类加载失败" onRetry={() => { void filters.refetch() }}>{recipeErrorMessage(filters.error)}</RecipeStatus>}
          {filters.data && <>
            <span className="recipes-filters__label">品类</span>
            <FilterTabs
              items={[{ key: '', title: '全部品类' }, ...Array.from(new Set([...filters.data.categories, ...(category ? [category] : [])])).map((key) => ({ key, title: key }))]}
              activeKey={category}
              onChange={(key) => { preferences.setCategory(key); updateSearch({ category: key }) }}
            />
            <span className="recipes-filters__label">菜系</span>
            <FilterTabs
              items={[{ key: '', title: '全部菜系' }, ...Array.from(new Set([...filters.data.cuisines, ...(cuisine ? [cuisine] : [])])).map((key) => ({ key, title: key }))]}
              activeKey={cuisine}
              onChange={(key) => { preferences.setCuisine(key); updateSearch({ cuisine: key }) }}
            />
          </>}
        </section>
        <div className="recipes-count" aria-live="polite">
          {recipes.data ? `共 ${total} 道（已显示 ${items.length}）` : '正在翻开菜谱…'}
          {recipes.isFetching && !recipes.isPending && !recipes.isFetchingNextPage && <span> 更新中…</span>}
        </div>
        {recipes.isPending && <RecipeStatus title="正在取回菜谱…" loading>给小厨房一点时间</RecipeStatus>}
        {recipes.isError && !recipes.data && <RecipeStatus title="菜谱加载失败" onRetry={() => { void recipes.refetch() }}>{recipeErrorMessage(recipes.error)}</RecipeStatus>}
        {recipes.isRefetchError && !recipes.isFetchNextPageError && recipes.data && <RecipeStatus title="菜谱更新失败，暂时保留上次结果" onRetry={() => { void recipes.refetch() }}>{recipeErrorMessage(recipes.error)}</RecipeStatus>}
        {recipes.isSuccess && items.length === 0 && <RecipeStatus title="还没有找到这道味道">试试别的菜名、食材，或清除筛选再看看。</RecipeStatus>}
        <div className="recipes-grid">{items.map((dish) => <DishCard key={dish.id} dish={dish} />)}</div>
        <div ref={sentinel} className="recipes-sentinel" aria-hidden="true" />
        {recipes.isFetchNextPageError && <RecipeStatus title="后面的菜谱加载失败" onRetry={() => { void recipes.fetchNextPage() }}>{recipeErrorMessage(recipes.error)}</RecipeStatus>}
        {recipes.hasNextPage && <button className="recipe-button recipes-more" type="button" disabled={recipes.isFetching} onClick={() => { void recipes.fetchNextPage() }}>
          {recipes.isFetchingNextPage ? '更多菜谱加载中…' : '再翻一页'}
        </button>}
        {items.length > 0 && !recipes.hasNextPage && <p className="recipes-end">这一页的味道，都在这里了</p>}
      </div>
    </Page>
  )
}
