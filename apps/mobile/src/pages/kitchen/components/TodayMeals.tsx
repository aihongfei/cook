import { Link } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import type { IconName } from '@/components/icons/Icon'
import { useFamily } from '@/api/family'
import { useTodayBoard, type MealProgressRow } from '@/api/orders'
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

const STATE_CLASS: Record<MealProgressRow['state'], string> = {
  none: 'is-none',
  open: 'is-collecting',
  settled: 'is-done',
}

/**
 * 状态点也是**图**（2026-10-16 用户：「不要用符号图标了」）。
 *
 * 原来是文字 `●`：一个字的颜色靠 CSS 跟着 `.is-done/.is-collecting/.is-none` 走，
 * 而字形的圆点大小由字体说了算——同一个 `●` 在安卓与 iOS 上不一样大、基线也偏。
 * 三张点图与上面三个 class **同色**（鼠尾草绿 / 琥珀金 / 暖灰褐），换图不换语义。
 */
const STATE_DOT: Record<MealProgressRow['state'], IconName> = {
  none: 'dot-none',
  open: 'dot-open',
  settled: 'dot-done',
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
            去创建或加入家庭<Icon name="arrow-right" size={13} className="icon--trail" />
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="card today-meals">
      <div className="today-meals__head">
        <b>今日安排</b>
        <Link className="today-meals__more" to="/order">去点菜单 <Icon name="arrow-right" size={13} className="icon--trail" /></Link>
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
                <Icon name={STATE_DOT[row.state]} size={7} /> {row.statusLabel}
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
