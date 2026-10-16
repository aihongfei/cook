import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { DotLoading } from 'antd-mobile'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { useDecide, useDecideForOccasion } from '@/api/decide'
import { useOccasions } from '@/api/discover-page'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { useFamily } from '@/api/family'
import { nextMealDefaults } from '@/pages/order/next-meal'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import { useTodaySession } from '@/stores/today-session'
import AiSuggestPanel from './AiSuggestPanel'
import '../../shared.scss'

/**
 * 「今天吃什么」（M5 / F5-05 + M16 子集合并后，见 D-061）。
 *
 * 2026-10-13 用户提出「帮我决定」与「AI 帮你想」看着重复。合并的方式是**保留两半、
 * 收进一个抽屉**，因为它们回答的其实是两个问题：
 *
 * - **上半：立刻给一道**（F5-05）。纯规则、懂冰箱与口味、毫秒级，**没配 AI 也能用**。
 *   用户来这儿最常见的心态是"随便，你定"——这时让他等十几秒、或者让他先回答一个问题，
 *   都是把成本还给他。
 * - **下半：想提要求时才问 AI**（M16 子集）。"想吃酸的、有小孩" 这类条件只有模型能处理，
 *   但它是**可选的第二步**，而不是进门的前提。
 *
 * 这样合并的好处不只是少一个按钮（三个出口里两个都说"我替你决定"）：
 * **这条最常用的路不再依赖 AI 配置**。原先没配密钥时「AI 帮你想」只能显示一句"还没接上 AI"，
 * 而「帮我决定」在同一次点击里就已经把菜摆出来了。
 *
 * 五件事刻意的：
 *
 * - **打开即要一个主意**：不让用户再按一下——他已经按过按钮了；
 * - **会话状态在 store 里**（`stores/today-session`）：菜名能点进详情，那是一次路由跳转，
 *   返回时上面那道菜、下面那份 AI 推荐都必须原样还在（用户对「AI 帮你想」的原话是
 *   "返回时还是打开的、保持原样"）；
 * - **说清为什么是这道**（后端拼的那句）：这是它与「摇一道」的全部区别；
 * - **点完不自动关**：用户可能想换一道、想去看做法，也可能接着用下半去提要求；
 * - **拿不出菜时给出去路**（空库 / 冰箱空 / 口味排掉了全部）：三种情况下一步完全不同。
 */
/**
 * 下半收起时那段退场动画的时长（ms）。要**与 CSS 里的 `today-ai-out` 对上**：
 * JS 用它决定何时真正卸载面板，CSS 用它播动画，两边差太多会看到"动画没完就消失"
 * 或者"动画完了还空着一块"。
 */
const AI_EXIT_MS = 180

