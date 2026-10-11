import { todayMeals } from '@/data/demo'

const statusClass: Record<string, string> = {
  done: 'is-done',
  planned: 'is-planned',
  collecting: 'is-collecting',
}

/** 今日安排：早/午/晚 三餐与各自进度 */
export default function TodayMeals() {
  return (
    <section className="card today-meals">
      <div className="today-meals__head">
        <b>今日安排</b>
        <span className="today-meals__more">最终菜单和做饭进度 ›</span>
      </div>
      {todayMeals.map((m) => (
        <div key={m.key} className="today-meals__row">
          <div className="today-meals__label">{m.name}</div>
          <div>
            <div className="today-meals__dishes">{m.dishes.join(' · ')}</div>
            <div className={`today-meals__status ${statusClass[m.status]}`}>● {m.statusText}</div>
          </div>
        </div>
      ))}
    </section>
  )
}
