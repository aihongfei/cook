import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DotLoading } from 'antd-mobile'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { useAiPrompts, useAiSuggest, useAiStatus, type SuggestedPick } from '@/api/ai'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { useFamily } from '@/api/family'
import { nextMealDefaults } from '@/pages/order/next-meal'
import { useAiSuggestSession } from '@/stores/ai-suggest-session'
import { pickHints } from '../ai-prompts'
import '../../shared.scss'

/**
 * 「AI 帮你想」（M16 子集 / D-026）。
 *
 * 定位是**掌勺人的参谋**：说一句想吃什么，从**本库真实的菜**里挑几道，直接就能点。
 * 推荐里的菜名与 id 都由后端按库里数据回填（模型编造的 id 会被丢掉），
 * 所以这里可以放心把 pick 当"库里存在的菜"用。
 *
 * 五个刻意的设计：
 * - **未配置时明说去哪配**，不给假的推荐撑场面（假数据会让用户以为 AI 在工作）；
 * - **推荐结果给"点这道"**，而不是只让用户看一眼——看完再自己翻菜单找那道菜，
 *   等于白推荐（这是他为什么来用 AI，而不是去菜谱库翻）；
 * - **菜名点得进详情、返回时抽屉原样还在**（用户 2026-10-13 提）：「点这道」是"我要吃"，
 *   "它到底怎么做"是另一件事——想看一眼做法再决定点哪道，是这个入口最自然的用法。
 *   会话状态因此放在 `stores/ai-suggest-session`（路由跳转会卸载本组件，放 useState 会全丢）；
 * - **快问由 AI 按这家人的情况现生成**（用户 2026-10-12：「内置的这些不够用」），
 *   写死的那份只作兜底：没配、还没生成好、生成失败时照旧能用（见 ai-prompts）；
 * - **「换一批」不再调模型**，就在拿到的那批里抽——点一下等十几秒的话，那按钮等于没了。
 */

/** 等结果时的阶段提示（模型要 11～40 秒，明说在干什么比一个转圈更有耐心） */
const SUGGEST_TIPS = ['正在翻菜谱小书…', '在挑荤素搭配…', '快好了，看看合不合口…']

interface AiSuggestSheetProps {
  visible: boolean
  onClose: () => void
}

