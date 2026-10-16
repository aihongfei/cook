import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { recipeErrorMessage, useDeleteRecipe, useRecipes, type RecipeSummary } from '@/api/recipes'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import FilterTabs from '@/components/ui/FilterTabs'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import SwipePager from '@/components/ui/SwipePager'
import { toast } from '@/components/ui/toast'
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

  /*
   * tab 状态进 URL（见文件头）。用 `replace` 而不是 push：在三个 tab 之间来回点
   * 不该在浏览器历史里堆一串记录（用户按返回时想回的是"上一页"，不是"上一个 tab"）。
   */
  const changeTab = (key: string) => setParams(key === 'cooked' ? {} : { tab: key }, { replace: true })

  return (
    /*
     * 「页头不动、只滚主体」（D-091，用户 2026-10-16「滑动时只滑动主题内容，tab 和操作区域不能动」）：
     * 返回键 / 标题 / tab 条 / 「＋ 新建菜谱」那一行都交给 `fixed`，**只有列表滚**。
     *
     * 「＋ 新建菜谱」也进来是有意的：它是这一页的**动作**（用户选的口径里"页面级操作行"就包含它），
     * 翻到「做过的」或「收藏的」时想写一道新菜，不该先滚回顶上再点。
     */
    <Page
      fixed={(
        <div className="pscreen my-recipes">
          <Link className="page-back" to={back.to}>← {back.label}</Link>
          <PageHeader title="我的菜谱" subtitle="我做过、收藏和写下的菜" art="recipes" />
          {/*
            这里只要**tab 条**（不给 `renderPanel`）：能滑的那一组内容在下面那个
            `SwipePager` 里——它要占满剩余高度（`fill`），而 tab 条属于固定区。
          */}
          <FilterTabs
            items={TABS.map((item) => ({ key: item.key, title: item.title }))}
            activeKey={tab}
            onChange={changeTab}
          />
          <div className="my-recipes__top">
            <Link className="my-recipes__new" to="/recipes/new">＋ 新建菜谱</Link>
          </div>
        </div>
      )}
    >
      {/*
        三个 tab 的**内容**交给 `SwipePager`：跟手翻页（用户 2026-10-15），
        整屏（`fill`，用户 2026-10-16）。所以这里给的是"按 key 画"而不是"只画当前那一个"
        ——跟手拖到一半时邻居那页也要画得出来（它自己的请求就此发出去、由 react-query 缓存住）。
        滑动与点 tab 走同一个 onChange（只改查询串、`replace: true` 不堆历史）。
      */}
      <SwipePager
        keys={TABS.map((item) => item.key)}
        activeKey={tab}
        onChange={changeTab}
        fill
        renderPanel={(key) => {
          const from = `${location.pathname}${location.search}`
          if (key === 'favorites') return <FavoritesList from={from} />
          if (key === 'mine') return <OwnRecipesList />
          return <CookedList from={from} />
        }}
      />
    </Page>
  )
}

/**
 * 原创的（F1-12）：这个家自己上传的那些。
 *
 * 与菜谱小书的区别不是"筛选了一下"，而是**这里的东西都能改**：所以卡片沿用同一张
 * （翻菜的手感一致），但**卡上直接放「编辑 / 删除」**。
 *
 * 这两颗按钮原来是刻意留在详情页的（"列表上摆两个动作会让点卡片进去看做法变得不敢点"）。
 * 用户 2026-10-15 提「我的菜谱里面现在也没有删除和编辑这种操作」，被问到放哪儿时选的是
 * **"卡片上直接放"**——那就照做，同时把它们做成安静的一行（见 `dish-card__manage`）：
 * 够得着，但不跟"点卡片看做法"抢注意力。
 *
 * 分页沿用列表接口那一套（`useRecipes` + 哨兵滚动），没有另写一个"我的"接口：
 * 后端给的是同一个列表的 `mine=1` 视图，前端再包一层只会多一处要跟着改的契约。
 */
function OwnRecipesList() {
  const recipes = useRecipes({ mine: true })
  const sentinel = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const remove = useDeleteRecipe()
  // 待删的那一道（不可逆，先弹确认把代价说清；话术与详情页那份一致）
  const [pending, setPending] = useState<RecipeSummary | null>(null)
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
      {/*
        数量这时候走**自己的**一行（不再和「＋ 新建菜谱」同一行）：那一行搬进固定区了，
        而数量属于这一页的内容（数据在手边，提上去要多一次查询或把状态提上去）。
        位置对齐另外两个 tab 的计数——都在网格上方、靠右，换 tab 时眼睛不用重新找。
      */}
      {recipes.data && <p className="my-recipes__summary">共 {total} 道</p>}

      {/*
        加载/出错块套一层 `my-recipes__status`，与另外两支同形
        （`.cooked__status` / `.favorites__status` 都是 `padding: 14px 0` 的壳）。
        不套的话这一块比那两支高 14px——实测：这里顶端 208，那两支 222。
      */}
      {recipes.isPending && (
        <div className="my-recipes__status">
          <RecipeStatus title="正在找你自己传的菜…" loading>马上就好</RecipeStatus>
        </div>
      )}
      {recipes.isError && !recipes.data && (
        <div className="my-recipes__status">
          <RecipeStatus title="你的菜谱暂时打不开" onRetry={() => { void recipes.refetch() }}>
            {recipeErrorMessage(recipes.error)}
          </RecipeStatus>
        </div>
      )}
      {recipes.isRefetchError && recipes.data && (
        <div className="my-recipes__status">
          <RecipeStatus title="更新失败，暂时保留上次内容" onRetry={() => { void recipes.refetch() }}>
            {recipeErrorMessage(recipes.error)}
          </RecipeStatus>
        </div>
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

      {/*
        网格带 `my-recipes__grid` 钩子（2026-10-16）：横向栏距挂在它身上。
        **不能**靠 `.my-recipes .recipes-grid` —— `.my-recipes` 在固定页头里、
        网格在页体里，两者是兄弟，那种后代选择器永远匹配不到（实测卡片贴着屏幕边）。
      */}
      <div className="recipes-grid my-recipes__grid">
        {items.map((dish) => (
          <DishCard
            key={dish.id}
            dish={dish}
            manage={{
              /*
               * 编辑带 `from` 下去（**不是可选项**）：详情页与表单页的返回目标都靠它，
               * 不带的话改完返回会落到菜谱小书而不是这儿（上一轮修过同一个坑，见 NOW.md 2026-10-13 那一刀）。
               */
              onEdit: () => navigate(
                `/recipes/${encodeURIComponent(dish.id)}/edit`,
                { state: { from: `${location.pathname}${location.search}` } },
              ),
              onDelete: () => setPending(dish),
            }}
          />
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(pending)}
        title="删掉这道菜谱"
        // 与详情页同一句：删掉之后收藏与常用组合里的引用也跟着没了，别只问一句"确定吗"
        message={`「${pending?.name ?? '这道菜'}」会从你们家的菜谱里删掉，收藏与常用组合里的这道也会一起消失，删了不能恢复。`}
        confirmText="删除"
        tone="danger"
        pending={remove.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return
          remove.mutate(pending.id, {
            onSuccess: (result) => {
              setPending(null)
              toast.success(`已删掉「${result.name}」`)
            },
            onError: (error) => toast.error(apiErrorMessage(error)),
          })
        }}
      />

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
