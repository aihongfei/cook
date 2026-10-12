import { useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { can, useFamily } from '@/api/family'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import BottomSheet from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'
import '../order.scss'

/**
 * 「自己写一道」：菜谱库里没有的菜，直接写个名字点进点单（F3-10）。
 *
 * 为什么要有：家里常做的菜未必在菜谱库里（"外婆的红烧肉"），或者今天就是想吃个
 * 店里的招牌——不能因为库里没有就不让人点。
 *
 * 三件事是刻意的：
 * - **日期/餐次仍由后端下发**（`/orders/options`），与「想吃这道」同一套口径，前端不硬编码；
 * - **菜名与备注分开**：菜名是这道菜叫什么（会显示在点单卡的主行），备注是这一份的交代
 *   （「小满那份不要辣」）。把交代混进菜名，卡片上就成了一行谁也不认识的长句子；
 * - **只收一个名字**：不让人在这里填配料做法——那是「上传我的菜谱」（F1-12）的事，
 *   这里的目标是"三十秒把今天想吃的记下来"。
 */
export default function FreeDishSheet({
  visible,
  onClose,
}: {
  visible: boolean
  onClose: () => void
}) {
  const family = useFamily()
  const options = useOrderOptions()
  const addItem = useAddOrderItem()

  const days = options.data?.dayOptions ?? []
  const meals = options.data?.meals ?? []

  const [name, setName] = useState('')
  const [chosenDay, setChosenDay] = useState<string | null>(null)
  const [chosenMeal, setChosenMeal] = useState<string | null>(null)
  const [note, setNote] = useState('')

  // 默认落在「今天的第一餐」；用户点了别的就用用户的（与「想吃这道」不同，这里不猜"下一餐"——
  // 从点菜单进来的场景是"我现在就想记一道菜"，默认跟着列表最上面那一天最直观）
  const day = chosenDay ?? days[0]?.value ?? ''
  const meal = chosenMeal ?? meals[0]?.value ?? ''

  const mayOrder = can(family.data, 'order.create')
  const trimmed = name.trim()

  const submit = () => {
    if (!trimmed || !day || !meal) return
    addItem.mutate(
      // 不带 recipeId：后端按"自己写一道"处理（两个字段二选一，见 orders.rules）
      { dishName: trimmed, mealDate: day, meal, note: note.trim() || undefined },
      {
        onSuccess: (card) => {
          const dayLabel = days.find((option) => option.value === card.date)?.label ?? card.date
          toast.success(`已把「${trimmed}」加进${dayLabel}${card.mealLabel}`)
          onClose()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet visible={visible} title="自己写一道" onClose={onClose}>
      {!family.data ? (
        <p className="order-sheet__hint">点菜是给家里人看的。先创建家庭或用邀请码加入，再写这道菜。</p>
      ) : !mayOrder ? (
        <p className="order-sheet__hint">你在家里的角色暂时不能点菜，让掌勺人看看你的角色。</p>
      ) : (
        <>
          <label className="order-sheet__group">
            <span className="order-sheet__label">想吃什么（菜名）</span>
            <input
              className="order-sheet__note"
              value={name}
              maxLength={30}
              placeholder="如：外婆的糖醋小排"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

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
            disabled={!trimmed || !day || !meal || addItem.isPending}
            onClick={submit}
          >
            {addItem.isPending ? '正在加进点菜单…' : '加进点菜单'}
          </button>
        </>
      )}
    </BottomSheet>
  )
}
