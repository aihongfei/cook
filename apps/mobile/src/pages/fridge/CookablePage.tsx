import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useCookablePages, type CookableDish } from '@/api/fridge'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
import '@/pages/shared.scss'
import './fridge.scss'

/** 一次翻几道（12 与接口默认一致；上限 30 留给将来真要"一屏到底"的时候） */
const PAGE_SIZE = 12

/**
 * 「能做点什么」的完整列表（F5-04 / F6-07）。
 * 入口：冰箱页那条横滑卡末尾的「还有 N 道 / 看全部 ›」（D-063 修订）。
 *
 * 为什么要有这一页：那块原来只是个说明（**不是链接**，怕给死路）。用户 2026-10-13 指出
 * 「这个更多也不好看还不能点击，需要实现和优化」——既然它说得出"还有 15 道"，
 * 就该给得出来；点不动的一句"还有 N 道"等于把用户的下一步堵死。
 *
 * 四件事刻意的：
 *
 * - **同一个判断，不是另一套推荐**：这一页调的还是 `/fridge/cookable`（F5-04 的规则），
 *   只是把 `limit`/`offset` 用上把剩下的翻出来。冰箱页看到的前 5 道与这里的第一页是
 *   同一份结果与同一个顺序，不会出现"点进来换了一批菜"。
 * - **筛选口径从链接里带过来**（`ingredients` / `maxMissing`）：冰箱页当时是"整个冰箱"还是
 *   "挑好的几样"、"只看不用买的"开没开，都在 URL 上。用户看到的这一页是**他刚才那份结果的全部**；
 *   副产品是这些筛选**活过路由跳转**（点进菜谱再返回，筛选还在）——与 R-49 那条同一规矩，
 *   只是这里用 URL 而不是 store（URL 本来就是"这一页看到的东西"的地址）。
 * - **一次只取一页**（12 道 + 「再看一页」）：剩下的几百道不必一上来全请求。
 *   上面写着共有几道、已翻出几道，用户知道还剩多少；翻到底说一句"能做的都在这里了"。
 * - **每行给"用上了什么 / 还差什么"**（与冰箱页同一套话术）：这是这一页唯一敢下的结论，
 *   也是用户决定"做这道还是顺路买一样"的依据。
 */
function Row({ dish, from }: { dish: CookableDish; from: string }) {
  const ready = dish.missing.length === 0
  return (
    <li className="cooklist__item">
      <Link
        className="cooklist__link"
        to={`/recipes/${encodeURIComponent(dish.id)}`}
        state={{ from }}
        aria-label={`查看${dish.name}菜谱`}
      >
        <span className="cooklist__pic"><RecipeImage src={dish.image} name={dish.name} /></span>
        <span className="cooklist__main">
          <span className="cooklist__name">{dish.name}</span>
          <span className="cooklist__have">用上了 {dish.have.join('、')}</span>
          {!ready && <span className="cooklist__missing">还差 {dish.missing.join('、')}</span>}
        </span>
        {/* 徽章在这一行右边（横滑卡里它压在图左上角，那是空间逼出来的摆法） */}
        <span className={['cooklist__badge', ready && 'is-ready'].filter(Boolean).join(' ')}>
          {ready ? '不用买' : `差 ${dish.missingCount} 样`}
        </span>
      </Link>
    </li>
  )
}

