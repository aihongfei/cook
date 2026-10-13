import { useState } from 'react'
import { useFridge, type FridgeItem } from '@/api/fridge'
import { findPresetByName, ingredientImage } from '../ingredients'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import FridgeScanSheet from './FridgeScanSheet'
import FridgeItemSheet from './FridgeItemSheet'

/**
 * 冰箱里有什么（M6 / F6-01~F6-05）。形态见 D-049。
 *
 * 这一块替掉了原来那段"骨架 + 明说还没做"（D-040 时的诚实写法）——现在数据是真的了，
 * 所以**一个假数字都不留**：空冰箱就说"冰箱是空的，点右上角记一样"。
 *
 * 三件刻意的：
 * - **临期排最前**（F6-05「今日先吃」）：冰箱这个界面的用途是"今天做什么"，
 *   把还有两个月的酱油排在上面没有意义。后端已经排好，前端不再排一遍。
 * - **每样都给图**（有图就出图）：冰箱是视觉的界面——一列纯文字在"我有什么"这件事上
 *   比图片难扫得多（也是将来 3D 预览要的同一套语汇）。
 * - **点一下就改**：行本身就是编辑入口（数量、位置、保质期都会变），
 *   不为改一个数量再进一层菜单。
 */
function ItemRow({ item, onOpen }: { item: FridgeItem; onOpen: () => void }) {
  const preset = findPresetByName(item.name)
  const image = preset ? ingredientImage(preset.id) : null
  return (
    <li className="fitem">
      <button type="button" className="fitem__main" onClick={onOpen}>
        <span className="fitem__pic">
          {image ? (
            <img src={image} alt="" aria-hidden loading="lazy" />
          ) : (
            // 没有对应图（用户自己打的字）：给中性占位，**不假装知道那是什么**
            <span className="fitem__pic-none" aria-hidden>🍽</span>
          )}
        </span>
        <span className="fitem__body">
          <span className="fitem__name">
            {item.name}
            {item.amount && <span className="fitem__amount">{item.amount}</span>}
          </span>
          {/*
           * 第二行只放**有用的话**：临期说还剩几天（这是这一行最该看见的），
           * 没写保质期就不提（不提 = 没写，而不是"不会坏"）。
           * 备注也在这儿——它常常就是"为什么要先吃"的原因。
           */}
          {(item.expiryLabel || item.note) && (
            <span className="fitem__meta">
              {item.expiryLabel && (
                <span className={['fitem__expiry', item.attention && 'is-attention'].filter(Boolean).join(' ')}>
                  {item.expiryLabel}
                </span>
              )}
              {item.note && <span className="fitem__note">{item.note}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

/**
 * 「最近录入」（M6 / F6-06）。口径见 D-062。
 *
 * 上面那四区回答"现在有什么"（按**临期**排），这一块回答"最近新添了什么、谁添的"
 * （按**记的时间**排）。两个问题不一样，所以是两块而不是一块：
 * 刚拍完照批量入库时，用户想核对的是"我刚记进去的那几样在不在"，
 * 而它们在按临期排的列表里是散开的。
 *
 * 默认收着：上面四区才是这一页的主体（用户 2026-10-13 明确说过"冰箱相关应该才是主题"），
 * 这一块是补充信息。可点开的那条线沿用采购清单与「都不合意？」那两处的语汇
 * （虚线上边框 + 圆形箭头 + 过渡动画），三处一致。
 */
function RecentList({ items, total }: { items: FridgeItem[]; total: number }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div className="recent">
      <button
        type="button"
        className={['recent__toggle', open && 'is-open'].filter(Boolean).join(' ')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="recent__toggle-text">
          最近记的 {items.length} 样
          {/* 只列了前 8 样时说清还有多少，免得用户以为冰箱里就这些 */}
          {total > items.length && `（一共 ${total} 样）`}
        </span>
        <span className={['recent__arrow', open && 'is-open'].filter(Boolean).join(' ')} aria-hidden>
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path
              d="M2.5 4.4 L6 7.9 L9.5 4.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && (
        <ul className="recent__list">
          {items.map((item) => (
            <li className="recent__item" key={item.id}>
              <span className="recent__name">{item.name}</span>
              {/* 数量可能没写（F6-01 允许为空）：没写就不显示这一格，不编一个"1" */}
              {item.amount && <span className="recent__amount">{item.amount}</span>}
              <span className="recent__when">{item.addedLabel}</span>
              {/*
               * 谁记的（共享关掉时后端已收窄成"只有自己放的"，那这里显示的也是自己）。
               * 这一句是这一块的重点之一："家里最近添了什么"不看人就只剩一半意思。
               */}
              <span className="recent__who">{item.addedBy}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function FridgeStock({ enabled }: { enabled: boolean }) {
  const fridge = useFridge({ enabled })
  const [editing, setEditing] = useState<FridgeItem | null>(null)
  const [adding, setAdding] = useState(false)
  /** 拍照录入（F16-04）。它是一整条流程（认图 → 逐项确认 → 入库），所以单开一个抽屉 */
  const [scanning, setScanning] = useState(false)

  const board = fridge.data

  return (
    <section className="card stock">
      <div className="stock__head">
        <span className="stock__title">冰箱里有什么</span>
        {/*
         * 两个录入入口并排在标题上：手动记（最常用、也最准）与**拍照记**
         * （用户 2026-10-13「冰箱ocr识别食材那块也可以开始干了」）。
         * 手填留在前、拍照在后：「拍一张就全有了」听着更省事，但识别一定会认错，
         * 而手填一个字都不会错——不该把用户往那条要核对的路引。
         */}
        <span className="stock__add-row">
          <button type="button" className="stock__add" onClick={() => setAdding(true)}>
            ＋ 记一样
          </button>
          <button type="button" className="stock__scan" onClick={() => setScanning(true)}>
            📷 拍照
          </button>
        </span>
      </div>

      {fridge.isPending && (
        <div className="stock__status-line">
          <RecipeStatus title="正在看冰箱里有什么…" loading />
        </div>
      )}
      {fridge.isError && (
        <div className="stock__status-line">
          <RecipeStatus title="冰箱暂时打不开" onRetry={() => { void fridge.refetch() }} />
        </div>
      )}

      {board && board.scope === 'mine' && (
        <p className="stock__scope">家里关了共享，这里只显示你自己放进去的。</p>
      )}

      {/* 有临期的先给一句总结（F6-02）：用户打开冰箱页想知道的第一件事是"有没有要先吃的" */}
      {board && board.summary.attention > 0 && (
        <p className="stock__soon-summary">
          {board.summary.expired === 0
            ? `有 ${board.summary.attention} 样该先吃`
            : board.summary.attention > board.summary.expired
              ? `有 ${board.summary.expired} 样过期了、${board.summary.attention - board.summary.expired} 样快到期`
              : // 全是过期的：说"0 样快到期"很难听，也说不出话——直接说过期了几样
                `有 ${board.summary.expired} 样过期了`}
        </p>
      )}

      {board && board.summary.total === 0 && (
        <p className="stock__empty">
          冰箱还是空的。买了什么就点右上角「记一样」，常见食材点一下就进——
          记下来之后，快到期的会排到最前面。
        </p>
      )}

      {board && board.summary.total > 0 && (
        <div className="stock__zones">
          {board.zones.map((group) => (
            <div className="stock__zone" key={group.zone}>
              <span className="stock__zone-name">
                {group.zone}
                {/* 每区的样数：四格里哪格有东西、哪格是空的，一眼看出来 */}
                {group.items.length > 0 && <span className="stock__zone-count">{group.items.length}</span>}
              </span>
              {group.items.length === 0 ? (
                // 这一区**确实**是空的（不是"还没做"）：说"没有"就行
                <span className="stock__zone-slot">这格里没有东西</span>
              ) : (
                <ul className="fitem-list">
                  {group.items.map((item) => (
                    <ItemRow key={item.id} item={item} onOpen={() => setEditing(item)} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 没写保质期的样数：说出来，用户才知道"快过期"为什么没提醒某些东西 */}
      {board && board.summary.total > 0 && board.summary.withExpiry < board.summary.total && (
        <p className="stock__hint">
          还有 {board.summary.total - board.summary.withExpiry} 样没记保质期，写了才能提醒你。
        </p>
      )}

      {/* 最近录入（F6-06）：四区之后、补充信息的位置 */}
      {board && <RecentList items={board.recent} total={board.recentTotal} />}

      {adding && <FridgeItemSheet visible onClose={() => setAdding(false)} />}
      {editing && <FridgeItemSheet visible item={editing} onClose={() => setEditing(null)} />}
      {scanning && <FridgeScanSheet visible onClose={() => setScanning(false)} />}
    </section>
  )
}
