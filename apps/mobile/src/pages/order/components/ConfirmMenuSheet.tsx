import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useUpdateMealStatus, type MealCard } from '@/api/orders'
import { useMealPreview } from '@/api/shopping'
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

      {/*
       * 「这一餐要买什么」（F7-06，用户 2026-10-14 报的第二件事）。
       *
       * 用户的原话：「订单那边如果冰箱中配料不齐给个提示，是否加入采购清单这样的，
       * 不要直接加到清单中」——所以这里**只提示、只给入口，绝不自动写清单**：
       * 采购清单是"按定了的菜单算出来的"（D-039），定这一餐之后它自己就会出现，
       * 手写进去的那些在菜单变了之后不会跟着变。
       */}
      <MealShoppingPreview mealKey={card.mealKey} onLeave={closeSheet} />

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

/**
 * 汇总页底部那一块：这一餐要买什么。
 *
 * 三件事刻意的：
 * - **不写库**：只 `GET /shopping-list/preview`。要不要买是用户自己的事，
 *   AI 或后端替他决定"这些该进清单"就越权了（用户原话：「不要直接加到清单中」）；
 * - **只在这儿看得到时机才对**：原来用户在"定这一餐"时看不到缺口，定完去清单页才发现——
 *   而那时菜单已经锁上（想撤要先取消整餐）。这一块让他在**定之前**就知道；
 * - **拿不到就不显示**（404 = 这一餐还没点菜 / 后端老版本）：不能因为一块提示
 *   把整个"定这一餐"的主流程拦住。抽屉里最重要的动作永远是那个「就这些，定了」。
 */
function MealShoppingPreview({ mealKey, onLeave }: { mealKey: string; onLeave: () => void }) {
  const navigate = useNavigate()
  const preview = useMealPreview(mealKey)
  if (preview.isError || !preview.data) return null
  const data = preview.data

  // 一道菜都没有（或全是没有配料表的自由菜品）：没什么可说的
  if (data.toBuyCount === 0 && data.coveredCount === 0 && data.missing.length === 0) return null

  return (
    <div className="confirm-menu__shopping">
      <div className="confirm-menu__shopping-head">
        <span>这一餐要买</span>
        <b>{data.toBuyCount > 0 ? `${data.toBuyCount} 样` : '不用买'}</b>
      </div>

      {data.toBuyCount > 0 ? (
        <p className="confirm-menu__shopping-list">
          {data.toBuy.slice(0, 12).map((item) => item.name).join('、')}
          {data.toBuyCount > 12 && ` 等 ${data.toBuyCount} 样`}
        </p>
      ) : (
        <p className="confirm-menu__shopping-list">冰箱里都有，直接做就行。</p>
      )}

      {data.coveredCount > 0 && (
        <p className="confirm-menu__shopping-note">
          家里已有 {data.coveredCount} 样{data.unsureCount > 0 ? `（其中 ${data.unsureCount} 样量算不清，够不够看一眼）` : ''}
        </p>
      )}
      {data.missing.length > 0 && (
        <p className="confirm-menu__shopping-note">
          {data.missing.join('、')} 没写配料表，要买什么自己拿主意
        </p>
      )}
      {data.stockEmpty && <p className="confirm-menu__shopping-note">记一下冰箱里有什么，这里就能替你算掉一部分</p>}

      {/*
       * 去清单的入口**只给一个**，并且带 `from` 让回程能回到这一页（`readBackLink` 那套）。
       * 定完这一餐清单才会把它算进去——所以这里说清"定了就是清单上的一份"，
       * 用户不会以为跳过去之后还得自己一条条加。
       *
       * ⚠️ **先关抽屉再走**（`onLeave`）：页面现在被缓存着（见 `layouts/KeepAlivePages`），
       * 不关的话这个抽屉会留在藏起来的订单页上，继续抢系统返回键、也看不见它在哪儿。
       * 原来这里只有一个 `navigate`——页面一重挂载就看不出来了，缓存之后它才现形。
       */}
      <button
        type="button"
        className="confirm-menu__shopping-go"
        onClick={() => {
          onLeave()
          navigate('/shopping', { state: { from: '/order' } })
        }}
      >
        去采购清单看看 →
      </button>
    </div>
  )
}
