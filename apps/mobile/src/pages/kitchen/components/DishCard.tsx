import { Link, useLocation } from 'react-router-dom'
import { caloriesLabel, type RecipeSummary } from '@/api/recipes'
import { readPlanTarget } from '@/pages/order/plan-target'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import '../kitchen.scss'

/** 真实菜谱卡：点进详情看做法；若是从「去安排某一餐」进来的，把目标原样带下去。 */
export default function DishCard({ dish }: { dish: RecipeSummary }) {
  const location = useLocation()
  // 路由 state 是不可信输入，统一走 readPlanTarget 校验（见该文件）；这里只负责"原样传下去"
  const plan = readPlanTarget(location.state)
  return (
    <article className="dish-card">
      <Link
        className="dish-card__link"
        to={`/recipes/${encodeURIComponent(dish.id)}`}
        state={{ from: `${location.pathname}${location.search}`, ...(plan ? { plan } : {}) }}
        aria-label={`查看${dish.name}菜谱`}
      >
        <div className="dish-card__pic"><RecipeImage src={dish.image} name={dish.name} /></div>
        <div className="dish-card__body">
          <div className="dish-card__name">{dish.name}</div>
          <div className="dish-card__meta">
            <span>{dish.category || '品类暂无'}</span>
            <span>{dish.cuisine || '菜系暂无'}</span>
          </div>
          <div className="dish-card__calories">{caloriesLabel(dish)}</div>
          <span className="dish-card__browse">看做法 →</span>
        </div>
      </Link>
    </article>
  )
}
