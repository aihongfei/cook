import { useRef, useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { shrinkImage, useCheckInStats, useUploadCheckIn } from '@/api/checkins'
import BottomSheet from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'

/**
 * 打卡上传（M9 / F9-07、F9-08）。
 *
 * - 选图/拍照（`accept="image/*"` + `capture` 之外由系统决定，安卓上会同时给相册与相机）；
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
  const fileRef = useRef<HTMLInputElement>(null)

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
          onClose()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet visible={visible} title="打卡拍照" onClose={onClose}>
      <p className="checkin-sheet__hint">拍下今天做的那道菜。家里的每个人都能看到，一起攒这本相册。</p>

      <input
        ref={fileRef}
        className="checkin-sheet__file"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="选择照片"
        onChange={(event) => {
          void pick(event.target.files?.[0])
          // 清掉 value：否则连着选同一个文件不会再触发 change
          event.target.value = ''
        }}
      />

      <button type="button" className="checkin-sheet__picker" disabled={preparing} onClick={() => fileRef.current?.click()}>
        {preparing ? '正在处理照片…' : preview ? '换一张' : '选一张照片 / 拍照'}
      </button>

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