export default function CookablePage() {
  const location = useLocation()
  const back = useBackLink(location.state, '/fridge')
  const [params, setParams] = useSearchParams()

  /** 挑好的那几样（从冰箱页带过来的）；空 = 用整个冰箱（与接口同一口径） */
  const picked = (params.get('ingredients') ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  /** 「只看不用买的」= 后端那条"差 0 样"的线（URL：`maxMissing=0`） */
  const readyOnly = params.get('maxMissing') === '0'

  const list = useCookablePages(
    {
      ingredients: picked.length > 0 ? picked : undefined,
      maxMissing: readyOnly ? 0 : 1,
      limit: PAGE_SIZE,
    },
    { enabled: true },
  )

  const board = list.data?.pages[0]
  const dishes = list.data?.pages.flatMap((page) => page.items) ?? []
  /** 从这一页进菜谱详情时把**整串地址**（含筛选）带下去，返回时原样回来 */
  const here = `${location.pathname}${location.search}`
  /** 上面那句"共几道"取第一页的 total（翻到第几页都一样，后端同一口径） */
  const total = board?.total ?? 0

  const toggleReady = () => {
    const next = new URLSearchParams(params)
    if (readyOnly) next.delete('maxMissing')
    else next.set('maxMissing', '0')
    setParams(next, { replace: true })
  }

  return (
    <Page>
      <div className="pscreen">
        <BackLink to={back.to} label={back.label} />
        <PageHeader
          title="能做点什么"
          subtitle={picked.length > 0 ? '按你挑的那几样算' : '冰箱里这些东西能做出来的菜'}
          art="fridge"
        />

        <div className="cooklist__filters">
          <button
            type="button"
            className={['cooklist__filter', readyOnly && 'is-on'].filter(Boolean).join(' ')}
            aria-pressed={readyOnly}
            onClick={toggleReady}
          >
            只看不用买的
          </button>
          {board && (
            <span className="cooklist__summary">
              {total === 0 ? '这几样配不出菜' : `${total} 道能用上`}
              {board.skipSeasonings > 0 && ` · 调料 ${board.skipSeasonings} 样没算`}
              {picked.length > 0 && ` · 用挑好的 ${board.usable} 样算`}
              {dishes.length > 0 && ` · 已翻出 ${dishes.length} 道`}
            </span>
          )}
        </div>

        {list.isPending && (
          <div className="card cooklist__status">
            <RecipeStatus title="正在翻菜谱，看这些能做什么…" loading />
          </div>
        )}
        {list.isError && (
          <div className="card cooklist__status">
            <RecipeStatus title="暂时算不出来" onRetry={() => { void list.refetch() }}>
              厨房服务可能开小差了，等会儿再试。
            </RecipeStatus>
          </div>
        )}

        {/* 共享关掉时说明只用了自己记的那些（与冰箱页同一口径） */}
        {board?.scope === 'mine' && (
          <p className="cooklist__scope">家里关了共享，这里只按你自己记的那些算。</p>
        )}

        {board && board.filteredOut > 0 && (
          <p className="cooklist__filtered">
            有 {board.filteredOut} 道被口味档案挡掉了（家里人过敏的东西）——在「我的 · 口味与忌口」里能改。
          </p>
        )}

        {/* 冰箱里没东西可算：说清"记了才能算"，并给出路（不编一道菜出来） */}
        {board && total === 0 && board.usable === 0 && (
          <section className="card cooklist__empty">
            <p className="cooklist__empty-text">
              {picked.length > 0
                ? '挑好的这几样配不出菜，回冰箱页重新挑几样。'
                : '冰箱里还没有能拿来做菜的东西（调料不算）。先去记几样，这里就会告诉你它们能做什么。'}
            </p>
            <Link className="cooklist__link-out" to="/fridge">去记冰箱里的东西 →</Link>
          </section>
        )}

        {board && total === 0 && board.usable > 0 && (
          <section className="card cooklist__empty">
            <p className="cooklist__empty-text">
              {readyOnly
                ? '这几样暂时没有"不用买就能做"的菜。把「只看不用买的」关掉，能看到差一两样的。'
                : '这几样暂时配不出菜。菜谱要的配料得和冰箱里的名字对得上——记的时候尽量用常见的叫法（比如"西红柿"而不是"洋柿子"）。'}
            </p>
          </section>
        )}

        {dishes.length > 0 && (
          <section className="card cooklist">
            <ul className="cooklist__items">
              {dishes.map((dish) => <Row key={dish.id} dish={dish} from={here} />)}
            </ul>
          </section>
        )}

        {list.isFetchNextPageError && (
          <div className="cooklist__more-error">
            <RecipeStatus title="后面的菜加载失败" onRetry={() => { void list.fetchNextPage() }} />
          </div>
        )}
        {list.hasNextPage && (
          <button
            type="button"
            className="cooklist__more"
            disabled={list.isFetching}
            onClick={() => { void list.fetchNextPage() }}
          >
            {list.isFetchingNextPage ? '正在翻…' : `再看一页（还有 ${total - dishes.length} 道）`}
          </button>
        )}
        {dishes.length > 0 && !list.hasNextPage && (
          <p className="cooklist__end">能做的都在这里了。</p>
        )}
      </div>
    </Page>
  )
}
