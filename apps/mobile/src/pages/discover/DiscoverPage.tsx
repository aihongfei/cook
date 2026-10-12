import Page from '@/components/ui/Page'
import WeekPlan from './components/WeekPlan'
import '../shared.scss'
import './discover.scss'

/** 发现：今天吃什么 + 本周菜单（决策引擎见 FEATURES.md M5，菜单安排见 M4 / F4-02） */
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

        <WeekPlan />
      </div>
    </Page>
  )
}

