import Page from '@/components/ui/Page'
import SectionTitle from '@/components/ui/SectionTitle'
import '../shared.scss'

const storage = [
  { name: '常温', count: 2 },
  { name: '保鲜', count: 5 },
  { name: '冷藏', count: 4 },
  { name: '冷冻', count: 1 },
]

const useFirst = [
  { name: '小油菜', where: '保鲜 · 还剩 1 天' },
  { name: '鸡蛋', where: '冷藏 · 还剩 2 天' },
]

/** 冰箱：AI 拍照入库 + 库存（见 FEATURES.md M6 / M16） */
export default function FridgePage() {
  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">我的冰箱</div>
        <div className="psub">食材管理助手，让每一餐更新鲜</div>

        <div className="aicta">
          <div className="aicta__icon">📷</div>
          <div>
            <div className="aicta__title">拍照识别 · 一键入库</div>
            <div className="aicta__desc">拍一张冰箱，自动列出食材，你确认即可</div>
          </div>
        </div>

        <div className="stats">
          <div className="stats__cell">
            <b className="stats__num">12</b>
            <span className="stats__label">在库</span>
          </div>
          <div className="stats__cell">
            <b className="stats__num" style={{ color: 'var(--color-brand)' }}>
              3
            </b>
            <span className="stats__label">临期</span>
          </div>
          <div className="stats__cell">
            <b className="stats__num">8</b>
            <span className="stats__label">品类</span>
          </div>
        </div>

        <SectionTitle title="今日先吃" more="全部" />

        <div className="rows">
          {useFirst.map((item) => (
            <div className="row" key={item.name}>
              <div className="row__icon">🥬</div>
              <div className="row__main">
                {item.name}
                <div className="row__sub">{item.where}</div>
              </div>
              <span className="stamp stamp--wait">优先吃</span>
            </div>
          ))}
        </div>

        <SectionTitle title="存放位置" more="4 区" />

        <div className="grid2">
          {storage.map((zone) => (
            <div className="quad" key={zone.name}>
              <div className="quad__title">{zone.name}</div>
              <div className="quad__num">{zone.count} 件</div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  )
}
