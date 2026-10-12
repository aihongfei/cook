import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFavorites, useToggleFavorite } from '@/api/favorites'
import EmptyState from '@/components/ui/EmptyState'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { toast } from '@/components/ui/toast'
import { readBackLink } from '@/pages/back-link'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { caloriesLabel } from '@/api/recipes'
import '../../shared.scss'
import './favorites.scss'

/**
 * 我收藏的菜（M1 / F1-09）。口径见 D-037。
 *
 * 三件事刻意的：
 * - **收藏是私人的**（按账号存，与家庭共享开关无关）：所以这一页**不要求加入家庭**，
 *   也不显示"家里谁"的字样——一个人自己收藏自己看；
 * - **卡片点进详情，心就地取消**：取消收藏是一个"减法"，就地做掉、给一句提示即可，
 *   不为它弹二次确认（反正再点一下就能收回来，成本对称）；
 * - **这一页不放「点这道」**：卡片点进详情，点菜走详情页的「想吃这道」或列表页的
 *   「点这道」（F1-10）。收藏页的用途是"想起来做什么"，把点菜按钮也堆在这里，
 *   三处各有一个落点反而让人记不清哪个是哪个。
 */
export default function FavoritesPage() {
  const location = useLocation()
  const favorites = useFavorites()
  const toggle = useToggleFavorite()
  const back = readBackLink(location.state, '/mine')

  const items = favorites.data?.items ?? []
  const limit = favorites.data?.limit ?? 0
  const atLimit = limit > 0 && items.length >= limit

  const unfavorite = (recipeId: string, name: string) => {
    toggle.mutate(recipeId, {
      onSuccess: () => toast.success(`已取消收藏「${name}」`),
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  return (
    <Page>
      <div className="pscreen favorites-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="我收藏的菜" subtitle="想做的时候，来这儿找" art="mine" />

        {favorites.isPending && (
          <div className="favorites__status">
            <RecipeStatus title="正在翻你的收藏…" loading />
          </div>
        )}
        {favorites.isError && (
          <div className="favorites__status">
            <RecipeStatus title="收藏暂时打不开" onRetry={() => { void favorites.refetch() }}>
              {apiErrorMessage(favorites.error)}
            </RecipeStatus>
          </div>
        )}

        {favorites.data && items.length === 0 && (
          <div className="favorites__empty">
            <EmptyState title="还没有收藏的菜" desc="翻菜谱时点卡片右上角那颗心，就收进来了。" />
            <Link className="recipe-button favorites__go" to="/recipes" state={{ from: location.pathname }}>
              去菜谱小书看看
            </Link>
          </div>
        )}

        {items.length > 0 && (
          <p className="favorites__summary">
            共 {items.length} 道{limit > 0 && `（最多 ${limit} 道）`}
            {atLimit && '　·　收藏满了，想收新的先取消一道'}
          </p>
        )}

        <div className="favorites__grid">
          {items.map((dish) => (
            <article className="fav-card" key={dish.id}>
              <button
                type="button"
                className="fav-card__fav"
                aria-label={`取消收藏${dish.name}`}
                disabled={toggle.isPending}
                onClick={() => unfavorite(dish.id, dish.name)}
              >
                ❤
              </button>
              <Link
                className="fav-card__link"
                to={`/recipes/${encodeURIComponent(dish.id)}`}
                state={{ from: location.pathname }}
              >
                <div className="fav-card__pic"><RecipeImage src={dish.image} name={dish.name} /></div>
                <div className="fav-card__body">
                  <div className="fav-card__name">{dish.name}</div>
                  <div className="fav-card__meta">
                    <span>{dish.category || '品类暂无'}</span>
                    <span>{dish.cuisine || '菜系暂无'}</span>
                  </div>
                  <div className="fav-card__calories">{caloriesLabel(dish)}</div>
                </div>
              </Link>
            </article>
          ))}
        </div>
      </div>
    </Page>
  )
}
