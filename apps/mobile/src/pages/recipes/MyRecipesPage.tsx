import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { recipeErrorMessage, useRecipes } from '@/api/recipes'
import EmptyState from '@/components/ui/EmptyState'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { readBackLink } from '@/pages/back-link'
import DishCard from '@/pages/kitchen/components/DishCard'
import RecipeStatus from './components/RecipeStatus'
import '../shared.scss'
import './recipes.scss'

/**
 * 我的菜谱（F1-12）：这个家自己上传的那些。
 *
 * 与菜谱小书的区别不是"筛选了一下"，而是**这一页上的东西都能改**。
 * 所以卡片沿用同一张（翻菜的手感一致），编辑入口留在详情页——
 * 列表上每张卡再摆两个动作，会让"点卡片进去看做法"这件最常做的事变得不敢点。
 *
 * 分页沿用列表接口那一套（`useRecipes` + 哨兵滚动加载），没有另写一个"我的"接口：
 * 后端给的是同一个列表的 `mine=1` 视图，前端再包一层只会多一处要跟着改的契约。
 */
export default function MyRecipesPage() {
  const location = useLocation()
  const back = readBackLink(location.state, '/mine')
  const recipes = useRecipes({ mine: true })
  const sentinel = useRef<HTMLDivElement>(null)
  const items = recipes.data?.pages.flatMap((page) => page.items) || []
  const total = recipes.data?.pages[0]?.total || 0
  /*
   * 先取出来再进 effect：依赖里写 `recipes.xxx` 的话，linter 只看见"用了 recipes 这个对象"
   * 而依赖表里没有它，于是每改一次这里就报一次 warning（菜谱小书那页就是这么留下的）。
   */
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = recipes

  // 哨兵滚进视野就取下一页（与菜谱小书同一套：根节点是 tab-layout 的滚动区，不是 window）
  useEffect(() => {
    const target = sentinel.current
    if (!target || !hasNextPage || isFetching || isFetchNextPageError || !window.IntersectionObserver) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void fetchNextPage()
    }, { root: target.closest('.tab-layout__body'), rootMargin: '160px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, items.length])

  return (
    <Page>
      <div className="pscreen my-recipes">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="我的菜谱" subtitle="自己上传的菜，随时能改" art="recipes" />

        <div className="my-recipes__top">
          <Link className="my-recipes__new" to="/recipes/new">＋ 新建菜谱</Link>
          {recipes.data && <span className="my-recipes__count">共 {total} 道</span>}
        </div>

        {recipes.isPending && (
          <RecipeStatus title="正在找你自己传的菜…" loading>马上就好</RecipeStatus>
        )}
        {recipes.isError && !recipes.data && (
          <RecipeStatus title="你的菜谱暂时打不开" onRetry={() => { void recipes.refetch() }}>
            {recipeErrorMessage(recipes.error)}
          </RecipeStatus>
        )}
        {recipes.isRefetchError && recipes.data && (
          <RecipeStatus title="更新失败，暂时保留上次内容" onRetry={() => { void recipes.refetch() }}>
            {recipeErrorMessage(recipes.error)}
          </RecipeStatus>
        )}

        {/* 空态要给**下一步**而不只是"没有东西"：这一页的价值就是往里加第一道菜 */}
        {recipes.isSuccess && items.length === 0 && (
          <div className="my-recipes__empty">
            <EmptyState
              emoji="📝"
              title="还没有自己上传的菜谱"
              desc="把家里的拿手菜写下来，下次谁问起就直接翻给他看。"
            />
            <Link className="recipe-button my-recipes__empty-go" to="/recipes/new">
              写下第一道菜
            </Link>
          </div>
        )}

        <div className="recipes-grid">
          {items.map((dish) => (
            <DishCard key={dish.id} dish={dish} />
          ))}
        </div>

        <div ref={sentinel} className="recipes-sentinel" aria-hidden="true" />
        {recipes.isFetchNextPageError && (
          <RecipeStatus title="后面的菜谱加载失败" onRetry={() => { void recipes.fetchNextPage() }}>
            {recipeErrorMessage(recipes.error)}
          </RecipeStatus>
        )}
        {items.length > 0 && !recipes.hasNextPage && (
          <p className="recipes-end">你们家的味道，都在这儿了</p>
        )}
      </div>
    </Page>
  )
}