export default function TodaySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const family = useFamily()
  const options = useOrderOptions()
  const decide = useDecide()
  const addItem = useAddOrderItem()

  const result = useTodaySession((state) => state.result)
  const seen = useTodaySession((state) => state.seen)
  const added = useTodaySession((state) => state.decideAdded)
  const setResult = useTodaySession((state) => state.setResult)
  const pushSeen = useTodaySession((state) => state.pushSeen)
  const setAdded = useTodaySession((state) => state.setDecideAdded)
  const reset = useTodaySession((state) => state.reset)

  /**
   * 下半（AI）是**用户主动展开**的：默认收着，点一下才展开。
   *
   * 收着而不是直接铺开，是因为铺开会让抽屉打开时很高（快捷词 + 输入框 + 结果），
   * 而多数人此刻要的只是上面那一道。展开状态**在 store 里**：点 AI 推荐的菜名去看做法、
   * 再返回时那块必须还是展开的（用户对「AI 帮你想」的原话："返回时还是打开的、保持原样"）。
   */
  const aiOpen = useTodaySession((state) => state.aiOpen)
  const setAiOpen = useTodaySession((state) => state.setAiOpen)

  /**
   * 展开/收起。
   *
   * 收起时先进入 `closing`（动画期间面板还在），动画结束再真正卸载——见下面那段注释。
   * 用 `setTimeout` 而不是 `transitionend`：这一块是**内容高矮变化**（height: auto 没法过渡），
   * 靠的是子元素的入场/退场两段动画，`transitionend` 在容器上不会触发。
   */
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)

  /*
   * 「换个场合挑」（2026-10-16 定，见 D-110）：原来发现页上那四个场景词**收进这里**。
   *
   * 为什么合并：用户当时问「"今天想吃什么感觉的"和 ai 帮决定是不是重复了」——确实像。
   * 它俩都在回答"我想不出吃什么"，而这一页的大标题本来就是「今天吃什么？」；
   * 2026-10-13 已经有过一次同类合并（两个"我替你决定"收进这个抽屉，见 D-061）。
   * 但两者不是同一件事：抽屉里给的是**一道**（点「就它了」就进菜单），场景词给的是一**批**
   * （要自己逛）。所以合并的方向不是删掉，而是**把场合变成这里的一个可选条件**：
   * 默认不问场合，想收窄的时候点一下。
   *
   * 合并不只是少一块：`decide` 原先只读冰箱 / 口味 / 做过的菜，**它不知道场合**
   * ——这一行给了它一个新维度。而因为是可选的，默认那条路（毫秒级、纯规则、
   * 不依赖 AI）一个字没变。
   */
  const occasion = useTodaySession((state) => state.occasion)
  const setOccasion = useTodaySession((state) => state.setOccasion)
  const occasions = useOccasions()
  const forOccasion = useDecideForOccasion()

  const toggleAi = () => {
    if (aiOpen) {
      setAiOpen(false)
      setClosing(true)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => setClosing(false), AI_EXIT_MS)
    } else {
      // 展开时若上一次的收起还没走完，取消它（连点两下不能把面板卸载掉）
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      setClosing(false)
      setAiOpen(true)
    }
  }

  // 卸载时清掉计时器：它回调的是 setState，组件没了还跑就是白跑（React 会警告）
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  /*
   * 这次挂载是"续上"还是"新开"：`start()` 会把 result 清成 null，所以**有结果就是续上**
   * （从详情返回）。用 useState 定住：后面 ask() 会改 result，判定不能跟着变
   * （与 AiSuggestPanel 的 `resumed` 同一处理）。
   */
  const [resumed] = useState(() => useTodaySession.getState().result !== null)

  /*
   * 新开时问一次，**在 effect 里**（不要在渲染期做这件事）。
   *
   * 两条踩过的坑：
   * ① **"问过了没有"这个标记必须在 store 里**（`asked`），不能只是组件 state：
   *    StrictMode 会"挂载 → 卸载 → 再挂载"，组件 state 会重置，于是问**两次**，
   *    而后回来的那次结果会把已经显示出来的那道菜**悄悄换掉**——用户刚看到一道菜、
   *    还没读完理由它自己变了（浏览器实测：先"番茄炒蛋"，一秒后变成另一道）。
   * ② **别在渲染期调 store 动作**。第一版为了省一次渲染，把"标记已问 + 发请求"都放在
   *    渲染期，结果是 `markAsked` 这个 store 变更把**当前这次渲染整个丢弃**了
   *    （React 检测到渲染期外部 store 变了就重渲），连带着刚发出去的那次请求也没落到
   *    界面上——抽屉打开后只有一句引导语，菜永远不出现。effect 里做就没有这个问题。
   */
  const askedRef = useRef(false)
  useEffect(() => {
    if (!visible || askedRef.current) return
    askedRef.current = true
    const session = useTodaySession.getState()
    if (session.asked) return
    session.markAsked()
    // 续上（从详情返回）时不重新挑：用户正要看的是刚才那道菜
    if (resumed) return
    ask([])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载/可见时跑一次，ask 每次渲染都是新函数
  }, [visible, resumed])

  function ask(exclude: string[]) {
    decide.mutate(exclude, {
      onSuccess: (data) => setResult(data),
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  const recipe = result?.recipe ?? null
  // 与「想吃这道」「AI 帮你想」共用同一份规则：同一个"点这道"在哪个入口都落到同一餐
  const target = nextMealDefaults(options.data?.dayOptions ?? [])

  const swap = () => {
    if (!recipe) return
    pushSeen(recipe.id)
    setAdded(false)
    reset()
    // 把已经看过的排除掉：否则"换一道"可能换回同一道（连点两次看到同一道菜就是坏了）
    ask([...seen, recipe.id])
  }

  const take = () => {
    if (!recipe || !target.day || !target.meal) return
    addItem.mutate(
      { recipeId: recipe.id, mealDate: target.day, meal: target.meal },
      {
        onSuccess: (card) => {
          toast.success(`已把「${recipe.name}」加进${card.mealLabel}`)
          // 不关抽屉（见文件头）：用户可能还想换一道看看，或点菜名去看做法
          setAdded(true)
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  /**
   * 点一枚场合胶囊：**同名的再点一下 = 取消**（回到不问场合）。
   *
   * 取消时不是"把上一次的结果留下来"，而是**重新问一次不带场合的**：用户取消场合，
   * 意思就是"刚才那个限制不要了，重新给我挑"——留着一道为了宴客挑的菜、只把胶囊弹起来，
   * 会让人以为按钮没生效（菜没变）。这一条是刻意的，不是偷懒。
   */
  function pickOccasion(tag: string) {
    const next = occasion === tag ? null : tag
    const excluding = next ? [] : seen
    forOccasion.mutate(
      { occasion: next ?? '', exclude: excluding },
      {
        onSuccess: (data) => {
          setOccasion(next)
          setResult(data)
          setAdded(false)
          /*
           * 把这一道记进"看过"：之后点「换一道」不会换回它。
           * **取消场合这一趟不记**——那一次问的是不带场合的池子，与这里挑的这道无关。
           */
          if (next && data.recipe) pushSeen(data.recipe.id)
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet visible={visible} title="今天吃什么" onClose={onClose}>
      {/*
        导语跟着场合变：用户点了一枚胶囊，第一句话就要说明"这一次是按那个场合挑的"
        （后端也会把那句话拼进 `reason`，但那是菜名下面那一行小字——用户先看到的是这里）。
      */}
      <p className="decide__lead">
        {occasion
          ? `照你说的「${occasions.data?.items.find((item) => item.tag === occasion)?.label ?? ''}」挑，也看了冰箱与口味。`
          : '按你家冰箱、口味和平时爱吃的，替你挑一道。'}
      </p>

      {decide.isPending && (
        <>
          {/* 纯规则、毫秒级，但要走几次库查询：给一句话而不是一个静止的界面。
              用 div 不用 p：DotLoading 自己渲染的是块级元素，套在 p 里会触发
              validateDOMNesting 警告（React 会把它踢出去，布局就散了） */}
          <div className="decide__waiting">
            <DotLoading color="currentColor" /> 正在翻冰箱…
          </div>
          <div className="decide__skeleton" aria-hidden>
            <span className="decide__skeleton-title" />
            <span className="decide__skeleton-line" />
            <span className="decide__skeleton-line decide__skeleton-line--short" />
          </div>
        </>
      )}

      {decide.isError && (
        <p className="decide__empty">
          {apiErrorMessage(decide.error)}
          <button type="button" className="decide__retry" onClick={() => ask(seen)}>
            再试一次
          </button>
        </p>
      )}

      {/* 拿不出菜：把**这一种情况**的去路说清楚，不给一道编的（三种原因下一步完全不同） */}
      {result && !recipe && (
        <div className="decide__none">
          <p className="decide__none-text">{result.reason ?? '这会儿挑不出来'}</p>
          {result.fridgeEmpty && (
            <Link className="decide__link" to="/fridge" state={{ from: '/discover' }} onClick={onClose}>
              去记两样冰箱里的东西 <Icon name="arrow-right" size={13} className="icon--trail" />
            </Link>
          )}
        </div>
      )}

      {recipe && (
        <div className="decide__pick">
          <div className="decide__card">
            <div className="decide__thumb">
              <RecipeImage src={recipe.image} name={recipe.name} />
            </div>
            <div className="decide__main">
              <Link
                className="decide__name"
                to={`/recipes/${encodeURIComponent(recipe.id)}`}
                state={{ from: '/discover' }}
              >
                {recipe.name}
              </Link>
              {/* 为什么是这道：**后端拼的那句话**，前端不改一个字（两边各拼一遍必然漂移） */}
              {result?.reason && <p className="decide__reason">{result.reason}</p>}
              {(recipe.have.length > 0 || recipe.missing.length > 0) && (
                <div className="decide__chips">
                  {recipe.have.length > 0 && (
                    <span className="decide__chip is-have">用上了 {recipe.have.join('、')}</span>
                  )}
                  {recipe.missing.length > 0 && (
                    <span className="decide__chip is-missing">还差 {recipe.missing.join('、')}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 冰箱空时明说这次没照着冰箱挑：不说的话用户会以为"它看过冰箱了"，
              而其实是他还没记（与采购清单的 stockEmpty 同一条） */}
          {result?.fridgeEmpty && (
            <p className="decide__hint">
              冰箱里还没记东西，这次只按家里的口味和平时爱吃的挑。
              <Link className="decide__link" to="/fridge" state={{ from: '/discover' }} onClick={onClose}>
                去记两样 <Icon name="arrow-right" size={13} className="icon--trail" />
              </Link>
            </p>
          )}

          {/*
            「换个场合挑」：原来发现页上那一块四个场景词，现在收在这里（2026-10-16，见 D-110
            与组件上方那段说明）。

            摆在这里而不是抽屉最上面，是因为它是**收窄条件**：默认不问场合——用户来这儿
            最常见的心态是"随便，你定"，先给他一道就对了；想收窄的人往下看两眼就能找到。
            每枚胶囊都带**真实道数**（后端算的）：不写数字就会出现"点进去是空的"。
            再点一下选中的那枚 = 取消（回到不问场合那道），所以它是个开关而不是单选框。
          */}
          {(occasions.data?.items.length ?? 0) > 0 && (
            <div className="decide__occasion">
              <span className="decide__occasion-title">换个场合挑</span>
              <div className="decide__occasion-row">
                {occasions.data?.items.map((item) => (
                  <button
                    key={item.tag}
                    type="button"
                    className="decide__occasion-pill"
                    aria-pressed={occasion === item.tag}
                    disabled={forOccasion.isPending}
                    onClick={() => pickOccasion(item.tag)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="decide__actions">
            {added ? (
              <span className="decide__done">已经加进菜单了</span>
            ) : (
              <button
                type="button"
                className="decide__take"
                disabled={addItem.isPending || !family.data}
                onClick={take}
              >
                {addItem.isPending ? '正在加进菜单…' : '就它了'}
              </button>
            )}
            {/* 换到没有别的为止：后端给 canSwap，置灰比"点了没反应"清楚 */}
            <button
              type="button"
              className="decide__swap"
              disabled={decide.isPending || result?.canSwap === false}
              onClick={swap}
            >
              换一道 <Icon name="refresh" size={13} className="icon--trail" />
            </button>
          </div>
        </div>
      )}

      {/*
       * 下半：想提要求时才展开问 AI。
       *
       * 收着的那一行必须**说清它与上面那道的关系**（"都不合意？"），否则它看起来像
       * 又一个"帮你决定"的按钮——正是用户提出的那个重复问题。
       * 它**不看上面那道有没有挑出来**：上面空了（库空、口味排掉全部）时，用户更该有
       * 第二条路可走，而不是看着一个空状态无路可去。
       */}
      {!decide.isPending && (
        <div className="today-ai-block">
          <button
            type="button"
            className={['today-ai-toggle', aiOpen && 'is-open'].filter(Boolean).join(' ')}
            aria-expanded={aiOpen}
            onClick={toggleAi}
          >
            <span className="today-ai-toggle__text">
              {aiOpen ? '想问就说说想吃什么' : '都不合意？说说想吃什么，让 AI 挑几道'}
            </span>
            {/*
             * 箭头用**矢量**而不是 ⌄/⌃ 两个字符：字符版没法做旋转过渡
             * （换字符就是"跳"一下）。展开时整块转 180°，与它自己的收起动画同时发生。
             */}
            <span className={['today-ai-toggle__arrow', aiOpen && 'is-open'].filter(Boolean).join(' ')} aria-hidden>
              <svg viewBox="0 0 12 12" width="12" height="12">
                <path
                  d="M2.5 4.4 L6 7.9 L9.5 4.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
          {/*
           * 收起时**先播完那一小段再卸载**（`closing`）：直接卸载是"啪"地消失，
           * 而用户刚点的那一下需要一个回应。上线的条件是 `aiOpen || closing`，
           * 所以收起动画期间组件还在、动画结束才真正走人（AI 的请求也因此只在
           * 真的展开时发一次，收起后不留着轮询）。
           */}
          {(aiOpen || closing) && (
            <AiSuggestPanel
              closing={closing}
              onNavigate={() => { /* 跳走前不打任何标记：返回时原样 */ }}
            />
          )}
        </div>
      )}
    </BottomSheet>
  )
}
