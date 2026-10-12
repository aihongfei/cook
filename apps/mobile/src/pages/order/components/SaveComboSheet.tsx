import { useRef, useState } from 'react'
import { DotLoading } from 'antd-mobile'
import { apiErrorMessage } from '@/api/client'
import { useCreateCombo } from '@/api/combos'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'

/**
 * 把这一餐存成常用组合（M4 / F4-04）。
 *
 * 为什么入口放在点单卡上（而不是让用户到组合页从零挑菜）：**组合天然是"从一顿饭里长出来的"**——
 * 用户刚刚把这一餐配齐了，此刻"下次也照这样点"的念头最强，顺手存下来的成本最低。
 * 组合页只管用与删，不从那里新建（那里的空状态会指路回这里）。
 *
 * 只收名字与说明：菜就是这一餐的菜（后端的 `recipeIds` 按菜谱 id 去重，
 * 同一道菜多人点也只会进组合一次）。
 */
export default function SaveComboSheet({
  dishes,
  defaultName,
  onClose,
}: {
  /** 这一餐要存进去的菜（来自点单卡，已按菜谱合并） */
  dishes: { recipeId: string | null; name: string }[]
  /** 预填的名字（如"今天晚餐"），用户改掉即可 */
  defaultName: string
  onClose: () => void
}) {
  const create = useCreateCombo()
  // 收起走抽屉自己的退场动画（见 BottomSheet 里那段 ⚠️）
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())
  const [name, setName] = useState(defaultName)
  const [note, setNote] = useState('')

  // 自己写的菜（F3-10）没有菜谱 id，不能进组合——组合里存的必须是菜谱库里的菜，
  // 否则"一键加入"下次就会去找一道库里没有的菜。这里如实说清会被略过。
  const usable = dishes.filter((dish): dish is { recipeId: string; name: string } => Boolean(dish.recipeId))
  const skipped = dishes.filter((dish) => !dish.recipeId)

  const trimmed = name.trim()

  const submit = () => {
    if (!trimmed || usable.length === 0) return
    create.mutate(
      { name: trimmed, note: note.trim() || undefined, recipeIds: usable.map((dish) => dish.recipeId) },
      {
        onSuccess: () => {
          toast.success(`已存成「${trimmed}」`)
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet ref={sheet} visible title="存成常用组合" onClose={onClose}>
      <p className="order-sheet__hint">
        这一餐有 {dishes.length} 道：{dishes.map((dish) => dish.name).join('、')}
      </p>
      {skipped.length > 0 && (
        <p className="order-sheet__hint">
          自己写的 {skipped.map((dish) => dish.name).join('、')} 不在菜谱库里，存不进组合（其余正常的能存）。
        </p>
      )}

      <label className="order-sheet__group">
        <span className="order-sheet__label">组合叫什么</span>
        <input
          className="order-sheet__note"
          value={name}
          maxLength={24}
          placeholder="如：工作日的三菜一汤"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <label className="order-sheet__group">
        <span className="order-sheet__label">什么时候吃（可以不填）</span>
        <input
          className="order-sheet__note"
          value={note}
          maxLength={60}
          placeholder="如：工作日的晚上"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <button
        type="button"
        className="recipe-button order-sheet__submit"
        disabled={create.isPending || !trimmed || usable.length === 0}
        onClick={submit}
      >
        {create.isPending ? <DotLoading color="currentColor" /> : `存下这 ${usable.length} 道`}
      </button>
    </BottomSheet>
  )
}
