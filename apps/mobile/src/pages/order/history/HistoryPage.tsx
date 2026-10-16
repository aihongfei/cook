import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { apiErrorMessage } from '@/api/client'
import { useFamily } from '@/api/family'
import { useDeleteMealRecord, useOrderHistory, type HistoryDay, type MealProgressRow } from '@/api/orders'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { STATUS_TONE } from '@/components/ui/status-tone'
import { toast } from '@/components/ui/toast'
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

function mealRow(meal: MealProgressRow, from: string, date: string, onDelete: () => void) {
  const hasContent = meal.dishCount > 0
  /*
   * 只有**已经定局**的那两档给删除入口，与服务端的 `canDeleteMeal` 是同一条判据：
   * 「做好了」是"这条记录唯一的改错入口"（明细已经不能改了），「已取消」是清尾账。
   * 还在收集中/已安排/正在做的不给——那几档的正路是**取消**或**退菜**（就在点菜单上），
   * 删记录会把"这餐还在安排"这个事实一起抹掉，而用户想表达的从来不是那个意思
   * （给个按钮再拿 409 拒绝，比不给按钮更糟）。
   */
  const deletable = hasContent && (meal.status === 'DONE' || meal.status === 'CANCELED')

  return (
    <div className="history__row" key={meal.meal}>
      <span className="history__meal">{meal.label}</span>
      <span className="history__main">
        {hasContent ? (
          // 有内容的那格整段可点：落到**这一餐的详情**（改状态、定人数、看成品照、再点一次都在那边）。
          // 2026-10-16 起指向详情而不是列表：点单列表只看今明后三天，而这一页翻的是过去的账——
          // 指向列表的话，点进去不仅看不到这一餐，还得自己再翻一遍。
          <Link
            className="history__dishes history__dishes--link"
            to={`/order/${encodeURIComponent(meal.mealKey)}`}
            state={{ from }}
          >
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
      {deletable && (
        <button
          type="button"
          className="history__drop"
          aria-label={`删掉 ${date} ${meal.label}的记录`}
          onClick={onDelete}
        >
          删除
        </button>
      )}
    </div>
  )
}

export default function HistoryPage() {
  const location = useLocation()
  const family = useFamily()
  const history = useOrderHistory({ enabled: Boolean(family.data) })
  const back = useBackLink(location.state, '/mine')
  /*
   * 待删的那一餐（用户 2026-10-15：「点单历史里面要有」删整条）。
   * 状态留在页面这一层而不是每一格：一次只可能删一条，弹窗也只有一个。
   */
  const [pending, setPending] = useState<{ mealKey: string; date: string; label: string; dishes: number; photos: number } | null>(null)
  const drop = useDeleteMealRecord()

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
        <BackLink to={back.to} label={back.label} />
        <PageHeader title="点单历史" subtitle="翻翻看这阵子家里都吃过什么" art="order" />

        {!family.isPending && !family.data ? (
          <section className="card history__tip">
            <p className="history__tip-text">
              历史是按家里一起记的。先创建家庭或用邀请码加入，再回来翻这一段。
            </p>
            <Link className="history__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭<Icon name="arrow-right" size={13} className="icon--trail" />
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
                {day.meals.map((meal) => mealRow(
                  meal,
                  location.pathname,
                  day.date,
                  () => setPending({
                    mealKey: meal.mealKey,
                    date: day.date,
                    label: meal.label,
                    dishes: meal.dishCount,
                    photos: meal.photoCount,
                  }),
                ))}
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

      {/*
        删整条记录：**不可逆**，所以按本项目对不可逆的一贯做法——把代价说清，
        而不是含糊地问一句"确定吗"（用户看不出确定之后会失去什么）。
        这里点名日期餐次、几道菜，以及**照片会留下来**（CheckIn 是 SetNull，
        照片退回成"没挂餐次"的独立打卡）——那句话是用户最可能担心的那件事。
      */}
      <ConfirmDialog
        open={Boolean(pending)}
        title={`删掉 ${pending?.date ?? ''} ${pending?.label ?? ''} 的记录？`}
        message={(
          <>
            <p>
              这一餐的 {pending?.dishes ?? 0} 道点单记录会被删掉，点单历史里这一格回到"没有安排"。
              {(pending?.photos ?? 0) > 0 && `拍的 ${pending?.photos} 张成品照会留下来，只是不再挂在这一餐上。`}
            </p>
            <p>只是少一道菜或者不想做这一餐，已经不用回来删记录了——点菜单上退菜、取消就行。</p>
          </>
        )}
        confirmText="删掉这条"
        tone="danger"
        pending={drop.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return
          drop.mutate(pending.mealKey, {
            onSuccess: (gone) => {
              setPending(null)
              // 删完就取不回来了，把"删掉了什么、什么留下了"当场说一遍
              toast.success(
                `删掉了 ${gone.date.slice(5)} ${gone.mealLabel}的记录`
                + (gone.photoCount > 0 ? `，${gone.photoCount} 张照片留了下来` : ''),
              )
            },
            onError: (error) => toast.error(apiErrorMessage(error)),
          })
        }}
      />
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
