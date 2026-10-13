import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import { apiErrorMessage } from '@/api/client'
import { fetchRandomRecipe } from '@/api/recipes'
import { useTodaySession } from '@/stores/today-session'
import FamilyPicks from './components/FamilyPicks'
import WeekPlan from './components/WeekPlan'
import AiChatSheet from './components/AiChatSheet'
import TodaySheet from './components/TodaySheet'
import '../shared.scss'
import './discover.scss'

/**
 * 发现：今天吃什么 + 本周菜单（决策引擎见 FEATURES.md M5，菜单安排见 M4 / F4-02，
 * AI 推荐与问答见 D-026）。
 *
 * **这一块 2026-10-13 又合了一次**（见 D-061）：原先卡上三个出口（摇一道 / 帮我决定 /
 * AI 帮你想），用户提出「帮我决定和 ai 帮你想是不是有点重复了」。它们确实都在说
 * "我替你决定"，于是收成**两条出路**：
 *
 * - 「摇一道」（F5-01）：**库里随机抽一道**，公平、立刻，但不知道你家有什么；
 * - 「帮我决定」（F5-05 + M16 合并）：打开先给**一道照着冰箱与口味挑的**（纯规则、
 *   毫秒级、**不依赖 AI 配置**），下面一行"都不合意？说说想吃什么"才展开 AI（要等十几秒）。
 *
 * 合并的收益不只是少一个按钮：**这条最常用的路不再会因为没配密钥而死掉**。
 * 问答是另一种问题（"豆腐怎么存"），所以只给小字入口。
 */
export default function DiscoverPage() {
  /*
   * 两个抽屉各自用 key 在打开时重挂载：关掉再打开就是干净的一次（上一次的东西不留着）。
   *
   * **「帮我决定」的开合在 store 里**（`stores/today-session`），不在这里的 useState：
   * 用户点抽屉里的菜名去看详情时，本页会被卸载，useState 会连同"抽屉开着"这个事实一起丢，
   * 返回时就变成关着的了（用户 2026-10-13 明确要求"返回时还是打开的、保持原样"）。
   * 开一次走 `start()`（清掉上一场），关一次走 `close()`（同样清干净）。
   * 「问 AI」没有这个需求（对话里没有可点的菜名入口），仍是本地 state。
   */
  const [sheet, setSheet] = useState<'chat' | null>(null)
  const todayOpen = useTodaySession((state) => state.open)
  const startToday = useTodaySession((state) => state.start)
  const closeToday = useTodaySession((state) => state.close)
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

          {/*
            两条出路，**一行并列**：两个都立刻给结果，只是"懂不懂你家"不一样——
            「摇一道」是库里随机抽（公平，但可能摇到一道缺六样料的），
            「帮我决定」是照着冰箱、口味与平时爱吃的挑（F5-05）。
            「AI 帮你想」不再单独占一行：它已经收进「帮我决定」那个抽屉的第二半
            （见 D-061）——三个出口里两个都叫"我替你决定"，是用户提出的那个重复。
          */}
          <div className="today__row">
            <button type="button" className="today__shake" disabled={shaking} onClick={() => void shake()}>
              <span className="today__shake-emoji" aria-hidden>
                🎲
              </span>
              <span className="today__shake-text">{shaking ? '正在摇…' : '摇一道'}</span>
            </button>
            <button type="button" className="today__decide" onClick={startToday}>
              <span className="today__decide-emoji" aria-hidden>
                ✨
              </span>
              <span className="today__decide-text">帮我决定</span>
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

      {/* 「帮我决定 + AI」的开关来自 store：点菜名进详情再返回时它还得开着，
          上面那道菜与下面那份 AI 推荐都要原样，而且**不许重新挑**——用户正要评估
          刚才那道菜，换一道等于把答案抽走了（用户 2026-10-13 的原话："保持原样"）。
          key 只在"新开一次"时变（start 会清空一切），所以续上时是同一个实例 */}
      {todayOpen && <TodaySheet key="today" visible onClose={closeToday} />}
      {sheet === 'chat' && <AiChatSheet key="chat" visible onClose={() => setSheet(null)} />}
    </Page>
  )
}
