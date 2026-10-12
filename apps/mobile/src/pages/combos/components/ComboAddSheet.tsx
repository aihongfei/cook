import { useRef, useState } from 'react'
import { DotLoading } from 'antd-mobile'
import { apiErrorMessage } from '@/api/client'
import { useAddCombo, type Combo } from '@/api/combos'
import { useOrderOptions, type MealSlot } from '@/api/orders'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'
import { nextMealDefaults } from '@/pages/order/next-meal'
import '../../shared.scss'

/**
 * 一键把整组加进某一餐（M4 / F4-04）。
 *
 * 三件事是刻意的：
 * - **日期与餐次由后端下发、默认"下一餐"**（`nextMealDefaults`，与「想吃这道」共用同一个规则）
 *   ——同一个"下一餐"在哪个入口都该落到同一餐，组合不该自带一套默认；
 * - **"跳过已有的"要说出来**：用户点了"一键加入"却发现这一餐的菜数没变，
 *   不解释的话只会以为按钮坏了（后端返回的 `skipped` 就是为这件事）；
 * - **整组落在某一餐**：一次选定日期 + 餐次，而不是"先加再改日期"。
 */

function mealLabel(meal: MealSlot | null, meals: { value: MealSlot; label: string }[]): string {
  if (!meal) return '这一餐'
  return meals.find((option) => option.value === meal)?.label ?? (meal === 'LUNCH' ? '午餐' : '晚餐')
}

export default function ComboAddSheet({
  combo,
  onClose,
  onDone,
}: {
  combo: Combo
  onClose: () => void
  onDone?: () => void
}) {
  const options = useOrderOptions()
  const add = useAddCombo()
  // 收起走抽屉自己的退场动画（见 BottomSheet 里那段 ⚠️）
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())

  const days = options.data?.dayOptions ?? []
  const meals = options.data?.meals ?? []
  const fallback = nextMealDefaults(days)
  const [chosenDay, setChosenDay] = useState<string | null>(null)
  const [chosenMeal, setChosenMeal] = useState<MealSlot | null>(null)

  const day = chosenDay ?? fallback.day
  const meal = chosenMeal ?? fallback.meal
  const dayLabel = days.find((option) => option.value === day)?.label ?? day
  const target = `${dayLabel}${mealLabel(meal, meals)}`

  const submit = () => {
    if (!day || !meal) return
    add.mutate(
      { comboId: combo.id, mealDate: day, meal },
      {
        onSuccess: (result) => {
          if (result.added.length === 0) {
            // 一句"都在了"就够：用户看到的就是"这一餐没变"，不用再念一遍跳过哪几道
            toast.success(`「${combo.name}」这组菜在${target}都有了`)
          } else {
            toast.success(`已把 ${result.added.length} 道加进${target}`)
            if (result.skipped.length > 0) {
              // 跳过的单独说一句：这一组有五道却只提示加了三道，用户会去数
              toast.success(`${result.skipped.join('、')} 本来就有，没重复加`)
            }
          }
          onDone?.()
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet ref={sheet} visible title={`加入「${combo.name}」`} onClose={onClose}>
      <p className="combos-sheet__hint">
        这组有 {combo.dishCount} 道：{combo.dishes.map((dish) => dish.name).join('、')}
      </p>
      <p className="combos-sheet__hint">这一餐里已经有的菜会跳过，不会重复加一份。</p>

      <div className="order-sheet__group">
        <span className="order-sheet__label">哪一天</span>
        <div className="order-sheet__choices">
          {days.map((option) => (
            <button
              key={option.value}
              type="button"
              className={['order-sheet__choice', option.value === day && 'is-active'].filter(Boolean).join(' ')}
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
              className={['order-sheet__choice', option.value === meal && 'is-active'].filter(Boolean).join(' ')}
              aria-pressed={option.value === meal}
              onClick={() => setChosenMeal(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="recipe-button combos-sheet__submit"
        disabled={add.isPending || !day || !meal}
        onClick={submit}
      >
        {add.isPending ? <DotLoading color="currentColor" /> : `整组加进${target}`}
      </button>
    </BottomSheet>
  )
}
