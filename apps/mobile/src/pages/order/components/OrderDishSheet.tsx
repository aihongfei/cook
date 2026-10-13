import { useRef, useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { can, useFamily } from '@/api/family'
import { useAddOrderItem, useOrderOptions, type MealSlot } from '@/api/orders'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'
import { nextMealDefaults } from '../next-meal'
import type { PlanTarget } from '../plan-target'
import '../order.scss'

/**
 * 「想吃这道」：点菜入口（F3-01/05，D-022）。
 *
 * 只做一件事——把这道菜加进「某天某餐」。日期与餐次选项都由 `/orders/options` 下发，
 * 前端不硬编码（改口径不用发版）；默认选中"下一餐"（规则见 ../next-meal，AI 推荐入口共用同一份）。
 *
 * `preset` 是本周菜单「去安排」带过来的目标（F4-02）：**它的日期必须先出现在当下下发的
 * dayOptions 里**才生效——那是个跨页路由 state，可能是昨天留下的链接（"后天"已经过期），
 * 也可能是手改的。对不上就照常回落到"下一餐"，不把无效日期预选出来让人白提交一次。
 */
export default function OrderDishSheet({
  visible,
  recipeId,
  recipeName,
  preset,
  onClose,
}: {
  visible: boolean
  recipeId: string
  recipeName: string
  preset?: PlanTarget | null
  onClose: () => void
}) {
  const family = useFamily()
  const options = useOrderOptions()
  const addItem = useAddOrderItem()

  const days = options.data?.dayOptions ?? []
  const meals = options.data?.meals ?? []

  // 用户显式选过的值；没选过就用"下一餐"作为默认（见 nextMealDefaults）
  const [chosenDay, setChosenDay] = useState<string | null>(null)
  const [chosenMeal, setChosenMeal] = useState<MealSlot | null>(null)
  const [note, setNote] = useState('')
  // 收起走抽屉自己的退场动画（见 BottomSheet 里那段 ⚠️）：直接调 onClose 会让抽屉"啪"地消失
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())

  /*
   * 默认值在渲染时推导，而不是用 useEffect 写状态：
   * ① options 是异步来的，late-arriving 时推导式天然跟上，effect 要额外处理；
   * ② 在 effect 里 setState 会多一次渲染（oxlint 的 set-state-in-effect 也会拦）。
   * 组件由调用方用 key 在每次打开时重挂载，所以"上次选的"不会带到下一次。
   */
  const fallback = nextMealDefaults(days)
  // 生效的 preset 与"它的日期还有效"绑在同一个值上：拆成两个变量时编译器无法从
  // `presetDay` 为真推出 `preset` 非空，`preset.meal` 就成了可疑访问（这也是个真实保证：
  // 能算出 presetDay 就说明 preset 在，只是类型系统看不见这层关系）
  const presetTarget = preset && days.some((option) => option.value === preset.date) ? preset : null
  const day = chosenDay ?? presetTarget?.date ?? fallback.day
  const meal: MealSlot | '' = chosenMeal ?? presetTarget?.meal ?? fallback.meal ?? ''

  const mayOrder = can(family.data, 'order.create')

  const submit = () => {
    if (!day || !meal) return
    addItem.mutate(
      { recipeId, mealDate: day, meal, note: note.trim() || undefined },
      {
        onSuccess: (card) => {
          const dayLabel = days.find((option) => option.value === card.date)?.label ?? card.date
          toast.success(`已加入${dayLabel}${card.mealLabel}，等掌勺人安排`)
          /*
           * 口味提醒（F3-08）：**加进去了才提醒**，不是先拦一道。
           * 用 toast 而不是原生 confirm：不打断、可忽略，而且用户想撤的话
           * 「撤掉这一道」就在那一餐的卡上（比"先问一遍再点一次"顺）。
           * 过敏（block）用 error 色，忌口（warn）用普通提示——轻重不一样。
           */
          if (card.tasteWarning) {
            if (card.tasteWarning.verdict === 'block') toast.error(card.tasteWarning.text)
            else toast.success(card.tasteWarning.text)
          }
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet ref={sheet} visible={visible} title={`想吃「${recipeName}」？`} onClose={onClose}>
      {!family.data ? (
        // 没家庭就没法点菜（点单是家庭内的协作）——直接把去路说清楚，不让点下去撞错误
        <p className="order-sheet__hint">
          点菜是给家里人看的。先创建家庭或用邀请码加入，再回来点这道菜。
        </p>
      ) : !mayOrder ? (
        <p className="order-sheet__hint">你在家里的角色暂时不能点菜，让掌勺人看看你的角色。</p>
      ) : (
        <>
          {presetTarget && (
            // 不写"从某某页面来的"：带着目标进来的入口不止一个（本周菜单 F4-02、备菜计划 F4-03），
            // 写死一个入口名，从另一个入口来的人会以为系统记错了页面
            <p className="order-sheet__hint">已按你选的那一餐默认：{presetTarget.label}，也可以改。</p>
          )}
          <div className="order-sheet__group">
            <span className="order-sheet__label">哪一天</span>
            <div className="order-sheet__choices">
              {days.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={['order-sheet__choice', option.value === day && 'is-active']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={option.value === day}
                  onClick={() => setChosenDay(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="order-sheet__group">
            <span className="order-sheet__label">哪一餐</span>
            <div className="order-sheet__choices">
              {meals.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={['order-sheet__choice', option.value === meal && 'is-active']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={option.value === meal}
                  onClick={() => setChosenMeal(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <label className="order-sheet__group">
            <span className="order-sheet__label">想交代一句（可以不填）</span>
            <input
              className="order-sheet__note"
              value={note}
              maxLength={120}
              placeholder="如：小满那份不要辣"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          <button
            type="button"
            className="recipe-button order-sheet__submit"
            disabled={addItem.isPending}
            onClick={submit}
          >
            {addItem.isPending ? '正在加进点菜单…' : '加进点菜单'}
          </button>
        </>
      )}
    </BottomSheet>
  )
}
