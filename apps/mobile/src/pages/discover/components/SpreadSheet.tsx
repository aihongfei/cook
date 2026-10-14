import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DotLoading } from 'antd-mobile'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { useAddDishesToMeal, useSpread } from '@/api/spread'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { useFamily } from '@/api/family'
import { nextMealDefaults } from '@/pages/order/next-meal'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import { useSpreadSession } from '@/stores/spread-session'
import '../../shared.scss'

/**
 * 「摇一桌」（M5 / F5-01，2026-10-15 由「摇一道」升级而来）。
 *
 * 一桌菜与「帮我决定」那道**不是同一个东西**，所以是两个抽屉而不是一个：
 * 「帮我决定」只给一道、把理由说透（用户在那儿是"拿不定主意，你替我挑"）；
 * 这里给**够这一餐吃的几道**、配好荤素汤（用户在这儿是"今晚就这么定了"）。
 *
 * 五件事刻意的：
 *
 * - **打开即摇一桌**：用户已经按过按钮了，不再让他按第二下；
 * - **道数不由用户填**：他心里的输入是"今晚四个人"，不是"给我 3.5 道菜"。
 *   几个人的来源按这个顺序：这一餐已存的人数 → 他说过的 → 默认两口之家（`dinersFromMeal`
 *   如实标出是哪一种，界面上那句"按 2 个人算"就是它）；
 * - **每一道都有一句真理由**（冰箱里正好能做 / 要买什么 / 做过几次），一句真事都没有时留空不编；
 * - **可以只留一道，也可以整桌端走**：单独「就它了」是原来「摇一道」那条路，底部整组加入是升级后的主路；
 * - **整组一次请求**（`/orders/items/bulk`）：前端循环调加菜接口的话，中途失败会加进去一半，
 *   用户得到一桌残缺的菜还不知道为什么。已有的菜**跳过不叠份数**（点两次不会变两份）。
 *
 * 状态在 store（`stores/spread-session`）：点菜名去看做法再返回，这一桌必须原样还在。
 */
