import { useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { useSetDinerCount, type MealCard } from '@/api/orders'
import BottomSheet from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'

/**
 * 定这一餐几个人吃（M4 / F4-05）。
 *
 * 为什么和「N 人点了」分开：点菜的是家里会用 App 的人，**真正的就餐人数含没点菜只吃饭的家人**
 * （老人、小孩、客人）。所以这是个由掌勺人/帮厨手填的数，不是从点菜记录算出来的（D-022 留给 M4 的正是这一项）。
 *
 * 不给"减到 0"的语义：0 个人吃饭没有意义，要撤销设定就按「清除」——接口也按 null 处理，
 * 库里存 null 而不是 0（避免以后有人把 0 当成"0 个人"来显示）。
 */
export default function DinerCountSheet({
  card,
  onClose,
}: {
  /** 要设定的那一餐（由卡片传来，带着当前值与"几人点了"） */
  card: MealCard
  onClose: () => void
}) {
  const setDiners = useSetDinerCount()
  // 初值给「现在的人数」或"点菜人数"——后者是最小合理值，多数家庭直接确认就行
  const [value, setValue] = useState(card.dinerCount ? String(card.dinerCount) : String(Math.max(1, card.ordererCount)))

  const submit = (next: number | null) => {
    setDiners.mutate(
      { mealKey: card.mealKey, dinerCount: next },
      {
        onSuccess: (updated) => {
          toast.success(updated.dinerCount ? `这餐按 ${updated.dinerCount} 人算` : '已清除人数设定')
          onClose()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const parsed = Number(value)
  const invalid = !Number.isInteger(parsed) || parsed < 1 || parsed > 50

  return (
    <BottomSheet visible title="定几个人吃" onClose={onClose}>
      <p className="checkin-sheet__hint">
        {card.date} · {card.mealLabel}　共 {card.dishCount} 道 · {card.ordererCount} 人点了
      </p>
      <p className="checkin-sheet__hint">写实际吃饭的人数（家里老人小孩没点菜也算）。</p>

      <div className="diners-stepper">
        {/*
          加减用**函数式更新**（读 prev 而不是闭包里的 parsed）：
          闭包值在"同一批里连点两次"时是陈旧的（React 会把它们合成一次渲染，
          第二次读到的是上一次的值），函数式更新天然免疫这类问题。
        */}
        <button
          type="button"
          className="diners-stepper__btn"
          disabled={invalid || parsed <= 1}
          onClick={() => setValue((prev) => String(Math.max(1, Number(prev) - 1)))}
          aria-label="少一个人"
        >
          −
        </button>
        <input
          className="diners-stepper__input"
          inputMode="numeric"
          aria-label="就餐人数"
          value={value}
          onChange={(event) => setValue(event.target.value.replace(/[^0-9]/g, ''))}
        />
        <button
          type="button"
          className="diners-stepper__btn"
          disabled={invalid || parsed >= 50}
          onClick={() => setValue((prev) => String(Math.min(50, Number(prev) + 1)))}
          aria-label="多一个人"
        >
          ＋
        </button>
        <span className="diners-stepper__unit">人</span>
      </div>
      {invalid && <p className="diners-stepper__hint">填 1～50 之间的整数</p>}

      <button
        type="button"
        className="recipe-button checkin-sheet__submit"
        disabled={invalid || setDiners.isPending}
        onClick={() => submit(parsed)}
      >
        {setDiners.isPending ? '正在保存…' : '就这么多人'}
      </button>

      {card.dinerCount !== null && (
        <button
          type="button"
          className="diners-stepper__clear"
          disabled={setDiners.isPending}
          onClick={() => submit(null)}
        >
          清除人数设定
        </button>
      )}
    </BottomSheet>
  )
}
