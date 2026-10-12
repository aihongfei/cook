import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import { apiErrorMessage } from '@/api/client'
import { fetchRandomRecipe } from '@/api/recipes'
import WeekPlan from './components/WeekPlan'
import AiSuggestSheet from './components/AiSuggestSheet'
import AiChatSheet from './components/AiChatSheet'
import '../shared.scss'
import './discover.scss'

/**
 * 发现：今天吃什么（随机 + AI 合一）+ 本周菜单（决策引擎见 FEATURES.md M5，菜单安排见
 * M4 / F4-02，AI 推荐与问答见 D-026）。
 *
 * **"今天吃什么"和 AI 合成一块**：这两件事本来就是同一个问题——用户站在灶台前的困惑是
 * "今天做点什么"，随机摇一道和让 AI 挑几道只是两种解法。原先拆成上下两块（一块橙卡 +
 * 一块双按钮）占了首页近 200px 的黄金位置，说的还是同一件事。现在收成**一张卡、
 * 一行标题、两条出路**：左边「摇一道」（自己拿主意，立刻给结果），右边「AI 帮你想」
 * （让 AI 挑，要等十几秒）。问答是另一种问题（"豆腐怎么存"），所以只给小字入口。
 */
export default function DiscoverPage() {
  // 两个抽屉各自用 key 在打开时重挂载：关掉再打开就是干净的一次（上次的推荐/对话不留着）
  const [sheet, setSheet] = useState<'suggest' | 'chat' | null>(null)
  const [shaking, setShaking] = useState(false)
  const navigate = useNavigate()

  /** 摇一道：随机取库里的一道菜，直接落到它的详情页（那里能点「想吃这道」） */
  const shake = async () => {
    if (shaking) return
    setShaking(true)
    try {
      const recipe = await fetchRandomRecipe()
      if (!recipe) {
        // 空库是正常状态，不是错误：说清楚"还没菜可摇"
        toast.error('菜谱小书里还没有菜，先去加几道')
        return
      }
      navigate(`/recipes/${recipe.id}`, { state: { from: '/discover' } })
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setShaking(false)
    }
  }

  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">发现</div>
        <div className="psub">今天不知道吃什么，交给它</div>

        {/* 一张卡装下"今天吃什么"的全部出路：随机摇一道 / 让 AI 挑 / 直接问 AI */}
        <section className="today">
          <div className="today__head">
            <span className="today__en">WHAT TO EAT TODAY</span>
            <span className="today__title">今天吃什么？</span>
          </div>

          <div className="today__actions">
            <button type="button" className="today__shake" disabled={shaking} onClick={() => void shake()}>
              <span className="today__shake-emoji" aria-hidden>
                🎲
              </span>
              <span className="today__shake-text">{shaking ? '正在摇…' : '摇一道'}</span>
            </button>
            <button type="button" className="today__ai" onClick={() => setSheet('suggest')}>
              <span className="today__ai-emoji" aria-hidden>
                🍳
              </span>
              <span className="today__ai-text">AI 帮你想</span>
            </button>
          </div>

          {/* 问答是另一种问题（"豆腐怎么存"而不是"今晚吃什么"），给小字入口而不是第三个大按钮 */}
          <button type="button" className="today__ask" onClick={() => setSheet('chat')}>
            下厨上的问题想问问人？点这里问 AI →
          </button>
        </section>

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
