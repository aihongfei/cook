import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useFavoriteStatus, useToggleFavorite } from '@/api/favorites'
import { recipeErrorMessage, useRecipeFilters as useFilterOptions, useRecipes } from '@/api/recipes'
import FilterTabs from '@/components/ui/FilterTabs'
import SwipePager from '@/components/ui/SwipePager'
import CornerArt from '@/components/ui/CornerArt'
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

  const reset = () => {
    preferences.reset()
    setInput('')
    setParams(new URLSearchParams())
  }

  /*
   * 品类的 tab 列表（"全部品类" + 接口给的分类）：**既是 tab 条的数据，也是滑动切换的 keys**。
   * 提出来算一次是因为两处都要用它——分别算两遍迟早会分叉（一处记得"当前分类不在列表里就补一个"、
   * 另一处忘了，滑动就会切到一个列表里没有的 key）。
   */
  const categoryTabs = [
    { key: '', title: '全部品类' },
    ...(filters.data
      ? Array.from(new Set([...filters.data.categories, ...(category ? [category] : [])])).map((key) => ({ key, title: key }))
      : []),
  ]
  return (
    <Page>
      <div className="recipes-page">
        <header className="recipes-heading">
          <CornerArt name="recipes" />
          <Link to="/kitchen" className="page-back">← 厨房</Link>
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
              items={categoryTabs}
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
        {/* 栅格是"品类"那一组的翻页面（见上面那段注释）：左右划动＝换一个品类 */}
        <SwipePager
          keys={categoryTabs.map((tab) => tab.key)}
          activeKey={category}
          onChange={(key) => { preferences.setCategory(key); updateSearch({ category: key }) }}
          renderPanel={(key) => <CategoryPanel q={q} cuisine={cuisine} category={key} />}
        />
      </div>
    </Page>
  )
}

/**
 * 一个品类一页（用户 2026-10-15：「要跟随手指拖动，滑到中间时，两个页是都能看见的」）。
 *
 * 为什么每页各自取数、而不是"页面上取一次、切页时换筛选值"：跟手拖动到一半时，
 * 邻页的卡片必须**当场**画得出来。共用一次请求的话，那半页只能是一段"正在取回菜谱…"，
 * 翻起来像坏了。各自取数还有一个好处：react-query 按品类缓存，来回翻第二趟就是现成的。
 *
 * 无限滚动那套（哨兵 + `root: 最近的滚动容器`）**原样**跟着卡片走：
 * 页被挪进 `.swipe-pager__panel` 之后，`closest('.tab-layout__body')` 还是同一个容器
 * （邻居页被 `overflow-x: clip` 剪在屏外，视口判定里不算"相交"，所以它在屏外时不会误触发）。
 */
function CategoryPanel({ q, cuisine, category }: { q: string; cuisine: string; category: string }) {
  const recipes = useRecipes({ q, category, cuisine })
  const sentinel = useRef<HTMLDivElement>(null)
  const items = recipes.data?.pages.flatMap((page) => page.items) || []
  const total = recipes.data?.pages[0]?.total || 0

  /*
   * 收藏（F1-09）：**一屏一次问清**（不是每张卡各查各的——12 张卡就是 12 个请求）。
   * 没登录时这个 hook 自己不发请求（后端会 401），也就不传 `onToggleFavorite`，卡片不画心。
   */
  const favoriteStatus = useFavoriteStatus(items.map((dish) => dish.id))
  const toggleFavorite = useToggleFavorite()

  useEffect(() => {
    const target = sentinel.current
    if (!target || !recipes.hasNextPage || recipes.isFetching || recipes.isFetchNextPageError || !window.IntersectionObserver) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void recipes.fetchNextPage()
    }, { root: target.closest('.tab-layout__body'), rootMargin: '160px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [recipes.hasNextPage, recipes.isFetching, recipes.isFetchNextPageError, recipes.fetchNextPage, items.length])

  return (
    <>
      <div className="recipes-count" aria-live="polite">
        {recipes.data ? `共 ${total} 道（已显示 ${items.length}）` : '正在翻开菜谱…'}
        {recipes.isFetching && !recipes.isPending && !recipes.isFetchingNextPage && <span> 更新中…</span>}
      </div>
      {recipes.isPending && <RecipeStatus title="正在取回菜谱…" loading>给小厨房一点时间</RecipeStatus>}
      {recipes.isError && !recipes.data && <RecipeStatus title="菜谱加载失败" onRetry={() => { void recipes.refetch() }}>{recipeErrorMessage(recipes.error)}</RecipeStatus>}
      {recipes.isRefetchError && !recipes.isFetchNextPageError && recipes.data && <RecipeStatus title="菜谱更新失败，暂时保留上次结果" onRetry={() => { void recipes.refetch() }}>{recipeErrorMessage(recipes.error)}</RecipeStatus>}
      {recipes.isSuccess && items.length === 0 && <RecipeStatus title="还没有找到这道味道">试试别的菜名、食材，或清除筛选再看看。</RecipeStatus>}
      <div className="recipes-grid">
        {items.map((dish) => (
          <DishCard
            key={dish.id}
            dish={dish}
            favorited={Boolean(favoriteStatus.data?.[dish.id])}
            onToggleFavorite={favoriteStatus.signedIn ? () => toggleFavorite.mutate(dish.id) : undefined}
          />
        ))}
      </div>
      <div ref={sentinel} className="recipes-sentinel" aria-hidden="true" />
      {recipes.isFetchNextPageError && <RecipeStatus title="后面的菜谱加载失败" onRetry={() => { void recipes.fetchNextPage() }}>{recipeErrorMessage(recipes.error)}</RecipeStatus>}
      {recipes.hasNextPage && <button className="recipe-button recipes-more" type="button" disabled={recipes.isFetching} onClick={() => { void recipes.fetchNextPage() }}>
        {recipes.isFetchingNextPage ? '更多菜谱加载中…' : '再翻一页'}
      </button>}
      {items.length > 0 && !recipes.hasNextPage && <p className="recipes-end">这一页的味道，都在这里了</p>}
    </>
  )
}
