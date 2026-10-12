import { Link } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { useTodayBoard, type TodayMealRow } from '@/api/orders'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'

/**
 * 今日安排（M4 / F4-01）：今天午/晚餐现在到哪一步了。
 *
 * 数据来自 `/orders/today`（真实点单），不再用 M0 的示例数据。
 * 三件事是刻意的：
 * - **没点菜的那一餐也占一行**：首页要能一眼看出"晚饭还没人点"，那一行不能凭空消失；
 * - **不编内容**：没点菜就写「还没人点」，不猜、不拿别人的菜充数；
 * - **有内容的那行整行可点**，落到点菜单（安排菜单、改状态都在那里）。
 */

const STATE_CLASS: Record<TodayMealRow['state'], string> = {
  none: 'is-none',
  open: 'is-collecting',
  settled: 'is-done',
}

export default function TodayMeals() {
  const family = useFamily()
  const board = useTodayBoard({ enabled: Boolean(family.data) })

  // 没加入家庭：说清这块是干什么的，别让人对着一片空白猜
  if (!family.isPending && !family.data) {
    return (
      <section className="card today-meals">
        <div className="today-meals__head">
          <b>今日安排</b>
        </div>
        <div className="today-meals__empty">
          建个家、把家里人拉进来，就能一起点今天想吃的菜。
          <Link className="today-meals__link" to="/family" state={{ from: '/kitchen' }}>
            去创建或加入家庭 →
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="card today-meals">
      <div className="today-meals__head">
        <b>今日安排</b>
        <Link className="today-meals__more" to="/order">去点菜单 →</Link>
      </div>

      {board.isPending && <div className="today-meals__status-line"><RecipeStatus title="正在看今天的安排…" loading /></div>}
      {board.isError && (
        <div className="today-meals__status-line">
          <RecipeStatus title="今天的安排暂时打不开" onRetry={() => { void board.refetch() }} />
        </div>
      )}

      {board.data?.rows.map((row) => {
        const hasContent = row.dishCount > 0
        const inner = (
          <>
            <div className="today-meals__label">{row.label}</div>
            <div className="today-meals__main">
              <div className="today-meals__dishes">{hasContent ? row.dishes.join(' · ') : '还没人点'}</div>
              <div className={`today-meals__status ${STATE_CLASS[row.state]}`}>
                ● {row.statusLabel}
                {/* 人数只在有菜的那行提：没点菜的一餐去谈"几个人吃"没有意义 */}
                {hasContent && (row.dinerCount ? ` · ${row.dinerCount} 人吃` : ' · 人数还没定')}
                {row.photoCount > 0 && ` · 成品照 ${row.photoCount} 张`}
              </div>
            </div>
          </>
        )
        return hasContent ? (
          <Link className="today-meals__row today-meals__row--link" key={row.meal} to="/order">
            {inner}
          </Link>
        ) : (
          <div className="today-meals__row" key={row.meal}>
            {inner}
          </div>
        )
      })}
    </section>
  )
}
