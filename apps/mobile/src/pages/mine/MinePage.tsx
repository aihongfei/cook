import Page from '@/components/ui/Page'
import SectionTitle from '@/components/ui/SectionTitle'
import '../shared.scss'

const preferenceRows = [
  { icon: '🌶️', title: '口味、忌口与过敏', sub: '微辣 · 少盐 · 不吃香菜' },
  { icon: '👨‍👩‍👧', title: '家庭共享与成员', sub: '3 位成员' },
  { icon: '🔔', title: '家庭消息提醒', sub: '菜单安排与饭已做好通知' },
]

const aiRows = [
  { icon: '🤖', title: 'AI 模型配置', sub: 'pi-agent · 自定义 provider 与模型' },
  { icon: '💬', title: '提示词模板', sub: '冰箱识别 / 菜品识别 / 营养分析' },
]

/** 我的：账号与设置 */
export default function MinePage() {
  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">我的</div>

        <div className="me">
          <div className="me__avatar">🐰</div>
          <div style={{ flex: 1 }}>
            <div className="me__name">妈妈</div>
            <div className="me__id">ID: 御厨8373</div>
          </div>
          <button type="button" className="btn-ghost">
            切换成员
          </button>
        </div>

        <SectionTitle title="我的设置" />

        <div className="rows" style={{ marginTop: 0 }}>
          {preferenceRows.map((row) => (
            <div className="row" key={row.title}>
              <div className="row__icon">{row.icon}</div>
              <div className="row__main">
                {row.title}
                <div className="row__sub">{row.sub}</div>
              </div>
              <span className="row__arrow">›</span>
            </div>
          ))}
        </div>

        <SectionTitle title="AI 设置" />

        <div className="rows" style={{ marginTop: 0 }}>
          {aiRows.map((row) => (
            <div className="row" key={row.title}>
              <div className="row__icon">{row.icon}</div>
              <div className="row__main">
                {row.title}
                <div className="row__sub">{row.sub}</div>
              </div>
              <span className="row__arrow">›</span>
            </div>
          ))}
        </div>
      </div>
    </Page>
  )
}
