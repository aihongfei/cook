import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFamily } from '@/api/family'
import { useOrderHistory, type HistoryDay, type MealProgressRow } from '@/api/orders'
import { readBackLink } from '@/pages/back-link'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { STATUS_TONE } from '@/components/ui/status-tone'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import '../../shared.scss'
import './history.scss'

/**
 * 点单历史与美食日记（M3 / F3-09）。口径见 D-035。
 *
 * 它解决 `RISKS.md` R-19 记下的那件事：`GET /orders` 一次最多 60 张卡（约一个月），
 * 更早的点单**数据还在库里、界面上看不到**。所以这一页的第一件事是**按日期区间往前翻**，
 * 而不是把同样的 60 张换个样子显示。
 *
 * 三件事刻意的：
 * - **按天铺开，没安排的那天也占位**：回看时"那天家里没张罗"本身就是信息；
 *   缺行和空行在界面上是两回事（与备菜计划同一个读法）。
 * - **翻页靠"再往前一页"按钮，不做无限滚动**：历史是往下翻旧账，
 *   滚到底自动加载会让用户失去"我现在看到哪一段"的感觉；按钮上写明会翻到哪一段。
 * - **有内容的格子整段可点**：落到点菜单去改状态、看成品照、照它再点一次（F3-06），
 *   与备菜计划同一套做法。
 */

function dayBadge(day: HistoryDay, today: string, yesterday: string): string {
  if (day.date === today) return '今'
  if (day.date === yesterday) return '昨'
  // 其余取日期里的"日"（`2026-10-13` → `13`）；回看时日子比星期更常被提到
  return String(Number(day.date.slice(8)))
}

function mealRow(meal: MealProgressRow, from: string) {
  const hasContent = meal.dishCount > 0

  return (
    <div className="history__row" key={meal.meal}>
      <span className="history__meal">{meal.label}</span>
      <span className="history__main">
        {hasContent ? (
          // 有内容的那格整段可点：改状态、定人数、看成品照、再点一次都在点菜单那边
          <Link className="history__dishes history__dishes--link" to="/order" state={{ from }}>
            {meal.dishes.join(' · ')}
          </Link>
        ) : (
          <span className="history__dishes history__dishes--empty">没有安排</span>
        )}
        {hasContent && (
          <span className="history__meta">
            {meal.dinerCount ? `${meal.dinerCount} 人吃` : '人数还没定'}
            {meal.photoCount > 0 && ` · 成品照 ${meal.photoCount} 张`}
          </span>
        )}
      </span>
      {hasContent && meal.status && (
        <span className={['stamp', STATUS_TONE[meal.status]].filter(Boolean).join(' ')}>{meal.statusLabel}</span>
      )}
    </div>
  )
}

export default function HistoryPage() {
  const location = useLocation()
  const family = useFamily()
  const history = useOrderHistory({ enabled: Boolean(family.data) })
  const back = readBackLink(location.state, '/mine')

  const pages = history.data?.pages ?? []
  const days = pages.flatMap((page) => page.days)
  const last = pages[pages.length - 1]
  const scopeNote = last?.scope === 'mine'
    ? '家里关了共享，现在只看得到你自己参与过的餐次。'
    : null

  // 有记录的天数：空页面（比如刚开始用 App 的那个月）要能一眼看出"不是加载坏了"
  const cooked = days.filter((day) => day.meals.some((meal) => meal.dishCount > 0)).length

  const offsetDays = last?.pageSize ?? 31
  const nextRangeLabel = last ? `${shiftLabel(last.from, -offsetDays).slice(5)} 起` : ''

  return (
    <Page>
      <div className="pscreen history-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="点单历史" subtitle="翻翻看这阵子家里都吃过什么" art="order" />

        {!family.isPending && !family.data ? (
          <section className="card history__tip">
            <p className="history__tip-text">
              历史是按家里一起记的。先创建家庭或用邀请码加入，再回来翻这一段。
            </p>
            <Link className="history__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭 →
            </Link>
          </section>
        ) : (
          <>
            {history.isPending && (
              <div className="card history__status">
                <RecipeStatus title="正在翻旧账…" loading />
              </div>
            )}
            {history.isError && (
              <div className="card history__status">
                <RecipeStatus title="历史暂时打不开" onRetry={() => { void history.refetch() }}>
                  {apiErrorMessage(history.error)}
                </RecipeStatus>
              </div>
            )}

            {scopeNote && <p className="history__scope">{scopeNote}</p>}

            {last && (
              <p className="history__summary">
                {last.from === last.to
                  ? last.from
                  : `${last.from.slice(5)} ～ ${last.to.slice(5)}`}
                （{days.length} 天，有记录 {cooked} 天）
              </p>
            )}

            {days.map((day) => (
              <section className="card history__day" key={day.date}>
                <div className="history__day-head">
                  <span className="history__badge">{dayBadge(day, last?.to ?? '', shiftLabel(last?.from ?? '', -1))}</span>
                  <span className="history__date">{day.date}</span>
                  <span className="history__weekday">{day.weekday}</span>
                </div>
                {day.meals.map((meal) => mealRow(meal, location.pathname))}
              </section>
            ))}

            <div className="history__more-wrap">
              {history.hasNextPage ? (
                <button
                  type="button"
                  className="recipe-button history__more"
                  disabled={history.isFetchingNextPage}
                  onClick={() => { void history.fetchNextPage() }}
                >
                  {history.isFetchingNextPage ? '正在往前翻…' : `再往前一页（${nextRangeLabel}）`}
                </button>
              ) : (
                // 到头了要说清：这是"没记录了"，不是"按钮没加载出来"
                <p className="history__end">{days.length > 0 ? '再往前没有记录了。' : '还没有点单记录。'}</p>
              )}
              {history.isFetchNextPageError && (
                <RecipeStatus
                  title="再往前那一段没翻出来"
                  onRetry={() => { void history.fetchNextPage() }}
                >
                  {apiErrorMessage(history.error)}
                </RecipeStatus>
              )}
            </div>
          </>
        )}
      </div>
    </Page>
  )
}

/** `YYYY-MM-DD` 加 n 天，返回同样的 key（前端只用来算"再往前一页"的文案） */
function shiftLabel(key: string, n: number): string {
  if (!key) return ''
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day + n)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
