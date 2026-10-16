import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import {
  recipeErrorMessage,
  useDeleteRecipes,
  useRecipes,
  type RecipeSummary,
} from '@/api/recipes'
import Icon from '@/components/icons/Icon'
import { SelectIcon } from '@/components/icons/TabIcons'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import FilterTabs from '@/components/ui/FilterTabs'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import SwipePager from '@/components/ui/SwipePager'
import { toast } from '@/components/ui/toast'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
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
 *
 * ## 「原创的」的数据与"选择模式"都在**这一层**（2026-10-16，用户第三次改这一页）
 *
 * 用户这一轮的四条：「这两个按钮不要了，编辑在点进去的详情里面可以编辑，删除改为按住弹出
 * 复选框这种形式的，还有所有的菜谱图片要大小一致，可以使用 cover，还有这个新建菜谱应该
 * 只有原创里面才有啊」。
 *
 * 于是卡片上那两颗按钮下线（编辑回详情页，那里本来就有），删除变成**长按一张卡进多选**
 * （与点菜单同一套：长按是手势、另给一颗「多选」图标兜底，见 `enterSelect`）。选择模式的
 * 操作条要落在**固定区**——与点菜单同一条理由：滚到列表中间去挑第 6 道时，「已选 N 道 /
 * 删除」得一直看得见，放页体里会被滚出屏幕（D-091 定的"tab 与操作区域不动"）。
 *
 * 所以 `useRecipes({ mine: true })` 与 `selecting` / `picked` 都提在这一层，而不是留在
 * `OwnRecipesList` 里：**"固定区画什么"取决于"有没有东西可管"**（列表空着就给一颗「多选」，
 * 正是 D-066 说的"点不动的按钮不如不画"），而那个判据只有拿着列表的人有。
 * 代价是进这一页就会取一次「原创的」（react-query 缓存 60 秒，切 tab 不重发；
 * 这一页本来也是围着它建的）。
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

/** 选中的那几道（记 id 与名字：操作条要说"已选 N 道"、提示与确认框要说清删的是哪一道） */
interface Pick {
  id: string
  name: string
}

