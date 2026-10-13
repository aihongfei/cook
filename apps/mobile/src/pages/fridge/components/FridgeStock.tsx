import { useState } from 'react'
import { useFridge, type FridgeItem, type FridgeZone, type FridgeZoneGroup } from '@/api/fridge'
import { useFridgeView } from '@/stores/fridge-view'
import { findPresetByName, ingredientImage } from '../ingredients'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import FridgeScanSheet from './FridgeScanSheet'
import FridgeItemSheet from './FridgeItemSheet'

/**
 * 冰箱里有什么（M6 / F6-01~F6-05）。形态见 D-049；**B 方案（段控 + 两列）见 D-063**。
 *
 * 这一块替掉了原来那段"骨架 + 明说还没做"（D-040 时的诚实写法）——现在数据是真的了，
 * 所以**一个假数字都不留**：空冰箱就说"冰箱是空的，点右上角记一样"。
 *
 * 四件刻意的：
 * - **临期排最前**（F6-05「今日先吃」）：冰箱这个界面的用途是"今天做什么"，
 *   把还有两个月的酱油排在上面没有意义。后端已经排好，前端不再排一遍。
 * - **每样都给图**（有图就出图）：冰箱是视觉的界面——一列纯文字在"我有什么"这件事上
 *   比图片难扫得多（也是将来 3D 预览要的同一套语汇）。
 * - **点一下就改**：行本身就是编辑入口（数量、位置、保质期都会变），
 *   不为改一个数量再进一层菜单。
 * - **四区不再 2×2 铺开**（B 方案）：四格并排铺开时，空的格子会被同行那一格撑到同高，
 *   两格加起来 600 多 px 只为说一句"这格里没有东西"，把下面"能做点什么"整个顶出首屏
 *   （实测：两块 1619px ≈ 2.1 屏，做菜那块从 y=969 开始）。现在是一行段控选一格、
 *   选中那格全宽两列——**这一处也正是将来 3D 冰箱要占的位置**（F17-02，见 D-063）。
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
            {/* 名字单独包一层：两列布局下要给它 -webkit-line-clamp:2（数量不能跟着被截掉） */}
            <span className="fitem__name-text">{item.name}</span>
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
  /*
   * 展开状态放 store 不放 useState：这一块里的食材行能点进编辑、而上面"能做点什么"
   * 的菜能点进详情——都是路由跳转，回来时这一块必须**还是展着的**
   * （同一条规矩见 `stores/fridge-view.ts` 文件头）。
   */
  const open = useFridgeView((state) => state.recentOpen)
  const setOpen = useFridgeView((state) => state.setRecentOpen)
  if (items.length === 0) return null
  return (
    <div className="recent">
      <button
        type="button"
        className={['recent__toggle', open && 'is-open'].filter(Boolean).join(' ')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
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

/**
 * 默认展开哪一格：**样数最多的那一格**（并列时按 `FRIDGE_ZONES` 的顺序取靠前的那个）。
 *
 * 为什么不取第一个非空的区：这一格的内容是用户打开页面后唯一看见的食材，
 * 而"常温 2 样"这种小格会让人以为冰箱里就这么点东西。样数最多的那格信息量最大，
 * 也最像"打开冰箱门"看到的画面。
 *
 * 用户点过任何一格之后就以用户的选择为准（store 里的 `zone`），不再走这个默认值——
 * 记一样东西进来把别的区顶成"最多"时，不该把用户正在看的那格换掉。
 */
function busiestZone(zones: FridgeZoneGroup[]): FridgeZone {
  let best = zones[0]
  for (const group of zones) if (group.items.length > best.items.length) best = group
  return best.zone
}

export default function FridgeStock({ enabled }: { enabled: boolean }) {
  const fridge = useFridge({ enabled })
  const [editing, setEditing] = useState<FridgeItem | null>(null)
  const [adding, setAdding] = useState(false)
  /** 拍照录入（F16-04）。它是一整条流程（认图 → 逐项确认 → 入库），所以单开一个抽屉 */
  const [scanning, setScanning] = useState(false)
  /*
   * 选中哪一格放 **store** 不放 useState：上面的菜能点进详情，那是一次路由跳转、
   * 冰箱页会被整个卸载。用 useState 的话用户看完做法返回时会跳回默认那一格，
   * 他刚才特意点开的「常温」没了（浏览器实测抓到过，见 `stores/fridge-view.ts`）。
   */
  const activeZone = useFridgeView((state) => state.zone)
  const setActiveZone = useFridgeView((state) => state.setZone)

  const board = fridge.data
  const group = board && board.zones.length > 0
    ? board.zones.find((item) => item.zone === activeZone) ?? board.zones.find((item) => item.zone === busiestZone(board.zones))!
    : null

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

      {board && board.summary.total > 0 && group && (
        <>
          {/*
           * 四区收成一行段控：**哪一格有东西、哪一格是空的要一眼看得出**，
           * 所以空的那颗用虚线弱化 + 一个「空」字，而不是干脆不显示
           * （不显示的话用户会以为家里没有"保鲜"这一格）。
           */}
          <div className="zchips">
            {board.zones.map((each) => {
              const on = each.zone === group.zone
              return (
                <button
                  key={each.zone}
                  type="button"
                  className={['zchip', on && 'is-on', each.items.length === 0 && 'is-empty'].filter(Boolean).join(' ')}
                  aria-pressed={on}
                  onClick={() => setActiveZone(each.zone)}
                >
                  <span>{each.zone}</span>
                  {each.items.length > 0 ? (
                    <span className="zchip__count">{each.items.length}</span>
                  ) : (
                    <span className="zchip__none">空</span>
                  )}
                </button>
              )
            })}
          </div>

          {/*
           * 选中那一格：**全宽两列**。原来 2×2 时每格只有 159px 宽，
           * 名字和数量挤在一起；现在一格占满，两列正好把 10 样排成 5 行。
           */}
          <div className="zpanel">
            {group.items.length === 0 ? (
              // 这一格**确实**是空的（不是"还没做"）：说"没有"就行
              <p className="zpanel__empty">{group.zone}格里没有东西。</p>
            ) : (
              <ul className="fitem-list fitem-list--2col">
                {group.items.map((item) => (
                  <ItemRow key={item.id} item={item} onOpen={() => setEditing(item)} />
                ))}
              </ul>
            )}
          </div>
        </>
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
