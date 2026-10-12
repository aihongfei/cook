import { useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { can, useFamily } from '@/api/family'
import { useAddOrderItem, useOrderOptions, type MealSlot } from '@/api/orders'
import BottomSheet from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'
import '../order.scss'

/**
 * 默认选「下一餐」：下午 3 点前默认今天的晚饭，之后默认明天的午饭。
 * days 是后端下发的可选日期（今天/明天），为空时（选项还没回来）返回空值，界面自然什么都不选。
 */
function nextMealDefaults(days: { value: string; label: string }[]): { day: string; meal: MealSlot | null } {
  if (days.length === 0) return { day: '', meal: null }
  const tonight = new Date().getHours() < 15
  return tonight
    ? { day: days[0].value, meal: 'DINNER' }
    : { day: days[1]?.value ?? days[0].value, meal: 'LUNCH' }
}

/**
 * 「想吃这道」：点菜入口（F3-01/05，D-022）。
 *
 * 只做一件事——把这道菜加进「某天某餐」。日期与餐次选项都由 `/orders/options` 下发，
 * 前端不硬编码（改口径不用发版）；默认选中"下一餐"，让最常见的操作一次点完。
 */
export default function OrderDishSheet({
  visible,
  recipeId,
  recipeName,
  onClose,
}: {
  visible: boolean
  recipeId: string
  recipeName: string
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

  /*
   * 默认值在渲染时推导，而不是用 useEffect 写状态：
   * ① options 是异步来的，late-arriving 时推导式天然跟上，effect 要额外处理；
   * ② 在 effect 里 setState 会多一次渲染（oxlint 的 set-state-in-effect 也会拦）。
   * 组件由调用方用 key 在每次打开时重挂载，所以"上次选的"不会带到下一次。
   */
  const fallback = nextMealDefaults(days)
  const day = chosenDay ?? fallback.day
  const meal: MealSlot | '' = chosenMeal ?? fallback.meal ?? ''

  const mayOrder = can(family.data, 'order.create')

  const submit = () => {
    if (!day || !meal) return
    addItem.mutate(
      { recipeId, mealDate: day, meal, note: note.trim() || undefined },
      {
        onSuccess: (card) => {
          const dayLabel = days.find((option) => option.value === card.date)?.label ?? card.date
          toast.success(`已加入${dayLabel}${card.mealLabel}，等掌勺人安排`)
          onClose()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet visible={visible} title={`想吃「${recipeName}」？`} onClose={onClose}>
      {!family.data ? (
        // 没家庭就没法点菜（点单是家庭内的协作）——直接把去路说清楚，不让点下去撞错误
        <p className="order-sheet__hint">
          点菜是给家里人看的。先创建家庭或用邀请码加入，再回来点这道菜。
        </p>
      ) : !mayOrder ? (
        <p className="order-sheet__hint">你在家里的角色暂时不能点菜，让掌勺人看看你的角色。</p>
      ) : (
        <>
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
