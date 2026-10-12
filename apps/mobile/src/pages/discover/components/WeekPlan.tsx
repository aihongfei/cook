import { Link, useLocation } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { usePlanBoard, type MealProgressRow, type PlanDay } from '@/api/orders'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { STATUS_TONE } from '@/components/ui/status-tone'
import '../../shared.scss'
import '../discover.scss'

/**
 * 本周菜单（M4 / F4-02）：今天/明天/后天每天午晚两餐的安排与缺口。
 *
 * 三件事是刻意的：
 * - **没安排的餐也要占一行**（写「还没安排」并给「去安排」）——这块的用处就是找缺口，
 *   缺口不能凭空消失；
 * - **不编内容**：真没安排才写「还没安排」，菜名只来自真实点单；
 * - **「去安排」带着目标走**：落到菜谱小书并带上日期 + 餐次，
 *   挑完菜点「想吃这道」时抽屉直接默认到这一餐，不用再选一遍。
 *
 * 可见性与点单同一套（D-024）：共享关闭时吃货看到的是 "没安排" 的空行，
 * 这时**要说清是共享关了**（scope=mine），否则他会以为家里真没张罗而白安排一顿。
 */

const DAY_BADGE: Record<string, string> = { 今天: '今', 明天: '明', 后天: '后' }

function mealRow(day: PlanDay, meal: MealProgressRow, from: string) {
  const hasContent = meal.dishCount > 0
  const inner = (
    <>
      <span className="weekplan__meal">{meal.label}</span>
      <span className="weekplan__main">
        <span className="weekplan__dishes">{hasContent ? meal.dishes.join(' · ') : '还没安排'}</span>
        {/* 人数只在有菜的那行提：没点菜的一餐去谈"几个人吃"没有意义（与厨房页同一口径） */}
        {hasContent && (
          <span className="weekplan__meta">
            {meal.dinerCount ? `${meal.dinerCount} 人吃` : '人数还没定'}
            {meal.photoCount > 0 && ` · 成品照 ${meal.photoCount} 张`}
          </span>
        )}
      </span>
    </>
  )

  // 有内容的那格整格可点：落到点菜单（安排菜单、改状态都在那里）
  if (hasContent) {
    return (
      <Link className="weekplan__row weekplan__row--link" key={meal.meal} to="/order" state={{ from }}>
        {inner}
        <span className={['stamp', STATUS_TONE[meal.status ?? 'PENDING']].filter(Boolean).join(' ')}>
          {meal.statusLabel}
        </span>
      </Link>
    )
  }
  // 空行一律给「去安排」：能到这一步的餐都不可能是"结束"的
  // （已做好/已取消的餐必然留有点单，走上面的分支）
  return (
    <div className="weekplan__row" key={meal.meal}>
      {inner}
      <Link
        className="btn-ghost weekplan__arrange"
        to="/recipes"
        state={{ from, plan: { date: day.date, meal: meal.meal, label: `${day.label}${meal.label}` } }}
      >
        去安排
      </Link>
    </div>
  )
}

export default function WeekPlan() {
  const family = useFamily()
  const location = useLocation()
  const board = usePlanBoard({ days: 3, enabled: Boolean(family.data) })

  if (!family.isPending && !family.data) {
    return (
      <section className="card weekplan">
        <div className="weekplan__head">
          <span className="weekplan__title">本周菜单</span>
        </div>
        <p className="weekplan__empty">
          家里人一起点菜，这里就能看到今天、明天、后天各安排了什么。
          <Link className="weekplan__link" to="/family" state={{ from: location.pathname }}>
            去创建或加入家庭 →
          </Link>
        </p>
      </section>
    )
  }

  return (
    <section className="card weekplan">
      <div className="weekplan__head">
        <span className="weekplan__title">本周菜单</span>
        <Link className="weekplan__more" to="/order" state={{ from: location.pathname }}>
          去点菜单 →
        </Link>
      </div>

      {board.isPending && (
        <div className="weekplan__status-line">
          <RecipeStatus title="正在看这几天的安排…" loading />
        </div>
      )}
      {board.isError && (
        <div className="weekplan__status-line">
          <RecipeStatus title="最近几天的安排暂时打不开" onRetry={() => { void board.refetch() }} />
        </div>
      )}
      {board.data?.scope === 'mine' && (
        <p className="weekplan__scope">家里关了共享，现在只看得到你自己安排的那几餐。</p>
      )}

      {board.data?.days.map((day) => (
        <div className="weekplan__day" key={day.date}>
          <div className="weekplan__day-head">
            <span className="weekplan__badge">{DAY_BADGE[day.label] ?? day.label.slice(-1)}</span>
            <span className="weekplan__day-label">{day.label}</span>
            <span className="weekplan__weekday">{day.weekday}</span>
          </div>
          {day.meals.map((meal) => mealRow(day, meal, location.pathname))}
        </div>
      ))}
    </section>
  )
}
