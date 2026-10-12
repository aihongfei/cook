import { useState } from 'react'
import Page from '@/components/ui/Page'
import WeekPlan from './components/WeekPlan'
import AiSuggestSheet from './components/AiSuggestSheet'
import AiChatSheet from './components/AiChatSheet'
import '../shared.scss'
import './discover.scss'

/**
 * 发现：今天吃什么 + 本周菜单 + AI 入口（决策引擎见 FEATURES.md M5，菜单安排见 M4 / F4-02，
 * AI 推荐与问答见 D-026）。
 *
 * AI 给**两个**入口、各管一件事：「帮你想」是让 AI 从菜谱库里挑几道能直接点的菜，
 * 「问 AI」是自由问答（食材怎么处理、多少量）。合成一个入口两边都不好使：
 * 想点菜的人拿到一段散文，想问事的人被要求"从清单里挑"。
 */
export default function DiscoverPage() {
  // 两个抽屉各自用 key 在打开时重挂载：关掉再打开就是干净的一次（上次的推荐/对话不留着）
  const [sheet, setSheet] = useState<'suggest' | 'chat' | null>(null)

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

        <div className="ai-entry">
          <button type="button" className="ai-entry__btn ai-entry__btn--suggest" onClick={() => setSheet('suggest')}>
            <span className="ai-entry__emoji" aria-hidden>
              🍳
            </span>
            <span className="ai-entry__text">
              <span className="ai-entry__title">AI 帮你想</span>
              <span className="ai-entry__sub">说说想吃什么，从菜谱里挑几道</span>
            </span>
          </button>
          <button type="button" className="ai-entry__btn" onClick={() => setSheet('chat')}>
            <span className="ai-entry__emoji" aria-hidden>
              💬
            </span>
            <span className="ai-entry__text">
              <span className="ai-entry__title">问 AI</span>
              <span className="ai-entry__sub">食材怎么处理、多少量</span>
            </span>
          </button>
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

      {sheet === 'suggest' && <AiSuggestSheet key="suggest" visible onClose={() => setSheet(null)} />}
      {sheet === 'chat' && <AiChatSheet key="chat" visible onClose={() => setSheet(null)} />}
    </Page>
  )
}