export default function AiSuggestSheet({ visible, onClose }: AiSuggestSheetProps) {
  const status = useAiStatus()
  const family = useFamily()
  const options = useOrderOptions()
  const suggest = useAiSuggest()
  const addItem = useAddOrderItem()
  /*
   * 会话状态全部来自 store（见该文件的说明）：推荐、输入、已加入标记、快问那一排。
   * 这样"点菜名进详情 → 返回"时它们都还在，抽屉也还是开着的。
   */
  const hint = useAiSuggestSession((state) => state.hint)
  const picks = useAiSuggestSession((state) => state.picks)
  const added = useAiSuggestSession((state) => state.added)
  const quickHints = useAiSuggestSession((state) => state.quickHints)
  const setHint = useAiSuggestSession((state) => state.setHint)
  const setPicks = useAiSuggestSession((state) => state.setPicks)
  const markAdded = useAiSuggestSession((state) => state.markAdded)
  const clearAdded = useAiSuggestSession((state) => state.clearAdded)
  const setQuickHints = useAiSuggestSession((state) => state.setQuickHints)
  /*
   * 这次挂载是"续上"还是"新开"：新开时 `start()` 会把 picks 清成 null，
   * 所以**有推荐就是续上**（从详情返回、或切走再回来）。
   * 用 useState 定住：后面 ask() 会改 picks，判定不能跟着变。
   */
  const [resumed] = useState(() => useAiSuggestSession.getState().picks !== null)
  // 快问：优先用 AI 按这个家现生成的那批（见 api/ai 的 useAiPrompts）。
  // `enabled` 等 status 回来再开——没配 AI 时不该白发一次注定 503 的请求。
  // **续上时不再生成**：那不是"新点开一次"，重生成只会让用户刚看到的那排快问自己换掉；
  // 失败不重试也不报错：这只是入口的引导语，退回写死的那份就行（用户不该为它看见错误）
  const aiPrompts = useAiPrompts(status.data?.configured === true && !resumed)
  const [tip, setTip] = useState(0)
  // 这个抽屉**没有"写入成功后自动收起"**：一次问出好几道，用户要接着挑（见 pointAt）。
  // 所以不需要 BottomSheet 的 imperative handle，关闭全交给用户（点遮罩/下拉）。

  /*
   * 快问那一排的播种与替换，都在这里（**不放在 store 的 start() 里**）：
   * 抽哪一批取决于"AI 那批到了没有"，而这个判断只有本组件知道。
   *
   * ① 空着就抽一批兜底的（续上时它已经有值，不会重抽——用户离开前看到的那一版要原样留着）；
   * ② AI 那批到了就重抽一次：抽屉一打开就发请求，用户看到的头几秒必然是兜底那批；
   *    不做这一步他会一直看着兜底版本，AI 生成的等于白花。抽完就定住——不能每轮渲染都重抽，
   *    那样用户刚要点的那个标签会自己跑掉。
   *
   * lint 的 react(set-state-in-effect) 会被点上：规则的本意是"别用 effect 派生状态"，
   * 而这里的值来自**异步到达的外部数据**（先兜底、后真货），没有"渲染期纯算出来"的写法
   * ——用 useMemo 的话 React 允许丢弃缓存重算，标签会偶尔自己变（正是要避免的那个毛病）。
   * 与 BottomSheet 里那处同一处理：就地豁免并写明理由。
   */
  const aiBatch = aiPrompts.data?.hints
  useEffect(() => {
    // 续上时跳过：这一排快问是用户离开前看到的那一版，回来该原样还在
    if (resumed) return
    // oxlint-disable-next-line react/set-state-in-effect
    if (aiBatch && aiBatch.length > 0) setQuickHints(pickHints(aiBatch))
    else if (quickHints.length === 0) setQuickHints(pickHints())
  }, [aiBatch, resumed, quickHints.length, setQuickHints])

  // 等结果时轮播阶段提示。复位写在**发起请求的事件里**（见 ask）而不是这里：
  // 在 effect 里 setState 会多一轮渲染，也会被 react-hooks 的 set-state-in-effect 拦下
  useEffect(() => {
    if (!suggest.isPending) return
    const timer = setInterval(() => setTip((value) => (value + 1) % SUGGEST_TIPS.length), 5000)
    return () => clearInterval(timer)
  }, [suggest.isPending])

  // 推荐的菜进「下一餐」——与「想吃这道」同一份规则（见 order/next-meal）：
  // 同一个"点这道"在哪个入口都该落到同一餐，用户不会去记"AI 这边默认是明天午饭"
  const target = nextMealDefaults(options.data?.dayOptions ?? [])

  const ask = (text: string) => {
    const value = text.trim()
    setHint(value)
    setTip(0)
    /*
     * 先把上一次的结果清掉（用户 2026-10-13：「问完了下面有菜了时候，再问一次，
     * 那两个菜没有清掉，还是显示在那里」）。清掉不只是好看：新问题的结果还没回来时，
     * 下面留着旧推荐，用户会以为那就是这一问的答案。
     * 已点过的标记也一起清——新一批推荐是另一批菜，留着旧菜名没有意义。
     */
    setPicks(null)
    clearAdded()
    suggest.mutate(
      { hint: value || undefined },
      {
        onSuccess: (result) => setPicks(result.picks),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const pointAt = (pick: SuggestedPick) => {
    if (!target.day || !target.meal) return
    addItem.mutate(
      { recipeId: pick.recipeId, mealDate: target.day, meal: target.meal },
      {
        onSuccess: (card) => {
          toast.success(`已把「${pick.name}」加进${card.mealLabel}`)
          // 不关抽屉：一次问出好几道，用户通常要连着点几道（关掉的话得重新问一遍）
          markAdded(pick.recipeId)
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet visible={visible} title="AI 帮你想" onClose={onClose}>
      {status.data && !status.data.configured ? (
        // 未配置就把话说清楚：怎么配、配完会怎样。不给假推荐。
        <p className="ai__tip">
          还没接上 AI，所以这里先不给推荐——省得你以为是真在想。
          在根目录 .env（本机直跑则 services/api/.env）里填 AI_API_BASE / AI_API_KEY / AI_MODEL，
          重启后端就能用。其余功能不受影响。
        </p>
      ) : (
        <>
          <p className="ai__lead">说说想吃什么，我从菜谱小书里挑几道能直接安排的。</p>

          <div className="ai__hint-row">
            <span className="ai__hint-label">常问</span>
            <div className="ai__hints">
              {quickHints.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="ai__hint"
                  disabled={suggest.isPending}
                  onClick={() => ask(item)}
                >
                  {item}
                </button>
              ))}
              {/* 「换一批」而不是把池子铺满：铺满会盖住输入框（这个入口不只是点标签，还要能自己说）。
                  它**不重新调模型**——就在已经拿到的那批里抽；点一下要等十几秒的话等于没了 */}
              <button
                type="button"
                className="ai__hint ai__hint--more"
                disabled={suggest.isPending}
                onClick={() => setQuickHints(pickHints(aiBatch))}
              >
                换一批 ↻
              </button>
            </div>
          </div>

          <div className="ai__ask">
            <input
              className="ai__note"
              value={hint}
              maxLength={200}
              placeholder="也可以自己说，如：想吃酸的、有小孩"
              onChange={(event) => setHint(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !suggest.isPending) ask(hint)
              }}
            />
            <button
              type="button"
              className="ai__go"
              disabled={suggest.isPending}
              onClick={() => ask(hint)}
            >
              {suggest.isPending ? <DotLoading color="currentColor" /> : '想几道'}
            </button>
          </div>

          {/* 推荐要等整包结果（结构化输出不能边收边用），所以给的是"骨架 + 阶段提示"：
              骨架让位置先占住、不至于等的时候界面一动不动；阶段提示让等待有进度感 */}
          {suggest.isPending && (
            <>
              <p className="ai__waiting">{SUGGEST_TIPS[tip]}</p>
              <div className="ai__skeleton">
                {/* 按新的一批上限铺 6 行（SUGGEST_PICKS_MAX）：铺不满的话结果一回来
                    下面会"啪"地多出一截，看起来像界面在跳 */}
                {[0, 1, 2, 3, 4, 5].map((row) => (
                  <div className="ai__skeleton-row" key={row}>
                    <span className="ai__skeleton-line ai__skeleton-line--name" />
                    <span className="ai__skeleton-line ai__skeleton-line--reason" />
                  </div>
                ))}
              </div>
            </>
          )}

          {picks?.length === 0 && !suggest.isPending && (
            <p className="ai__hint">
              这次没挑出来（可能库里没有合口味的）。换个说法再试，或去
              <Link className="weekplan__link" to="/recipes" onClick={onClose}>
                菜谱小书
              </Link>
              自己翻翻。
            </p>
          )}

          {picks && picks.length > 0 && (
            <div className="ai__picks">
              {picks.map((pick, index) => {
                const done = added.includes(pick.recipeId)
                return (
                  <div className={['ai__pick', done && 'is-done'].filter(Boolean).join(' ')} key={pick.recipeId}>
                    {/* 序号不是装饰：它是"AI 从候选里挑出来的顺序"，
                        用户一眼能看出这是 AI 选的几条而不是菜单列表 */}
                    <span className="ai__pick-index" aria-hidden>
                      {index + 1}
                    </span>
                    {/*
                     * 菜名点得进详情（用户 2026-10-13 提）：**想看一眼怎么做再决定点哪道**，
                     * 是这个入口最自然的用法——「点这道」是"我要吃"，而"它到底怎么做"是
                     * 另一件事。链到详情页，带上来源 `/discover`（返回按钮回发现页）。
                     *
                     * 返回时抽屉为什么还在、推荐为什么原样：本组件不因这次跳转卸载吗？——
                     * 会卸载。所以会话状态在 stores/ai-suggest-session 里（推荐/输入/已加入
                     * 标记都在那儿），`open` 也一直没被改过；详情页的返回按钮回到 /discover，
                     * 抽屉据此重建、内容照旧。**这条路径不调任何 store 动作**，正是关键。
                     */}
                    <Link className="ai__pick-main" to={`/recipes/${encodeURIComponent(pick.recipeId)}`} state={{ from: '/discover' }}>
                      <span className="ai__pick-name">{pick.name}</span>
                      {pick.reason && <span className="ai__pick-reason">{pick.reason}</span>}
                    </Link>
                    {/* 点过的那道置灰（同「问 AI」的建议卡）：它已经在菜单里了，
                        再点一次就是同一道菜加两遍 */}
                    {done ? (
                      <span className="ai__pick-done">已加入</span>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost ai__pick-go"
                        disabled={addItem.isPending || !family.data}
                        onClick={() => pointAt(pick)}
                      >
                        点这道
                      </button>
                    )}
                  </div>
                )
              })}
              <p className="ai__foot">
                推荐的菜都在菜谱小书里，点菜名能看做法；点「点这道」会加进今天这一餐，点过的会标记出来，可以接着挑下一道。
              </p>
            </div>
          )}
        </>
      )}
    </BottomSheet>
  )
}
