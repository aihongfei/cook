import Page from '@/components/ui/Page'
import SectionTitle from '@/components/ui/SectionTitle'
import '../shared.scss'

const weekPlan = [
  { day: '今天', lunch: '番茄炒蛋 · 清炒菜心 · 家常米饭', planned: true },
  { day: '明天', lunch: '还没有安排', planned: false },
  { day: '后天', lunch: '还没有安排', planned: false },
]

/** 发现：今天吃什么 + 本周菜单（决策引擎见 FEATURES.md M5） */
export default function DiscoverPage() {
  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">发现</div>
        <div className="psub">今天不知道吃什么，交给它</div>

        <div className="rank">
          <div className="rank__en">WHAT TO EAT TODAY</div>
          <div className="rank__title">今天吃什么？</div>
          <button type="button" className="rank__go">
            开始随机 →
          </button>
          <div className="rank__deco">🎲</div>
        </div>

        <div className="stats">
          <div className="stats__cell">
            <b className="stats__num">85</b>
            <span className="stats__label">私房菜</span>
          </div>
          <div className="stats__cell">
            <b className="stats__num">12</b>
            <span className="stats__label">冰箱食材</span>
          </div>
          <div className="stats__cell">
            <b className="stats__num">3</b>
            <span className="stats__label">临期</span>
          </div>
        </div>

        <SectionTitle title="本周菜单" more="去安排" />

        <div className="rows">
          {weekPlan.map((item) => (
            <div className="row" key={item.day}>
              <div className="row__icon">{item.day.slice(0, 1)}</div>
              <div className="row__main">
                {item.day} · 午餐
                <div className="row__sub">{item.lunch}</div>
              </div>
              {item.planned ? (
                <span className="stamp">已定</span>
              ) : (
                <button type="button" className="btn-ghost">
                  去安排
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </Page>
  )
}
