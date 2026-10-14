import { useEffect, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { recipeErrorMessage, useRecipes } from '@/api/recipes'
import EmptyState from '@/components/ui/EmptyState'
import FilterTabs from '@/components/ui/FilterTabs'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { readBackLink } from '@/pages/back-link'
import DishCard from '@/pages/kitchen/components/DishCard'
import RecipeStatus from './components/RecipeStatus'
import FavoritesList from './components/FavoritesList'
import CookedList from './cooked/CookedList'
import '../shared.scss'
import './recipes.scss'

/**
 * 我的菜谱（F1-12 + F9-02，三视角见 D-076）。
 *
 * ## 为什么合成一页
 *
 * 原先"我的菜"在「我的」页下占了**两行**（我收藏的菜 / 我的菜谱），再加上新做的
 * 「我做过」就是三个入口——而它们回答的是**同一个问题**："我自己跟菜有关的那些"。
 * 收成一页三个 tab 之后：「我的」页一行进这儿，tab 之间切换不产生新的返回层级
 * （用户说"我想看看我收藏的"时不该先退回去再点另一行）。
 *
 * ## 三个 tab 的次序是刻意的
 *
 * **做过的 → 收藏的 → 原创的**：从"已经发生的事"到"打算做的事"再到"我自己写的"。
 * 「做过的」放第一是因为它是这次新做的、也是唯一带数字会长的那一个（F9-01）。
 *
 * ## 一个实现上的选择：tab 走 URL（`?tab=favorites`）
 *
 * 不用组件内 state：用户点进某道菜的详情、按返回时**要回到原来那个 tab**
 * （从「做过的」进去，退回来还该在「做过的」）。state 活不过路由跳转——
 * 这个项目在冰箱分区、口味页、「帮我决定」抽屉上各自踩过一次（D-066 / R-049 / R-055）。
 *
 * ## 只有"原创的"接无限滚动
 *
 * 另外两个是"有信号才出现"的短列表（后端一次给 30 条并带上线），只有自己上传的菜
 * 可能真有很多条，所以分页与哨兵只留在那一支里。
 */
const TABS = [
  { key: 'cooked', title: '做过的' },
  { key: 'favorites', title: '收藏的' },
  { key: 'mine', title: '原创的' },
] as const

type TabKey = (typeof TABS)[number]['key']

function isTabKey(value: string | null): value is TabKey {
  return value === 'cooked' || value === 'favorites' || value === 'mine'
}

export default function MyRecipesPage() {
  const location = useLocation()
  const back = readBackLink(location.state, '/mine')
  const [params, setParams] = useSearchParams()
  // 认不出的 tab 值一律落回第一个：URL 是不可信输入（用户可能手改、旧链接可能带着别的值）
  const raw = params.get('tab')
  const tab: TabKey = isTabKey(raw) ? raw : 'cooked'

  return (
    <Page>
      <div className="pscreen my-recipes">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="我的菜谱" subtitle="我做过、收藏和写下的菜" art="recipes" />

        {/*
          tab 状态进 URL（见文件头）。用 `replace` 而不是 push：在三个 tab 之间来回点
          不该在浏览器历史里堆一串记录（用户按返回时想回的是"上一页"，不是"上一个 tab"）。
        */}
        <FilterTabs
          items={TABS.map((item) => ({ key: item.key, title: item.title }))}
          activeKey={tab}
          onChange={(key) => setParams(key === 'cooked' ? {} : { tab: key }, { replace: true })}
        />

        {tab === 'cooked' && <CookedList from={`${location.pathname}${location.search}`} />}
        {tab === 'favorites' && <FavoritesList from={`${location.pathname}${location.search}`} />}
        {tab === 'mine' && <OwnRecipesList />}
      </div>
    </Page>
  )
}

/**
 * 原创的（F1-12）：这个家自己上传的那些。
 *
 * 与菜谱小书的区别不是"筛选了一下"，而是**这里的东西都能改**。
 * 所以卡片沿用同一张（翻菜的手感一致），编辑入口留在详情页——
 * 列表上每张卡再摆两个动作，会让"点卡片进去看做法"这件最常做的事变得不敢点。
 *
 * 分页沿用列表接口那一套（`useRecipes` + 哨兵滚动），没有另写一个"我的"接口：
 * 后端给的是同一个列表的 `mine=1` 视图，前端再包一层只会多一处要跟着改的契约。
 */
function OwnRecipesList() {
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
    <>
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
    </>
  )
}
