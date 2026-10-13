import { useRef, useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { shrinkImage } from '@/api/checkins'
import { scanFridge, uploadAiAttachment, type FridgeScanDraft } from '@/api/ai'
import { useAddFridgeItem, type FridgeZone } from '@/api/fridge'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import PhotoSourceInputs from '@/components/ui/PhotoSource'
import { photoSourceIds } from '@/components/ui/photo-source'
import { CloseIcon } from '@/components/icons/TabIcons'
import { toast } from '@/components/ui/toast'

/**
 * 拍照录入冰箱（F16-04；用户 2026-10-13「冰箱ocr识别食材那块也可以开始干了」）。
 *
 * **三步，一步都不能省**：拍照 → 识别出的清单**逐项可改** → 用户点「都记进去」才入库。
 * 为什么"逐项确认"不是可有可无的一步：照片识别一定会认错（塑料袋里的东西、叠在一起的盒子、
 * 反光的包装），而冰箱是「今日先吃」与推荐的输入——错一条会让用户照着过期的做菜；
 * 更糟的是用户会因此不再信这个功能。所以识别结果**永远是草稿**。
 *
 * 三条与后端约定一致的做法：
 * - **入库走用户自己那条** `POST /fridge`（与手填同一个口）：校验、同名同区 409、
 *   "共享关了时吃货只能动自己的"这些边界全部继承，不另写一份；
 * - **一件一件加**：后端那条接口是单件接口，所以这里逐条提交。某一条撞名（409）时
 *   **留下那一条并说明**，其余照常入库——整体失败会让用户重拍一张，而绝大部分是对的；
 * - **不做"批量替换"**：识别出的名字与库里已有的同区同名会撞（那正是 409 的含义），
 *   这时该怎么合并不是这个面板能替用户决定的（他可能想改数量、也可能想删旧那条）。
 */
export default function FridgeScanSheet({
  visible,
  onClose,
}: {
  visible: boolean
  onClose: () => void
}) {
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())
  const addItem = useAddFridgeItem()

  const [stage, setStage] = useState<'pick' | 'reading' | 'review' | 'saving'>('pick')
  const [preview, setPreview] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [drafts, setDrafts] = useState<FridgeScanDraft[]>([])
  /** 已经成功入库的下标（入库后那一条要从清单里消失，不能让用户重复提交） */
  const [done, setDone] = useState<number[]>([])

  const read = async (file: File | undefined) => {
    if (!file) return
    setStage('reading')
    try {
      // 与打卡、菜谱配图同一套：先缩到 1600px 再传（手机原图 3–10MB）
      const shrunk = await shrinkImage(file)
      setPreview(shrunk)
      const { id } = await uploadAiAttachment(shrunk)
      const result = await scanFridge(id)
      setSummary(result.summary)
      setDrafts(result.items)
      setDone([])
      setStage('review')
      if (result.items.length === 0) {
        // 「一样都没认出来」是**正常结果**而不是错误：模型按要求不猜。
        // 但要说清下一步（重拍一张、或者手动记），不然用户以为功能坏了。
        toast.error('这张照片里没认出食材，换一张清楚点的，或者手动记一样')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : apiErrorMessage(error))
      setStage('pick')
    }
  }

  const editDraft = (index: number, patch: Partial<FridgeScanDraft>) => {
    setDrafts((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  /** 逐条入库。返回"成功了几条" */
  const save = async () => {
    setStage('saving')
    const failed: number[] = []
    const saved: number[] = []
    for (let index = 0; index < drafts.length; index += 1) {
      if (done.includes(index)) continue
      const row = drafts[index]
      if (!row.name.trim()) continue
      try {
        await addItem.mutateAsync({
          name: row.name.trim(),
          amount: row.amount?.trim() || undefined,
          zone: row.zone,
          note: row.note?.trim() || undefined,
        })
        saved.push(index)
      } catch (error) {
        failed.push(index)
        // 撞名那条说清是**哪一条**、为什么：用户要能一眼找到它去改
        toast.error(`「${row.name}」没记成：${apiErrorMessage(error)}`)
      }
    }

    if (saved.length > 0) {
      setDone((current) => [...current, ...saved])
      toast.success(`已记进去 ${saved.length} 样`)
    }
    if (failed.length === 0) {
      closeSheet()
      return
    }
    // 有没成的就留在清单里（用户改个名字再点一次），别把面板关掉让他从头再来
    setDrafts((current) => current.filter((_, index) => failed.includes(index)))
    setDone([])
    setStage('review')
  }

  const remaining = drafts.filter((_, index) => !done.includes(index))
  const busy = stage === 'saving'

  return (
    <BottomSheet ref={sheet} visible={visible} title="拍照记进冰箱" onClose={closeSheet}>
      {stage === 'pick' && (
        <>
          <p className="ai__tip">
            对着冰箱或者刚买的菜拍一张，我认一认有哪些食材。认得准的才写，认不准的我不猜——
            认完你先看一眼，改好了再记进去。
          </p>
          {/*
           * 两个入口分开（用户 2026-10-13：「需要能拍照或者从相册选两种」）：
           * 只有一个 `accept="image/*"` 时进相机还是进相册由系统决定，有些机型根本不给相机。
           * 带 `capture` 的那个才是"确定开相机"（见 PhotoSource.tsx）。
           */}
          <div className="fridge-scan__sources">
            <label className="fridge-scan__pick" htmlFor={photoSourceIds('fridge-scan').cameraId}>
              拍一张
            </label>
            <label className="fridge-scan__pick fridge-scan__pick--album" htmlFor={photoSourceIds('fridge-scan').albumId}>
              从相册选
            </label>
          </div>
          <PhotoSourceInputs id="fridge-scan" onPick={(file) => void read(file)} />
        </>
      )}

      {stage === 'reading' && (
        <div className="fridge-scan__reading">
          {preview && <img className="fridge-scan__preview" src={preview} alt="刚拍的那张" />}
          <p className="fridge-scan__status">正在认照片里的东西…</p>
        </div>
      )}

      {(stage === 'review' || stage === 'saving') && (
        <>
          {preview && <img className="fridge-scan__preview" src={preview} alt="刚拍的那张" />}
          {summary && <p className="fridge-scan__summary">{summary}</p>}

          {remaining.length === 0 ? (
            <p className="ai__tip">这一批都记进去了。要再拍一张就点下面的按钮。</p>
          ) : (
            <>
              <p className="fridge-scan__lead">认出来的这几样，改一改再记（改完点下面那颗按钮）：</p>
              <ul className="fridge-scan__list">
                {drafts.map((row, index) => (
                  <li className="fridge-scan__item" key={`${index}-${row.name}`}>
                    <input
                      className="fridge-scan__name"
                      value={row.name}
                      maxLength={40}
                      aria-label={`第 ${index + 1} 样的名字`}
                      onChange={(event) => editDraft(index, { name: event.target.value })}
                    />
                    <input
                      className="fridge-scan__amount"
                      value={row.amount ?? ''}
                      maxLength={24}
                      placeholder="数量"
                      aria-label={`第 ${index + 1} 样的数量`}
                      onChange={(event) => editDraft(index, { amount: event.target.value })}
                    />
                    <select
                      className="fridge-scan__zone"
                      value={row.zone}
                      aria-label={`第 ${index + 1} 样的存放区`}
                      onChange={(event) => editDraft(index, { zone: event.target.value as FridgeZone, zoneGuessed: false })}
                    >
                      {(['常温', '保鲜', '冷藏', '冷冻'] as const).map((zone) => (
                        <option key={zone} value={zone}>{zone}</option>
                      ))}
                    </select>
                    {/* 猜的区要标出来：不标的话，猜错的区会安安静静地待在那儿 */}
                    {row.zoneGuessed && <span className="fridge-scan__guessed">猜的</span>}
                    {/*
                      备注也摆出来（2026-10-13 实测抓到的静默通道）：模型爱把
                      "灰色蛋托中可见六枚"这种描述塞进备注，而这里原来不显示——
                      于是它悄悄跟着入库了。**用户没看过的字段不该被写进库**。
                    */}
                    <input
                      className="fridge-scan__note"
                      value={row.note ?? ''}
                      maxLength={60}
                      placeholder="备注（可不写）"
                      aria-label={`第 ${index + 1} 样的备注`}
                      onChange={(event) => editDraft(index, { note: event.target.value })}
                    />
                    <button
                      type="button"
                      className="fridge-scan__drop"
                      aria-label={`不要第 ${index + 1} 样`}
                      onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))}
                    >
                      <CloseIcon width={13} height={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="fridge-scan__actions">
            <button
              type="button"
              className="recipe-button fridge-scan__again"
              disabled={busy}
              onClick={() => { setStage('pick'); setDrafts([]); setDone([]); setPreview(null); setSummary('') }}
            >
              重拍一张
            </button>
            {remaining.length > 0 && (
              <button type="button" className="recipe-button fridge-scan__save" disabled={busy} onClick={() => void save()}>
                {busy ? '正在记…' : `都记进去（${remaining.length} 样）`}
              </button>
            )}
          </div>
        </>
      )}
    </BottomSheet>
  )
}
