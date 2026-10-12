import { useRef, useState } from 'react'
import { DotLoading } from 'antd-mobile'
import { apiErrorMessage } from '@/api/client'
import { useOrderOptions, useRepeatMeal, type MealCard, type MealSlot } from '@/api/orders'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'
import { nextMealDefaults } from '@/pages/order/next-meal'
import '../../shared.scss'

/**
 * 再点一次（F3-06）：把这一餐整桌照抄到另一天某一餐。
 *
 * 三件事刻意的：
 * - **来源是"过去的一餐"**：入口只出现在定局的那一餐上（做好了 / 已取消 / 日子过去了，
 *   后端算好 `canRepeat`）。还在收集中的那一餐要加菜直接点那道菜就行，不必绕道"复制"；
 * - **日期与餐次由后端下发、默认"下一餐"**（`nextMealDefaults`，与「想吃这道」「整组加入」
 *   共用同一条规则）——同一个"下一餐"在哪个入口都该落到同一餐；
 * - **先把整桌菜念出来**：用户点"再点一次"时脑子里想的是"照那桌来"，
 *   抽屉里得先让他确认"那桌是哪几道"，再问照到哪一餐。
 */
export default function RepeatMealSheet({
  card,
  onClose,
}: {
  /** 要照抄的那一餐（带着菜名与状态） */
  card: MealCard
  onClose: () => void
}) {
  const options = useOrderOptions()
  const repeat = useRepeatMeal()
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
  // 餐次文案走后端下发的 label（与点菜抽屉同一套），找不到才退回硬编码
  const mealText = meals.find((option) => option.value === meal)?.label ?? (meal === 'LUNCH' ? '午餐' : '晚餐')
  const target = `${dayLabel}${mealText}`

  const dishNames = card.dishes.map((line) => (line.count > 1 ? `${line.name} ×${line.count}` : line.name))

  const submit = () => {
    if (!day || !meal) return
    repeat.mutate(
      { mealKey: card.mealKey, mealDate: day, meal },
      {
        onSuccess: (result) => {
          if (result.added.length === 0) {
            // 一句"都在了"就够：用户看到的就是"这一餐没变"，不用再念一遍跳过哪几道
            toast.success(result.message ?? `${target}那一桌菜都有了`)
          } else {
            toast.success(`照 ${card.date} ${card.mealLabel}点了 ${result.added.length} 道进${target}`)
            if (result.skipped.length > 0) {
              // 跳过的单独说：这一桌有五道却只提示点了三道，用户会去数
              toast.success(`${result.skipped.join('、')} 本来就有，没重复加`)
            }
          }
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet ref={sheet} visible title="再点一次" onClose={onClose}>
      {/* 先让用户看清"要照的是哪一桌" */}
      <p className="checkin-sheet__hint">
        {card.date} · {card.mealLabel}　共 {card.dishCount} 道
      </p>
      <p className="repeat-sheet__dishes">{dishNames.join('、')}</p>
      <p className="checkin-sheet__hint">
        这桌菜会照抄到你说的那一餐，已经有的菜跳过、不会重复加一份；备注不跟着走。
      </p>

      <div className="order-sheet__group">
        <span className="order-sheet__label">照到哪一天</span>
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
        className="recipe-button checkin-sheet__submit"
        disabled={repeat.isPending || !day || !meal}
        onClick={submit}
      >
        {repeat.isPending ? <DotLoading color="currentColor" /> : `照这桌点进${target}`}
      </button>
    </BottomSheet>
  )
}
