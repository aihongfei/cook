import { Link, useLocation } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { usePlanBoard, type MealProgressRow, type PlanDay } from '@/api/orders'
import { readBackLink } from '@/pages/back-link'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { STATUS_TONE } from '@/components/ui/status-tone'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import '../shared.scss'
import './prep.scss'

/**
 * 备菜计划（M4 / F4-03）：从今天起 7 天，每天午晚两餐各一行，缺哪天就直接加菜。
 *
 * 与本周菜单（F4-02，发现页那张卡）的关系：**同一份数据的不同窗口**。
 * 那张卡看 3 天、是"今天吃什么"的延伸；这一页看满一周，专门用来"把接下来几天排满"。
 * 两处的行结构与文案口径完全一致（都来自后端的 `MealProgressRow`），不各写一套。
 *
 * 三件事是刻意的：
 * - **每天都给「加菜」，不只是空着的那些**：备菜时最常做的是"这道不错，后天中午也来一份"，
 *   只给空行加菜就得先取消整餐（那是破坏性动作）；
 * - **不能加菜的行不画按钮**（`canAdd`）：已做好/已取消的餐由后端判定，
 *   前端不复刻状态机——复刻出来的第二份迟早会与后端分叉，表现是"点了按钮拿到 400"；
 * - **加菜带着目标走**：落到菜谱小书并带上日期 + 餐次，挑完菜点「想吃这道」时抽屉已默认到这一餐
 *   （与本周菜单的「去安排」同一条路，见 plan-target）。所以点菜的窗口必须覆盖这 7 天，
 *   否则第 4～7 天的这一行是条死路。
 */

const DAY_BADGE: Record<string, string> = { 今天: '今', 明天: '明', 后天: '后' }

function mealRow(day: PlanDay, meal: MealProgressRow, from: string) {
  const hasContent = meal.dishCount > 0
  const plan = { date: day.date, meal: meal.meal, label: `${day.label}${meal.label}` }

  return (
    <div className="prep__row" key={meal.meal}>
      <span className="prep__meal">{meal.label}</span>
      <span className="prep__main">
        {hasContent ? (
          // 有内容的那格整段可点：落到点菜单（改状态、定人数、看成品照都在那边）
          <Link className="prep__dishes prep__dishes--link" to="/order" state={{ from }}>
            {meal.dishes.join(' · ')}
          </Link>
        ) : (
          <span className="prep__dishes prep__dishes--empty">还没安排</span>
        )}
        {hasContent && (
          <span className="prep__meta">
            {meal.dinerCount ? `${meal.dinerCount} 人吃` : '人数还没定'}
            {meal.photoCount > 0 && ` · 成品照 ${meal.photoCount} 张`}
          </span>
        )}
      </span>

      {/* 状态与「加菜」并排：先让人看清这一餐到哪一步，再决定要不要再添一道 */}
      {hasContent && meal.status && (
        <span className={['stamp', STATUS_TONE[meal.status]].filter(Boolean).join(' ')}>{meal.statusLabel}</span>
      )}
      {meal.canAdd ? (
        <Link className="btn-ghost prep__add" to="/recipes" state={{ from, plan }}>
          加菜
        </Link>
      ) : (
        <span className="prep__locked">{hasContent ? '不再加菜' : ''}</span>
      )}
    </div>
  )
}

export default function PrepPage() {
  const location = useLocation()
  const family = useFamily()
  // 7 天：与后端点菜窗口（ORDER_DAY_SPAN）是同一个数，见上面那段说明
  const board = usePlanBoard({ days: 7, enabled: Boolean(family.data) })
  const back = readBackLink(location.state, '/discover')

  const days = board.data?.days ?? []
  const emptyMeals = days.reduce(
    (sum, day) => sum + day.meals.filter((meal) => meal.dishCount === 0).length,
    0,
  )

  return (
    <Page>
      <div className="pscreen prep-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="备菜计划" subtitle="接下来一周的安排，缺哪天就直接加菜" art="order" />

        {!family.isPending && !family.data ? (
          <section className="card prep__tip">
            <p className="prep__tip-text">
              备菜是按家里一起排的。先创建家庭或用邀请码加入，再回来安排这一周。
            </p>
            <Link className="prep__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭 →
            </Link>
          </section>
        ) : (
          <>
            {board.isPending && (
              <div className="card prep__status">
                <RecipeStatus title="正在看这一周的安排…" loading />
              </div>
            )}
            {board.isError && (
              <div className="card prep__status">
                <RecipeStatus title="这一周的安排暂时打不开" onRetry={() => { void board.refetch() }} />
              </div>
            )}
            {board.data?.scope === 'mine' && (
              <p className="prep__scope">家里关了共享，现在只看得到你自己安排的那几餐。</p>
            )}

            {/* 汇总一行：让人一眼知道还剩几餐空着（备菜就是要把这些填上） */}
            {board.data && (
              <p className="prep__summary">
                {days.length} 天共 {days.length * 2} 餐，还有 {emptyMeals} 餐空着。
              </p>
            )}

            {days.map((day) => (
              <section className="card prep__day" key={day.date}>
                <div className="prep__day-head">
                  <span className="prep__badge">{DAY_BADGE[day.label] ?? day.label.slice(-1)}</span>
                  <span className="prep__day-label">{day.label}</span>
                  <span className="prep__weekday">{day.weekday}</span>
                  <span className="prep__date">{day.date.slice(5)}</span>
                </div>
                {day.meals.map((meal) => mealRow(day, meal, location.pathname))}
              </section>
            ))}
          </>
        )}
      </div>
    </Page>
  )
}
