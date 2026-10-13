import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DotLoading } from 'antd-mobile'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { useDecide } from '@/api/decide'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { useFamily } from '@/api/family'
import { nextMealDefaults } from '@/pages/order/next-meal'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import { useDecideSession } from '@/stores/decide-session'
import '../../shared.scss'

/**
 * 「帮我决定」（M5 / F5-05）。口径见 D-060。
 *
 * 定位是**零选择成本的兜底**：连"从几条里挑一条"都省掉，**只给一道**。
 * 所以它与「AI 帮你想」在形态上有一处根本不同——那边是列表、可以连着点几道；
 * 这边一次只有一道菜，用户能做的是「就它了」或「换一道」。
 *
 * 五件事刻意的：
 *
 * - **打开即要一个主意**：抽屉一出现就发请求，不让用户再按一下——他已经按过按钮了，
 *   "再按一次才给答案"是把成本又还给他；
 * - **会话状态在 store 里**（`stores/decide-session`）：菜名能点进详情，返回时那道菜
 *   必须还在（与「AI 帮你想」同一条，用户 2026-10-13 对那边的原话是"返回时还是打开的、
 *   保持原样"）。回来后**不重新挑**——他正要评估刚才那道菜，换一道等于把答案抽走；
 * - **说清为什么是这道**（`reason`，后端拼的那句）：这是它与「摇一道」的全部区别，
 *   不说理由的话，用户没有理由相信它比随机好；
 * - **点完不自动关**：用户可能想「换一道」再看两眼，或者点菜名去看做法。关不关交给他；
 * - **拿不出菜时给出去路**（空库 / 冰箱空 / 口味排掉了全部）：三种情况的下一步完全不同，
 *   说错了他会白折腾一趟。
 */
export default function DecideSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const family = useFamily()
  const options = useOrderOptions()
  const decide = useDecide()
  const addItem = useAddOrderItem()

  const result = useDecideSession((state) => state.result)
  const seen = useDecideSession((state) => state.seen)
  const added = useDecideSession((state) => state.added)
  const setResult = useDecideSession((state) => state.setResult)
  const pushSeen = useDecideSession((state) => state.pushSeen)
  const setAdded = useDecideSession((state) => state.setAdded)
  const reset = useDecideSession((state) => state.reset)

  /*
   * 这次挂载是"续上"还是"新开"：`start()` 会把 result 清成 null，所以**有结果就是续上**
   * （从详情返回）。用 useState 定住：后面 ask() 会改 result，判定不能跟着变
   * （与 AiSuggestSheet 的 `resumed` 同一处理）。
   */
  const [resumed] = useState(() => useDecideSession.getState().result !== null)

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
    const session = useDecideSession.getState()
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

  return (
    <BottomSheet visible={visible} title="帮我决定" onClose={onClose}>
      <p className="decide__lead">按你家冰箱、口味和平时爱吃的，替你挑一道。</p>

      {decide.isPending && (
        <>
          {/* 纯规则、毫秒级，但要走几次库查询：给一句话而不是一个静止的界面 */}
          <p className="decide__waiting">
            <DotLoading color="currentColor" /> 正在翻冰箱…
          </p>
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
              去记两样冰箱里的东西 →
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
                去记两样 →
              </Link>
            </p>
          )}

          <div className="decide__actions">
            {added ? (
              <span className="decide__done">已经加进菜单了</span>
            ) : (
              <button
                type="button"
                className="recipe-button decide__take"
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
              换一道 ↻
            </button>
          </div>

          <p className="decide__foot">
            点菜名能看做法；「就它了」会加进今天这一餐，进了菜单随时能撤。
          </p>
        </div>
      )}
    </BottomSheet>
  )
}