export default function SpreadSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const family = useFamily()
  const options = useOrderOptions()
  const spread = useSpread()
  const addOne = useAddOrderItem()
  const addAll = useAddDishesToMeal()

  const result = useSpreadSession((state) => state.result)
  const diners = useSpreadSession((state) => state.diners)
  const added = useSpreadSession((state) => state.added)
  const setResult = useSpreadSession((state) => state.setResult)
  const markAdded = useSpreadSession((state) => state.markAdded)
  const reset = useSpreadSession((state) => state.reset)

  /*
   * 这次挂载是"续上"还是"新开"：`start()` 会把 result 清成 null，所以**有结果就是续上**。
   * 用 useState 定住：摇一次之后 result 会变，这个判定不能跟着变
   * （与 TodaySheet 的 `resumed` 同一处理）。
   */
  const [resumed] = useState(() => useSpreadSession.getState().result !== null)

  // 落到哪一餐与「想吃这道」「帮我决定」同一份规则：同一个"我要做菜"的动作不该落到不同的一餐
  const target = nextMealDefaults(options.data?.dayOptions ?? [])
  const mealKey = target.day && target.meal ? `${target.day}-${target.meal}` : ''

  const shake = (withDiners: number | null) => {
    if (!mealKey) return
    spread.mutate(
      { mealKey, diners: withDiners ?? undefined },
      {
        onSuccess: (data) => setResult(data, withDiners),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  /*
   * 新开时摇一次。两条踩过的坑（与 TodaySheet 同源）：
   * ① "摇过了没有"这个标记必须在 store 里 —— StrictMode 的"挂载 → 卸载 → 再挂载"
   *    会让组件 state 重置，于是摇两次，后回来的那桌把已经显示出来的一桌**悄悄换掉**；
   * ② **不在渲染期调 store 动作**——渲染期改外部 store 会让这次渲染被整个丢弃，
   *    连刚发出去的请求都落不到界面上（抽屉开着却一直是空的）。
   *
   * `mealKey` 为空（可选日期还没回来）时不打标记也不请求：effect 依赖里有它，
   * 选项一到就会再跑一次。
   */
  const askedRef = useRef(false)
  useEffect(() => {
    if (!visible || askedRef.current || !mealKey) return
    askedRef.current = true
    const session = useSpreadSession.getState()
    if (session.asked) return
    session.markAsked()
    // 续上（从详情返回）时不重摇：用户正要看的是刚才那一桌
    if (resumed) return
    shake(session.diners)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载/可见时跑一次，shake 每次渲染都是新函数
  }, [visible, mealKey, resumed])

  const dishes = result?.items ?? []
  const allIn = dishes.length > 0 && dishes.every((dish) => added.includes(dish.id))

  /** 单独留一道（原来「摇一道」那条路：只想要一道，别的都不合意） */
  const takeOne = (id: string) => {
    if (!target.day || !target.meal) return
    addOne.mutate(
      { recipeId: id, mealDate: target.day, meal: target.meal },
      {
        onSuccess: (card) => {
          markAdded([id])
          toast.success(`已加进${card.mealLabel}`)
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const takeAll = () => {
    if (!result || !target.day || !target.meal || dishes.length === 0) return
    addAll.mutate(
      { recipeIds: dishes.map((dish) => dish.id), mealDate: target.day, meal: target.meal },
      {
        onSuccess: (data) => {
          // 跳过的那些**也算"在这一餐里"**：界面据此把它们标成已加入，否则用户会一直想点
          markAdded([...data.added, ...data.skipped])
          if (data.added.length === 0) {
            // 全是已有的：这不是失败，说清"这一桌已经在了"，别报一个"加了 0 道"
            toast.success(`这一桌都在${result.mealLabel}里了`)
          } else if (data.skipped.length > 0) {
            toast.success(`加了 ${data.added.length} 道，另外 ${data.skipped.length} 道本来就在这一餐里`)
          } else {
            toast.success(`已把 ${data.added.length} 道加进${result.mealLabel}`)
          }
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  /*
   * 人数可以改，但**只在"这一餐还没定过人数"时给这个控件**：
   * 这一餐存过人数时后端以存着的为准（那是用户自己在点菜单里填的，更权威），
   * 摆一排点了不生效的按钮，比不摆更糟。
   * 反过来，"按 2 个人算"这句话既然说了是默认值，就得让他能改——不然是条死路。
   */
  const canPickDiners = result !== null && !result.dinersFromMeal
  const dinerChoices = [...new Set([1, 2, 3, 4, 5, 6, diners ?? 0, result?.diners ?? 0])]
    .filter((n) => n > 0)
    .sort((a, b) => a - b)

  return (
    <BottomSheet visible={visible} title="摇一桌" onClose={onClose}>
      <p className="decide__lead">按这一餐几个人吃配一桌：有荤有素有汤，家里能做的排前面。</p>

      {spread.isPending && (
        <>
          <div className="decide__waiting">
            <DotLoading color="currentColor" /> 正在配这一桌…
          </div>
          <div className="decide__skeleton" aria-hidden>
            <span className="decide__skeleton-title" />
            <span className="decide__skeleton-line" />
            <span className="decide__skeleton-line decide__skeleton-line--short" />
          </div>
        </>
      )}

      {spread.isError && (
        <p className="decide__empty">
          {apiErrorMessage(spread.error)}
          <button type="button" className="decide__retry" onClick={() => shake(diners)}>
            再摇一次
          </button>
        </p>
      )}

      {/* 摇不出来（空库）：把这一种情况的去路说清楚，不给一桌编的 */}
      {result && dishes.length === 0 && (
        <div className="decide__none">
          <p className="decide__none-text">{result.reason || '这会儿配不出来'}</p>
          <Link className="decide__link" to="/recipes" state={{ from: '/discover' }} onClick={onClose}>
            去菜谱小书里加几道 →
          </Link>
        </div>
      )}

      {result && dishes.length > 0 && (
        <div className="spread__body">
          {/* 头部那句由后端拼：说清几个人、配了几道（前端不改一个字——两边各拼一遍必然漂移） */}
          <div className="spread__head">
            <p className="spread__summary">{result.reason}</p>
            {result.fridgeEmpty && (
              <p className="decide__hint">
                冰箱里还没记东西，这一桌只按家里的口味和平时爱吃的配。
                <Link className="decide__link" to="/fridge" state={{ from: '/discover' }} onClick={onClose}>
                  去记两样 →
                </Link>
              </p>
            )}
          </div>

          {canPickDiners && (
            <div className="spread__diners">
              <span className="spread__diners-label">不是 {result.diners} 个人？</span>
              <div className="spread__diners-opts">
                {dinerChoices.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={['spread__diner', result.diners === n && 'is-on'].filter(Boolean).join(' ')}
                    disabled={spread.isPending}
                    // 点当前这个不必重摇（点了没变化，只有一次白等的等待）
                    onClick={() => result.diners !== n && shake(n)}
                  >
                    {n} 人
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul className="spread__list">
            {dishes.map((dish) => {
              const didAdd = added.includes(dish.id)
              return (
                <li key={dish.id} className={['spread__item', didAdd && 'is-done'].filter(Boolean).join(' ')}>
                  <div className="spread__thumb">
                    <RecipeImage src={dish.image} name={dish.name} />
                  </div>
                  <div className="spread__main">
                    <div className="spread__name-row">
                      <Link
                        className="spread__name"
                        to={`/recipes/${encodeURIComponent(dish.id)}`}
                        state={{ from: '/discover' }}
                      >
                        {dish.name}
                      </Link>
                      {/* 荤/素/汤是后端算的角色（界面词也由后端下发）：用户扫一眼看的是"配齐了没" */}
                      <span className={`spread__role is-${dish.role}`}>{dish.roleLabel}</span>
                    </div>
                    {/* 一句真理由；一句真事都没有时后端给空串——那就只显示菜名与标签，不编 */}
                    {dish.reason && <p className="spread__reason">{dish.reason}</p>}
                    {dish.have.length > 0 && (
                      <div className="decide__chips">
                        <span className="decide__chip is-have">用上了 {dish.have.join('、')}</span>
                        {dish.soon.length > 0 && <span className="decide__chip is-soon">该先吃</span>}
                      </div>
                    )}
                  </div>
                  {didAdd ? (
                    <span className="spread__added">已在菜单里</span>
                  ) : (
                    <button
                      type="button"
                      className="spread__one"
                      disabled={addOne.isPending || !family.data}
                      onClick={() => takeOne(dish.id)}
                    >
                      就它了
                    </button>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="spread__actions">
            {allIn ? (
              <span className="spread__done">这一桌都在{result.mealLabel}里了</span>
            ) : (
              <button
                type="button"
                className="spread__take"
                disabled={addAll.isPending || !family.data}
                onClick={takeAll}
              >
                {addAll.isPending ? '正在加进菜单…' : `全都加进${result.mealLabel}`}
              </button>
            )}
            {/* 重新摇：换一桌（道数、人数都由后端按这一餐重算，前端只是再问一次） */}
            <button
              type="button"
              className="spread__again"
              disabled={spread.isPending}
              onClick={() => {
                reset()
                shake(diners)
              }}
            >
              再摇一桌 ↻
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}
