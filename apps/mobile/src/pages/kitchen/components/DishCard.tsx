import type { Dish } from '@/data/demo'

/** 菜谱卡：笔绘菜品图 + 名称 + 时间/收藏数，右上角收藏心 */
export default function DishCard({ dish, onAdd }: { dish: Dish; onAdd?: (id: string) => void }) {
  return (
    <article className="dish-card">
      <div className="dish-card__pic">
        <img src={dish.image} alt={dish.name} />
        <button type="button" className="dish-card__fav" aria-label="收藏">
          ❤
        </button>
      </div>
      <div className="dish-card__body">
        <div className="dish-card__name">{dish.name}</div>
        <div className="dish-card__meta">
          <span>⏱ {dish.minutes} 分钟</span>
          <span>❤ {dish.likes}</span>
        </div>
        <button type="button" className="dish-card__add" onClick={() => onAdd?.(dish.id)}>
          + 加菜
        </button>
      </div>
    </article>
  )
}
