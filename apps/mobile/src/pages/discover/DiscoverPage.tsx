import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import { apiErrorMessage } from '@/api/client'
import { fetchRandomRecipe } from '@/api/recipes'
import { useAiSuggestSession } from '@/stores/ai-suggest-session'
import FamilyPicks from './components/FamilyPicks'
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
  /*
   * 两个抽屉各自用 key 在打开时重挂载：关掉再打开就是干净的一次（上次的推荐/对话不留着）。
   *
   * **「AI 帮你想」的开合在 store 里**（`stores/ai-suggest-session`），不在这里的 useState：
   * 用户点推荐里的菜名去看详情时，本页会被卸载，useState 会连同"抽屉开着"这个事实一起丢，
   * 返回时就变成关着的了（用户 2026-10-13 明确要求"返回时还是打开的、保持原样"）。
   * 开一次走 `start()`（清掉上一场），关一次走 `close()`（同样清干净）。
   * 「问 AI」没有这个需求（对话里没有可点的菜名入口），仍是本地 state。
   */
  const [sheet, setSheet] = useState<'suggest' | 'chat' | null>(null)
  const suggestOpen = useAiSuggestSession((state) => state.open)
  const startSuggest = useAiSuggestSession((state) => state.start)
  const closeSuggest = useAiSuggestSession((state) => state.close)
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
        <PageHeader title="发现" subtitle="今天不知道吃什么，交给它" art="discover" />

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
            <button type="button" className="today__ai" onClick={startSuggest}>
              <span className="today__ai-emoji" aria-hidden>
                🍳
              </span>
              <span className="today__ai-text">AI 帮你想</span>
            </button>
          </div>

          {/* 问答是另一种问题（"豆腐怎么存"而不是"今晚吃什么"），给小字入口而不是第三个大按钮。
              只有后半句可点：前面是说明（说明不该看起来能点），后面的动作词才是入口。 */}
          <div className="today__ask">
            <span className="today__ask-text">下厨上的问题想问问人？</span>
            <button type="button" className="today__ask-link" onClick={() => setSheet('chat')}>
              点这里问 AI →
            </button>
          </div>
        </section>

        {/* 家人最爱（F5-02）：排在"本周菜单"之后——先看"这几天吃什么"（当下要办的），
            再看"我们家平时吃什么"（回顾与找灵感）。 */}
        <FamilyPicks />

        <WeekPlan />
      </div>

      {/* 「AI 帮你想」的开关来自 store：点菜名进详情再返回时它还得开着（见上方注释）。
          key 只在"新开一次"时变（start 会清空 picks），所以续上时是同一个实例、内容原样 */}
      {suggestOpen && <AiSuggestSheet key="suggest" visible onClose={closeSuggest} />}
      {sheet === 'chat' && <AiChatSheet key="chat" visible onClose={() => setSheet(null)} />}
    </Page>
  )
}
