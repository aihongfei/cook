import { useRef } from 'react'
import { apiErrorMessage } from '@/api/client'
import { useUpdateMealStatus, type MealCard } from '@/api/orders'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'

/**
 * 确认菜单（M4 / F4-05 的汇总视图，口径见 D-030）。
 *
 * 为什么要有这一屏：原来「选好了」是**在卡片上直接写库**的——而它是唯一会让菜单上锁的动作
 * （定完之后想加菜就得先取消这一餐）。点下去之前该能看清整桌是什么：
 * 每道菜几份、谁交代了什么、几个人吃。菜不对就退出去改，人数没定就当场定。
 *
 * 它不是「二次确认弹窗」（没有"取消/确定"二选一），而是一屏**可读、可改**的汇总，
 * 真正"要不要定"留给底部那一个动作——和 ConfirmDialog 的分工不同：
 * 那个用来拦不可逆的破坏性动作（取消整餐），这个用来让人**看一眼再决定**。
 *
 * 人数没定**不拦着定菜单**：拦住只会逼出一个随手填的假数字（D-030 第 3 条）。
 */
export default function ConfirmMenuSheet({
  card,
  onClose,
  onAdjustDiners,
}: {
  /** 要确认的那一餐（卡片上的当前状态） */
  card: MealCard
  onClose: () => void
  /** 「去定人数」：交给点单页去开人数抽屉（两个抽屉不叠着开，先收起这个） */
  onAdjustDiners: () => void
}) {
  const updateStatus = useUpdateMealStatus()
  // 收起走抽屉自己的退场动画（见 BottomSheet 里的说明）：直接调 onClose 会让抽屉"啪"地消失
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())

  const confirm = () => {
    updateStatus.mutate(
      { mealKey: card.mealKey, status: 'PLANNED' },
      {
        onSuccess: () => {
          toast.success('这一餐定了')
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  /** 「去定人数」：先告诉调用方"收起后要开到哪"，再走自己的退场动画（弹出人数抽屉交给调用方） */
  const adjustDiners = () => {
    onAdjustDiners()
    closeSheet()
  }

  const whoOrdered = card.orderers.join(' · ')

  return (
    <BottomSheet ref={sheet} visible title="定下这一餐" onClose={onClose}>
      <p className="confirm-menu__head">
        {card.date} · {card.mealLabel}
        <span className="confirm-menu__count">共 {card.dishCount} 道</span>
      </p>

      <div className="confirm-menu__dishes">
        {card.dishes.map((line) => (
          <div className="confirm-menu__dish" key={`${line.recipeId ?? line.name}`}>
            <div className="confirm-menu__dish-name">
              {line.name}
              {line.count > 1 && <b className="confirm-menu__times">×{line.count}</b>}
            </div>
            {/* 备注随菜走（F3-05）：定之前正是要看"小满那份不要辣"有没有漏 */}
            {line.notes.map((note) => (
              <div className="confirm-menu__note" key={`${note.nickname}-${note.text}`}>
                {note.nickname}：{note.text}
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="confirm-menu__who">
        {whoOrdered} 点的 · {card.ordererCount} 人点了
      </p>

      {/* 人数没定就摆出来（不是拦路的错误，是提醒）；定了就显示，并保留一个改的入口 */}
      <button type="button" className="confirm-menu__diners" onClick={adjustDiners}>
        🍚 {card.dinerCount ? `${card.dinerCount} 人吃` : '还没定几个人吃'}
        <span className="confirm-menu__diners-go">{card.dinerCount ? '改' : '去定'}</span>
      </button>

      <p className="confirm-menu__hint">
        定下来之后菜单就锁上了：想再加菜，要先取消这一餐（取消后重新点，这一餐会回到待确认）。
      </p>

      <button
        type="button"
        className="recipe-button confirm-menu__submit"
        disabled={updateStatus.isPending}
        onClick={confirm}
      >
        {updateStatus.isPending ? '正在定…' : '就这些，定了'}
      </button>
      <button type="button" className="confirm-menu__cancel" onClick={closeSheet}>
        再看看
      </button>
    </BottomSheet>
  )
}
