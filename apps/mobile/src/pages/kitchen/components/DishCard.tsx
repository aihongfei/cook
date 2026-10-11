import { Link, useLocation } from 'react-router-dom'
import { caloriesLabel, type RecipeSummary } from '@/api/recipes'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import '../kitchen.scss'

/** 真实菜谱卡：本阶段只浏览，加入菜单与收藏由后续功能接入。 */
export default function DishCard({ dish }: { dish: RecipeSummary }) {
  const location = useLocation()
  return (
    <article className="dish-card">
      <Link
        className="dish-card__link"
        to={`/recipes/${encodeURIComponent(dish.id)}`}
        state={{ from: `${location.pathname}${location.search}` }}
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
