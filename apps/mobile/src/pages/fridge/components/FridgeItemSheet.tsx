import { useRef, useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import { FRIDGE_ZONES, type FridgeItem, type FridgeZone } from '@/api/fridge'
import { useAddFridgeItem, useRemoveFridgeItem, useUpdateFridgeItem } from '@/api/fridge'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { toast } from '@/components/ui/toast'
import { ALL_PRESETS, INGREDIENT_PRESETS, findPresetByName, ingredientImage, searchPresets, type IngredientPreset } from '../ingredients'
import '../../../pages/shared.scss'

/**
 * 记一样食材 / 改一样食材（M6 / F6-03 手动录入）。形态见 D-049（拍照那半待多模态模型）。
 *
 * 这个抽屉是"站在冰箱前单手操作"的场景，所以三件事按这个场景定：
 *
 * - **常用食材点一下就进**（48 样，带图）：打字是这条流程里最慢的一步。
 *   点一个预设 = 填好名字 + 默认存放区 + 常见数量，只要再点「记进去」就行——
 *   也可以直接点图**连确认都省掉**（见 `pick`），因为"拿了盒鸡蛋放进冰箱"本来就该是一下。
 * - **数量与保质期都可空**：逼人填数字/日期会让人干脆不录，而"录了但没写多少"比"没录"有用。
 * - **保质期给快捷按钮**（今天/明天/三天后/一周后）：手选日期是最烦的输入；
 *   但**不默认填**——没写就是没写，替用户猜一个到期日会让他以为那盒奶真的那天坏。
 */
export default function FridgeItemSheet({
  visible,
  item,
  onClose,
}: {
  visible: boolean
  /** 传了就是编辑那一条；不传是新增 */
  item?: FridgeItem
  onClose: () => void
}) {
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())

  const add = useAddFridgeItem()
  const update = useUpdateFridgeItem()
  const remove = useRemoveFridgeItem()

  const [name, setName] = useState(item?.name ?? '')
  const [amount, setAmount] = useState(item?.amount ?? '')
  const [zone, setZone] = useState<FridgeZone>(item?.zone ?? '冷藏')
  const [expiresOn, setExpiresOn] = useState(item?.expiresOn ?? '')
  const [note, setNote] = useState(item?.note ?? '')
  const [keyword, setKeyword] = useState('')

  const isEdit = Boolean(item)
  const trimmed = name.trim()
  const matched = trimmed ? findPresetByName(trimmed) : null
  const matches = keyword ? searchPresets(keyword) : ALL_PRESETS
  const pending = add.isPending || update.isPending || remove.isPending

  /** 点一个预设：填好三样（名字/默认区/常见数量），**不直接提交**——数量与保质期还想改的人有地方改 */
  const pick = (preset: IngredientPreset) => {
    setName(preset.name)
    setZone(preset.zone)
    setAmount(preset.amount ?? '')
    setKeyword('')
  }

  /*
   * 写成功之后统一收尾：说一句 + 收起抽屉（走退场动画，见 BottomSheet 里那段 ⚠️）。
   * 放在组件作用域而不是各函数里：`submit` 与 `drop` 都要用（第一版把它写在 submit 里，
   * drop 引用它直接编译不过）。
   */
  const done = (message: string) => {
    toast.success(message)
    closeSheet()
  }

  const submit = () => {
    if (!trimmed) return
    const payload = {
      name: trimmed,
      // 空串要发成空（后端把它归一成 null）：编辑时用户**删掉**了数量，那就该真的删掉
      amount: amount.trim(),
      zone,
      expiresOn: expiresOn || '',
      note: note.trim(),
    }
    if (item) {
      update.mutate(
        { id: item.id, patch: payload },
        {
          onSuccess: () => done(`「${trimmed}」改好了`),
          onError: (error) => toast.error(apiErrorMessage(error)),
        },
      )
      return
    }
    add.mutate(payload, {
      onSuccess: () => done(`「${trimmed}」记进冰箱了`),
      // 同名同区已经有一条：后端会回一句人话（"直接改它就行"）。这里就照着提示走，
      // 不再自己编一套文案——那句话是把用户往正确操作上引的。
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  const drop = () => {
    if (!item) return
    remove.mutate(item.id, {
      onSuccess: () => done(`「${item.name}」拿出来了`),
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  /** 保质期快捷：按今天往后推 n 天（n=0 就是今天） */
  const quickExpiry = (days: number) => {
    const date = new Date()
    date.setDate(date.getDate() + days)
    const pad = (value: number) => String(value).padStart(2, '0')
    setExpiresOn(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
  }

  return (
    <BottomSheet ref={sheet} visible={visible} title={isEdit ? `改「${item?.name}」` : '记一样食材'} onClose={onClose}>
      {!isEdit && (
        <>
          <label className="fridge-sheet__search">
            <input
              className="fridge-sheet__input"
              value={keyword}
              placeholder="找常用食材（也可以自己在下面写）"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          {/*
           * 常用食材：**有图才扫得快**。一行四个、图在上名字在下，与手绘语汇一致
           * （也是将来 3D 预览要用的同一批图）。
           */}
          <div className="fridge-sheet__presets">
            {INGREDIENT_PRESETS.map((group) => {
              const items = group.items.filter((preset) => matches.includes(preset))
              if (items.length === 0) return null
              return (
                <div className="fridge-sheet__group" key={group.group}>
                  <span className="fridge-sheet__group-name">{group.group}</span>
                  <div className="fridge-sheet__grid">
                    {items.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={['fridge-sheet__preset', name === preset.name && 'is-active'].filter(Boolean).join(' ')}
                        aria-pressed={name === preset.name}
                        onClick={() => pick(preset)}
                      >
                        <img className="fridge-sheet__preset-pic" src={ingredientImage(preset.id)} alt="" aria-hidden loading="lazy" />
                        <span className="fridge-sheet__preset-name">{preset.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {matches.length === 0 && (
              <p className="fridge-sheet__no-match">
                常用食材里没有「{keyword}」——直接写在下面就行，一样的。
              </p>
            )}
          </div>
        </>
      )}

      <label className="fridge-sheet__group">
        <span className="fridge-sheet__label">叫什么</span>
        <div className="fridge-sheet__name-row">
          {/* 名字旁边给一张小图（认出来就出图）：用户一眼确认"记的是我以为的那个东西" */}
          {matched ? (
            <img className="fridge-sheet__name-pic" src={ingredientImage(matched.id)} alt="" aria-hidden />
          ) : (
            <span className="fridge-sheet__name-pic fridge-sheet__name-pic--none" aria-hidden>🍽</span>
          )}
          <input
            className="fridge-sheet__input"
            value={name}
            maxLength={40}
            placeholder="如：鸡蛋"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </label>

      <div className="fridge-sheet__group">
        <span className="fridge-sheet__label">放哪儿</span>
        <div className="fridge-sheet__choices">
          {FRIDGE_ZONES.map((value) => (
            <button
              key={value}
              type="button"
              className={['fridge-sheet__choice', value === zone && 'is-active'].filter(Boolean).join(' ')}
              aria-pressed={value === zone}
              onClick={() => setZone(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <label className="fridge-sheet__group">
        <span className="fridge-sheet__label">有多少（可以不填）</span>
        <input
          className="fridge-sheet__input"
          value={amount}
          maxLength={24}
          placeholder="如：一盒、半颗、约 500g"
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>

      <div className="fridge-sheet__group">
        <span className="fridge-sheet__label">
          保质期到哪天（可以不填）
          {/* 说明"不填会怎样"，用户才知道这个字段值不值得填 */}
          <span className="fridge-sheet__label-hint">填了才会提醒你先吃</span>
        </span>
        <div className="fridge-sheet__expiry-row">
          <input
            className="fridge-sheet__input fridge-sheet__input--date"
            type="date"
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
          />
          {expiresOn && (
            <button type="button" className="fridge-sheet__clear" onClick={() => setExpiresOn('')}>
              清掉
            </button>
          )}
        </div>
        <div className="fridge-sheet__choices">
          <button type="button" className="fridge-sheet__choice" onClick={() => quickExpiry(0)}>今天</button>
          <button type="button" className="fridge-sheet__choice" onClick={() => quickExpiry(1)}>明天</button>
          <button type="button" className="fridge-sheet__choice" onClick={() => quickExpiry(3)}>三天后</button>
          <button type="button" className="fridge-sheet__choice" onClick={() => quickExpiry(7)}>一周后</button>
        </div>
      </div>

      <label className="fridge-sheet__group">
        <span className="fridge-sheet__label">交代一句（可以不填）</span>
        <input
          className="fridge-sheet__input"
          value={note}
          maxLength={60}
          placeholder="如：给奶奶买的、开口了要先吃"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <div className="fridge-sheet__actions">
        {item && (
          <button type="button" className="fridge-sheet__drop" disabled={pending} onClick={drop}>
            拿出来了
          </button>
        )}
        <button type="button" className="recipe-button fridge-sheet__submit" disabled={!trimmed || pending} onClick={submit}>
          {pending ? '正在记…' : isEdit ? '改好了' : '记进冰箱'}
        </button>
      </div>
    </BottomSheet>
  )
}
