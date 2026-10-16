import { Link } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { apiErrorMessage } from '@/api/client'
import { useFavorites, useToggleFavorite } from '@/api/favorites'
import EmptyState from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/toast'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { caloriesLabel } from '@/api/recipes'
import '@/pages/shared.scss'
import '../favorites/favorites.scss'

/**
 * 我收藏的菜（M1 / F1-09）的**列表本体**。口径见 D-037。
 *
 * 抽成组件是因为它现在有**两个**上屏的地方（F9-02 / D-076）：
 * 「我的菜谱」的第二个 tab，与保留的 `/favorites` 独立路由。两处各写一遍必然漂移——
 * 改一处忘一处，用户会在两个入口看到两种卡片。
 *
 * 三件事刻意的（原先在 FavoritesPage 的文件头，跟着搬过来）：
 * - **收藏是私人的**（按账号存，与家庭共享开关无关）：所以这里**不要求加入家庭**，
 *   也不显示"家里谁"的字样——一个人自己收藏自己看；
 * - **卡片点进详情，心就地取消**：取消收藏是一个"减法"，就地做掉、给一句提示即可，
 *   不为它弹二次确认（反正再点一下就能收回来，成本对称）；
 * - **不在这里放「点这道」**：收藏的用途是"想起来做什么"，点菜走详情页的
 *   「想吃这道」或列表页的「点这道」（F1-10）。三处各有一个落点反而让人记不清哪个是哪个。
 *
 * `from` 是"从哪来"的路由（两张卡点进详情、以及空态里那个链接都带它）：
 * 详情页据此决定返回按钮写「返回我收藏的菜」还是「返回我的菜谱」。
 */
export default function FavoritesList({ from, emptyTo = '/recipes' }: { from: string; emptyTo?: string }) {
  const favorites = useFavorites()
  const toggle = useToggleFavorite()

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
    <>
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
          <Link className="recipe-button favorites__go" to={emptyTo} state={{ from }}>
            去菜谱小书看看
          </Link>
        </div>
      )}

      {/*
        数量走右上角：与同一页「做过的」和「原创的」那两行同位置（用户 2026-10-15
        反馈「做过的」下面那行不好看——同一页三处各摆一个位置会让人每换一个 tab
        就重新找一次总数在哪）。
      */}
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
              <Icon name="heart" size={17} />
            </button>
            <Link
              className="fav-card__link"
              to={`/recipes/${encodeURIComponent(dish.id)}`}
              /*
               * 与 `CookedList` 同一处修（2026-10-16）：用传进来的 `from`，不要自己拼
               * `location.pathname`——那个值**丢了查询串**，而"第几个 tab"就在查询串里，
               * 从「收藏的」点进详情再返回会落到默认的「做过的」。
               */
              state={{ from }}
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
    </>
  )
}
