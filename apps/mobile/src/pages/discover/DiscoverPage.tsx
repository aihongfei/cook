import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { useTodaySession } from '@/stores/today-session'
import { useSpreadSession } from '@/stores/spread-session'
import FamilyPicks from './components/FamilyPicks'
import AiChatSheet from './components/AiChatSheet'
import TodaySheet from './components/TodaySheet'
import SpreadSheet from './components/SpreadSheet'
import '../shared.scss'
import './discover.scss'

/**
 * 发现：今天吃什么 + 家人最爱 + 两个工具入口（决策引擎见 FEATURES.md M5，
 * 常用组合见 M4 / F4-04，备菜计划见 M4 / F4-03，AI 推荐与问答见 D-026）。
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
 *
 * ---
 *
 * ## 2026-10-16：**「本周菜单」整卡删掉**（用户：「发现也不要展示本周菜单了」）
 *
 * 那块东西是**同一份数据在第三个地方画的只读副本**：今天/明天/后天各午晚两餐的安排，
 * 点单页（可以操作）有、备菜计划页（排到第 7 天、每行能加菜）也有，只有这块既看不了更远、
 * 也什么都改不了（实测占 508px，发现页大半屏）。项目规矩是每类事实只留一个权威来源——
 * 一张单在两个页面各画一份，迟早会出现"这边待确认、那边已安排"的互相打脸。
 *
 * 它原来的两个出口（常用组合 / 备菜计划）**必须接住**：那是它们**唯一**的入口
 * （备菜计划另有一条绕路在购物清单页里），删卡就等于删功能。于是收成页面底部一行两枚胶囊，
 * 摆在内容之下——它们是"工具"，与上面两块"内容"分开摆。
 *
 * 找缺口（哪一餐还空着）**刻意不在这里补一个副本**：那是备菜计划页的本职，发现页再说一遍
 * 又成了第二个来源。真需要的话，那一页一点就能到。
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
  const location = useLocation()
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

        {/* 家人最爱（F5-02）："我们家平时吃什么"——回顾与找灵感 */}
        <FamilyPicks />

        {/*
          两个工具入口（原来挂在「本周菜单」卡头上，那块删掉之后搬到这里）。
          做成一行两枚并列的胶囊：它们是**整页最下面的一档**，视觉重量低于上面两块内容
          （用品牌淡底 + 描边，与「去安排」那种次要动作同一套语汇），但明确是能点的。
        */}
        <div className="discover-tools">
          <Link className="discover-tool" to="/combos" state={{ from: location.pathname }}>
            <span className="discover-tool__icon" aria-hidden>
              🧩
            </span>
            常用组合
          </Link>
          <Link className="discover-tool" to="/prep" state={{ from: location.pathname }}>
            <span className="discover-tool__icon" aria-hidden>
              🗓
            </span>
            备菜计划
          </Link>
        </div>
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