export default function MyRecipesPage() {
  const location = useLocation()
  const back = useBackLink(location.state, '/mine')
  const [params, setParams] = useSearchParams()
  // 认不出的 tab 值一律落回第一个：URL 是不可信输入（用户可能手改、旧链接可能带着别的值）
  const raw = params.get('tab')
  const tab: TabKey = isTabKey(raw) ? raw : 'cooked'

  const recipes = useRecipes({ mine: true })
  const remove = useDeleteRecipes()
  /*
   * 两件事分开记：`selecting` 是"现在在多选模式里"，`picked` 是选了哪几道。
   * 选择模式**不跨页存活**（离开这一页就退出）——它是"我现在要动手"的临时状态，
   * 被 keep-alive 留在缓存里的话，下次进来会看到一堆复选框而不知道为什么
   * （点菜单那边同一条，见 OrderPage）。
   */
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Pick[]>([])
  const [confirming, setConfirming] = useState(false)

  const items = recipes.data?.pages.flatMap((page) => page.items) || []

  const exitSelect = () => {
    setSelecting(false)
    setPicked([])
  }

  const togglePick = (dish: RecipeSummary) => {
    setPicked((current) =>
      current.some((row) => row.id === dish.id)
        ? current.filter((row) => row.id !== dish.id)
        : [...current, { id: dish.id, name: dish.name }],
    )
  }

  /** 进多选。带 `dish` 就是"长按这一张"（顺手选中它）；不带就是点了那颗「多选」图标 */
  const enterSelect = (dish?: RecipeSummary) => {
    setSelecting(true)
    if (!dish) return
    setPicked((current) =>
      current.some((row) => row.id === dish.id) ? current : [...current, { id: dish.id, name: dish.name }],
    )
  }

  /*
   * tab 状态进 URL（见文件头）。用 `replace` 而不是 push：在三个 tab 之间来回点
   * 不该在浏览器历史里堆一串记录（用户按返回时想回的是"上一页"，不是"上一个 tab"）。
   *
   * **换走就退出多选**：多选是"对着「原创的」那一屏"的临时状态，换走之后屏上已经没有
   * 复选框了，留一条"已选 3 道 / 删除"只会让人不敢点——它删的是看不见的东西。
   */
  const changeTab = (key: string) => {
    if (key !== 'mine' && (selecting || picked.length > 0)) exitSelect()
    setParams(key === 'cooked' ? {} : { tab: key }, { replace: true })
  }

  const confirmDelete = () => {
    setConfirming(false)
    remove.mutate(picked, {
      onSuccess: ({ removed, failed }) => {
        if (removed.length === 1) toast.success(`已删掉「${removed[0]}」`)
        else if (removed.length > 1) toast.success(`删掉了 ${removed.length} 道菜谱`)
        // 部分成功要说清**是哪几道**没删掉：一次网络抖动不该让整批白做，也不该假装全成了
        for (const row of failed) toast.error(`「${row.name}」没删掉：${row.message}`)
        // 全成 → 退出多选；有没成的 → 只把它们留在选中状态里，让用户接着处理（与点菜单退菜同一条）
        if (failed.length === 0) exitSelect()
        else setPicked(failed.map((row) => ({ id: row.id, name: row.name })))
      },
    })
  }

  const pickedNames = picked.map((row) => row.name)

  return (
    /*
     * 「页头不动、只滚主体」（D-091，用户 2026-10-16「滑动时只滑动主题内容，tab 和操作区域不能动」）：
     * 返回键 / 标题 / tab 条 / 「＋ 新建菜谱」那一行都交给 `fixed`，**只有列表滚**。
     */
    <Page
      fixed={(
        <div className="pscreen my-recipes">
          <BackLink to={back.to} label={back.label} />
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
          {/*
            「原创的」那一行——**只有这个 tab 有**（用户 2026-10-16：「这个新建菜谱应该只有
            原创里面才有啊」）。原先它在固定区里、三个 tab 都看得见：在「做过的」底下写一道
            新菜本来就是两件事凑在一起。
            行里有两样：左边「＋ 新建菜谱」（这一页的动作），右边「多选」（管理自己那些菜的入口）。
            进了多选，整行换成操作条——位置就是它原来占的那一处，眼睛不用重新找。
          */}
          {tab === 'mine' && (
            selecting ? (
              <div className="pick-bar">
                <div className="pick-bar__row">
                  <button type="button" className="pick-bar__exit" onClick={exitSelect}>
                    退出
                  </button>
                  <span className="pick-bar__count">已选 {picked.length} 道</span>
                  <button
                    type="button"
                    className="pick-bar__go"
                    disabled={picked.length === 0 || remove.isPending}
                    onClick={() => setConfirming(true)}
                  >
                    {remove.isPending ? '正在删…' : '删除'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="my-recipes__top">
                <Link className="my-recipes__new" to="/recipes/new"><Icon name="plus" size={13} white className="icon--lead" /> 新建菜谱</Link>
                {/*
                  多选的**显式入口**：长按是手势，第一次用的人找不到（与点菜单那颗图标同一条，
                  见 OrderPage）。只在**真有菜**的时候画——空列表上摆一颗点了没事发生的按钮，
                  正是 D-066 说的"点不动又不解释"。
                */}
                {items.length > 0 && (
                  <button
                    type="button"
                    className="my-recipes__multi"
                    aria-label="多选"
                    title="多选"
                    onClick={() => enterSelect()}
                  >
                    <SelectIcon width={19} height={19} />
                  </button>
                )}
              </div>
            )
          )}
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
          if (key === 'mine') {
            return (
              <OwnRecipesList
                recipes={recipes}
                selecting={selecting}
                picked={picked}
                onToggle={togglePick}
                onEnterSelect={enterSelect}
              />
            )
          }
          return <CookedList from={from} />
        }}
      />

      {/*
        删菜谱是不可逆的（收藏与常用组合里的引用也一起没），先弹确认把代价说清：
        一道时说名字（与详情页那句一致），多道时说清是几道。
      */}
      <ConfirmDialog
        open={confirming}
        title={picked.length > 1 ? `删掉这 ${picked.length} 道菜谱` : '删掉这道菜谱'}
        message={
          picked.length > 1
            ? `选中的 ${picked.length} 道菜谱（${pickedNames.slice(0, 3).join('、')}${picked.length > 3 ? '…' : ''}）会从你们家的菜谱里删掉，收藏与常用组合里的这些也会一起消失，删了不能恢复。`
            : `「${pickedNames[0] ?? '这道菜'}」会从你们家的菜谱里删掉，收藏与常用组合里的这道也会一起消失，删了不能恢复。`
        }
        confirmText="删除"
        tone="danger"
        pending={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmDelete}
      />
    </Page>
  )
}

/**
 * 原创的（F1-12）：这个家自己上传的那些。
 *
 * 与菜谱小书的区别不是"筛选了一下"，而是**这里的东西都能改**：卡片沿用同一张
 * （翻菜的手感一致），但给上长按多选——长按一张卡进选择模式，此后点卡片=勾选/取消，
 * 顶部那条操作条批量删除（用户 2026-10-16：「删除改为按住弹出复选框这种形式的」）。
 *
 * 卡片上的「编辑 / 删除」两颗按钮原来放在这里（D-085），用户 2026-10-16 收回：
 * **改走详情页**（那里本来就有，且能看到这道菜的全文再动手），**删走长按多选**。
 *
 * 分页沿用列表接口那一套（`useRecipes` + 哨兵滚动），没有另写一个"我的"接口：
 * 后端给的是同一个列表的 `mine=1` 视图，前端再包一层只会多一处要跟着改的契约。
 * （这一份查询现在挂在**页面**那一层，理由见 MyRecipesPage 的文件头。）
 */
function OwnRecipesList({
  recipes,
  selecting,
  picked,
  onToggle,
  onEnterSelect,
}: {
  recipes: ReturnType<typeof useRecipes>
  selecting: boolean
  picked: Pick[]
  onToggle: (dish: RecipeSummary) => void
  onEnterSelect: (dish: RecipeSummary) => void
}) {
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
      {/*
        数量这时候走**自己的**一行（不与「＋ 新建菜谱」同一行：那一行在固定区，
        而数量属于这一页的内容）。位置对齐另外两个 tab 的计数——都在网格上方、靠右，
        换 tab 时眼睛不用重新找。
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
            icon="pencil"
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
            /*
             * 长按多选（见文件头）。**一直传下去**（不是只在选择模式里传）：
             * 长按正是"进选择模式"这个动作本身，不传就没有入口。
             */
            select={{
              active: selecting,
              picked: picked.some((row) => row.id === dish.id),
              onToggle: () => onToggle(dish),
              onLongPress: () => onEnterSelect(dish),
            }}
          />
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
