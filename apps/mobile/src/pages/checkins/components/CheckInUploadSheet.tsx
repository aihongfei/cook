import { useRef, useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { shrinkImage, useCheckInStats, useUploadCheckIn } from '@/api/checkins'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import PhotoSourceButtons from '@/components/ui/PhotoSourceButtons'
import { toast } from '@/components/ui/toast'

/**
 * 打卡上传（M9 / F9-07、F9-08）。
 *
 * - **两个入口**：`capture="environment"` 的「拍一张」与不带 capture 的「从相册选」
 *   （用户 2026-10-16：「打卡拍照…现在没有拍照功能只能选择照片」——原先只有一个
 *   不带 capture 的控件，进不进相机全看系统，多数机型只进相册）；
 * - 选中后在浏览器里**先缩到 1600px** 再传（手机原图 3–10MB → 通常 < 500KB）；
 * - 可以挂到某一餐（只列「已做好」的餐）：从点单卡进来时预先选中那一餐。
 *
 * 和 OrderDishSheet 同一套做法：状态只在首次挂载时按 props 初始化，**不在 effect 里同步 setState**
 * （多一次渲染，且 oxlint 的 set-state-in-effect 会拦）；所以调用方每次打开都要重挂载
 * （条件渲染或换 key），否则"上次选的照片/备注"会带到下一次。
 */
export default function CheckInUploadSheet({
  visible,
  presetMealKey,
  onClose,
  onUploaded,
}: {
  visible: boolean
  /** 从「已做好」的点单卡进来时带上，省一次选择 */
  presetMealKey?: string
  onClose: () => void
  onUploaded?: () => void
}) {
  const stats = useCheckInStats()
  const upload = useUploadCheckIn()
  // 收起走抽屉自己的退场动画（见 BottomSheet 里那段 ⚠️）：直接调 onClose 会让抽屉"啪"地消失
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())

  const [preview, setPreview] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [mealKey, setMealKey] = useState<string>(presetMealKey ?? '')
  const [preparing, setPreparing] = useState(false)

  const meals = stats.data?.attachableMeals ?? []
  // 从点单卡带进来的那一餐可能不在"最近 10 餐"里，补上，免得选择器里看不到自己被选中
  const preset = presetMealKey && !meals.some((item) => item.mealKey === presetMealKey)
    ? [{ mealKey: presetMealKey, label: '刚才那一餐' }, ...meals]
    : meals

  const pick = async (file: File | undefined) => {
    if (!file) return
    setPreparing(true)
    try {
      setPreview(await shrinkImage(file))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '这张图片处理不了')
    } finally {
      setPreparing(false)
    }
  }

  const submit = () => {
    if (!preview) return
    upload.mutate(
      { image: preview, note: note.trim() || undefined, mealKey: mealKey || undefined },
      {
        onSuccess: (created) => {
          toast.success(created.mealKey ? '成品照已上传，家里人能看到啦' : '打卡成功，家里人能看到啦')
          onUploaded?.()
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet ref={sheet} visible={visible} title="打卡拍照" onClose={onClose}>
      <p className="checkin-sheet__hint">拍下今天做的那道菜。家里的每个人都能看到，一起攒这本相册。</p>

      {/*
        两个入口分开（用户 2026-10-16：「我的打卡拍照…现在没有拍照功能只能选择照片」）：
        原先只有一个不带 `capture` 的控件，能否进相机完全看系统给不给，
        多数机型只进相册——所以按钮上写「选一张照片 / 拍照」是**不成立的承诺**。
        现在「拍一张」带 `capture`、「从相册选」不带，两个都在（见 `PhotoSourceButtons`）。
      */}
      <PhotoSourceButtons
        id="checkin-upload"
        busy={preparing}
        cameraLabel={preview ? '重拍一张' : '拍一张'}
        onPick={(file) => void pick(file)}
      />

      {/* 缩图要花一两秒，得说出来——原来那句话挂在那颗被禁用的按钮上，按钮拆成两颗后单独留一句 */}
      {preparing && <p className="checkin-sheet__hint">正在处理照片…</p>}

      {preview && <img className="checkin-sheet__preview" src={preview} alt="待上传的照片预览" />}

      <label className="checkin-sheet__field">
        <span>说一句（可以不填）</span>
        <input
          value={note}
          maxLength={60}
          placeholder="如：给小满做的生日面"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {preset.length > 0 && (
        <label className="checkin-sheet__field">
          <span>挂到哪一餐（可以不选）</span>
          <select value={mealKey} onChange={(event) => setMealKey(event.target.value)}>
            <option value="">不挂，就是随手打卡</option>
            {preset.map((meal) => (
              <option key={meal.mealKey} value={meal.mealKey}>
                {meal.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <button type="button" className="recipe-button checkin-sheet__submit" disabled={!preview || upload.isPending} onClick={submit}>
        {upload.isPending ? '正在上传…' : '传上去'}
      </button>
    </BottomSheet>
  )
}
