import { useState } from 'react'
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { useTodaySession } from '@/stores/today-session'
import { useSpreadSession } from '@/stores/spread-session'
import FamilyPicks from './components/FamilyPicks'
import WeekPlan from './components/WeekPlan'
import AiChatSheet from './components/AiChatSheet'
import TodaySheet from './components/TodaySheet'
import SpreadSheet from './components/SpreadSheet'
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
 * - 「摇一桌」（F5-01，2026-10-15 由「摇一道」升级）：**按这一餐几个人吃配一桌**，
 *   有荤有素有汤、过忌口、每道带一句真理由，可以整组加进这一餐；
 * - 「帮我决定」（F5-05 + M16 合并）：打开先给**一道照着冰箱与口味挑的**（纯规则、
 *   毫秒级、**不依赖 AI 配置**），下面一行"都不合意？说说想吃什么"才展开 AI（要等十几秒）。
 *
 * 两者都留着是因为回答的问题不同：这边是"今晚这一桌配什么"，那边是"我拿不定主意，你挑一道"。
 * 合并的收益不只是少一个按钮：**这条最常用的路不再会因为没配密钥而死掉**。
 * 问答是另一种问题（"豆腐怎么存"），所以只给小字入口。
 */
export default function DiscoverPage() {
  /*
   * 「问 AI」的开关是本地 state（对话里没有可点的菜名入口，没有"返回时还得开着"的需求）；
   * 另外两个抽屉的开合都在 store 里：用户点抽屉里的菜名去看详情时，本页会被卸载，
   * useState 会连同"抽屉开着"这个事实一起丢，返回时就变成关着的了
   * （用户 2026-10-13 明确要求"返回时还是打开的、保持原样"）。
   * 开一次走 `start()`（清掉上一场），关一次走 `close()`（同样清干净）。
   */
  const [sheet, setSheet] = useState<'chat' | null>(null)
  const todayOpen = useTodaySession((state) => state.open)
  const startToday = useTodaySession((state) => state.start)
  const closeToday = useTodaySession((state) => state.close)
  const spreadOpen = useSpreadSession((state) => state.open)
  const startSpread = useSpreadSession((state) => state.start)
  const closeSpread = useSpreadSession((state) => state.close)

  return (
    <Page>
      <div className="pscreen">
        <PageHeader title="发现" subtitle="今天不知道吃什么，交给它" art="discover" />

        {/* 一张卡装下"今天吃什么"的全部出路：配一桌 / 让 AI 挑 / 直接问 AI */}
        <section className="today">
          <div className="today__head">
            <span className="today__en">WHAT TO EAT TODAY</span>
            <span className="today__title">今天吃什么？</span>
          </div>

          {/*
            两条出路，**一行并列**：两个都立刻给结果，只是"给多少"不一样——
            「摇一桌」是配够这一餐吃的几道（有荤有素有汤，还能整组加进菜单），
            「帮我决定」是照着冰箱、口味与平时爱吃的挑**一道**（F5-05）。
            「AI 帮你想」不再单独占一行：它已经收进「帮我决定」那个抽屉的第二半
            （见 D-061）——三个出口里两个都叫"我替你决定"，是用户提出的那个重复。
          */}
          <div className="today__row">
            <button
              type="button"
              className="today__shake"
              onClick={() => {
                // 每一场都是干净的一桌（上一场的人数与"已加入"不带过来）
                startSpread()
              }}
            >
              <span className="today__shake-emoji" aria-hidden>
                🎲
              </span>
              <span className="today__shake-text">摇一桌</span>
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
      {spreadOpen && <SpreadSheet key="spread" visible onClose={closeSpread} />}
      {sheet === 'chat' && <AiChatSheet key="chat" visible onClose={() => setSheet(null)} />}
    </Page>
  )
}
