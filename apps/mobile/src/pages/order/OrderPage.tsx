import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFamily } from '@/api/family'
import CheckInUploadSheet from '@/pages/checkins/components/CheckInUploadSheet'
import DinerCountSheet from './components/DinerCountSheet'
import FreeDishSheet from './components/FreeDishSheet'
import {
  useOrders,
  useRemoveOrderItem,
  useUpdateMealStatus,
  type MealCard,
  type OrderStatus,
} from '@/api/orders'
import Chips from '@/components/ui/Chips'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import Page from '@/components/ui/Page'
import { STATUS_TONE } from '@/components/ui/status-tone'
import { toast } from '@/components/ui/toast'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import '../shared.scss'
import './order.scss'

/**
 * 家庭点菜单（M3 / F3-01~F3-05，口径见 D-022）。
 *
 * 三点刻意的做法：
 * - **状态机不硬编码**：每张卡的按钮来自后端下发的 `nextActions`（按我的角色算好的），
 *   所以"吃货看不到管理按钮"不是前端藏出来的，改规则也不用发前端版本；
 * - **计数徽标由后端给**（`counts`），切换筛选时不会把其它状态的数字清成 0；
 * - **不可逆的动作先问一句**：取消整餐与撤回自己点的菜都走 ConfirmDialog。
 *   前者影响全家人（砖红），后者只影响自己（普通色）。
 */

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: '待确认',
  PLANNED: '已安排',
  COOKING: '准备中',
  DONE: '已做好',
  CANCELED: '已取消',
}

/** 待确认的动作：整餐流转 / 撤回自己的一份 */
type PendingAction =
  | { kind: 'status'; card: MealCard; status: OrderStatus; label: string }
  | { kind: 'withdraw'; card: MealCard; dishName: string; itemId: string }
  | null

/** 要传成品照的那一餐（F9-08）：只在「已做好」的卡片上有入口 */

function formatSubmittedAt(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)} / ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} 提交`
}

export default function OrderPage() {
  const location = useLocation()
  const family = useFamily()
  const [scope, setScope] = useState<'family' | 'mine'>('family')
  const [filter, setFilter] = useState<string>('ALL')
  const [pending, setPending] = useState<PendingAction>(null)
  const [uploadMealKey, setUploadMealKey] = useState<string | null>(null)
  // 正在定人数的餐（M4 / F4-05）：null = 抽屉关着
  const [dinersFor, setDinersFor] = useState<MealCard | null>(null)
  // 「自己写一道」（F3-10）：每次打开 +1 用来给抽屉换 key（抽屉不在 effect 里清状态，靠重挂载拿回干净的一份）
  const [freeDishOpen, setFreeDishOpen] = useState(false)
  const [freeDishSeq, setFreeDishSeq] = useState(0)
  const openFreeDish = () => {
    setFreeDishSeq((value) => value + 1)
    setFreeDishOpen(true)
  }

  // 没加入家庭就别请求点单接口（后端会 404）：等 family 查询回来再决定
  const orders = useOrders(scope, filter, { enabled: Boolean(family.data) })
  const updateStatus = useUpdateMealStatus()
  const removeItem = useRemoveOrderItem()

  const counts = orders.data?.counts ?? {}
  // 一个都没有的状态不占位置（免得顶上挂一排 0）——但当前选中的那个必须留着，否则切不回去
  const chips = (
    [
      { id: 'ALL', label: '全部' },
      { id: 'PENDING', label: '待确认' },
      { id: 'PLANNED', label: '已安排' },
      { id: 'COOKING', label: '准备中' },
      { id: 'DONE', label: '已做好' },
      { id: 'CANCELED', label: '已取消' },
    ] as const
  )
    .filter((status) => status.id === 'ALL' || (counts[status.id] ?? 0) > 0 || filter === status.id)
    .map((status) => ({ id: status.id, label: status.label, count: counts[status.id] ?? 0 }))

  const closeDialog = () => setPending(null)

  const confirmAction = () => {
    const action = pending
    if (!action) return
    closeDialog()

    if (action.kind === 'status') {
      updateStatus.mutate(
        { mealKey: action.card.mealKey, status: action.status },
        {
          onSuccess: (card) => toast.success(`这餐：${STATUS_LABEL[card.status]}`),
          onError: (error) => toast.error(apiErrorMessage(error)),
        },
      )
      return
    }

    removeItem.mutate(action.itemId, {
      onSuccess: () => toast.success('已撤回你点的那份'),
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  const advance = (card: MealCard, status: OrderStatus) => {
    updateStatus.mutate(
      { mealKey: card.mealKey, status },
      {
        // 状态标签本身就带"已"（已安排/已做好），不能再套"这餐已…"，否则是「这餐已已安排」
        onSuccess: (updated) => toast.success(`这餐：${STATUS_LABEL[updated.status]}`),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const dialog =
    pending === null
      ? { title: '', message: '', confirmText: '确定', tone: 'normal' as const }
      : pending.kind === 'status'
        ? {
            title: pending.label,
            message:
              pending.status === 'CANCELED'
                ? // 取消不是死路：这一餐之后还能重新点（后端会把它拉回待确认）——说清楚，别让人以为这一天废了
                  '取消后这一餐就作废了。之后想再点，重新点这道菜就行，这一餐会回到「待确认」。'
                : `把这餐标成「${STATUS_LABEL[pending.status]}」？家里人都能看到这个状态。`,
            confirmText: pending.label,
            tone: pending.status === 'CANCELED' ? ('danger' as const) : ('normal' as const),
          }
        : {
            title: '撤回这份',
            message: `把「${pending.dishName}」从这餐里撤回？撤回后要重新加一次。`,
            confirmText: '撤回',
            tone: 'normal' as const,
          }

  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">家宴点菜单</div>
        <div className="psub">记录大家想吃什么，也记录每顿饭的回应</div>

        <div className="segmented">
          <button
            type="button"
            className={['segmented__item', scope === 'family' && 'is-active']
              .filter(Boolean)
              .join(' ')}
            onClick={() => setScope('family')}
          >
            全家点菜单
          </button>
          <button
            type="button"
            className={['segmented__item', scope === 'mine' && 'is-active']
              .filter(Boolean)
              .join(' ')}
            onClick={() => setScope('mine')}
          >
            只看我的
          </button>
        </div>

        {family.data && orders.data && <Chips items={chips} value={filter} onChange={setFilter} />}

        {/* 自己写一道（F3-10）：菜谱库里没有的菜（家里自己常做的、今天就想吃的）也能点。
            放在筛选之下、卡片之上：它是"加点什么"的动作，与浏览已有单子不是一回事。 */}
        {family.data && (
          <button type="button" className="order-freedish" onClick={openFreeDish}>
            <span className="order-freedish__icon">✍️</span>
            <span className="order-freedish__text">
              自己写一道
              <small>菜谱库里没有的菜，写个名字就能点</small>
            </span>
            <span className="order-freedish__arrow">›</span>
          </button>
        )}

        {!family.isPending && !family.data && (
          <div className="order-empty">
            <p>点菜单是给家里人一起用的。</p>
            <Link className="recipe-button" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭
            </Link>
          </div>
        )}

        {family.data && orders.isPending && (
          <div className="order-status">
            <RecipeStatus title="正在翻点菜单…" loading />
          </div>
        )}
        {family.data && orders.isError && (
          <div className="order-status">
            <RecipeStatus
              title="点菜单暂时打不开"
              onRetry={() => {
                void orders.refetch()
              }}
            >
              {apiErrorMessage(orders.error)}
            </RecipeStatus>
          </div>
        )}

        {family.data && orders.data && orders.data.cards.length === 0 && (
          <EmptyState
            title={filter === 'ALL' ? '还没有人点菜' : '这个状态下没有点单'}
            desc={
              filter === 'ALL'
                ? '翻到想吃的菜，点「想吃这道」，家里人就能看到；也可以自己写一道。'
                : '换个状态看看。'
            }
          />
        )}

        {orders.data?.cards.map((card) => (
          <article className="order-card" key={card.mealKey}>
            <div className="order-card__head">
              <div>
                <div className="order-card__date">
                  {card.date} · {card.mealLabel}
                </div>
                <div className="order-card__who">{card.orderers.join(' · ')} 点的</div>
              </div>
              <span className={['stamp', STATUS_TONE[card.status]].filter(Boolean).join(' ')}>
                {card.statusLabel}
              </span>
            </div>

            <div className="order-card__dishes">
              {card.dishes.map((line) => (
                <div className="order-card__dish" key={`${line.recipeId ?? line.name}`}>
                  <div className="order-card__dish-name">
                    {line.name}
                    {line.count > 1 && <b className="order-card__count">×{line.count}</b>}
                  </div>
                  {/* 谁交代了什么，挨着那道菜显示——备注是随菜传的（F3-05） */}
                  {line.notes.map((note) => (
                    <div className="order-card__dish-note" key={`${note.nickname}-${note.text}`}>
                      {note.nickname}：{note.text}
                    </div>
                  ))}
                  {/* 撤回只在我点过、且这餐还在「待确认」时给（后端同样会校验一次） */}
                  {line.mineItemIds.length > 0 && card.status === 'PENDING' && (
                    <button
                      type="button"
                      className="order-card__withdraw"
                      onClick={() =>
                        setPending({
                          kind: 'withdraw',
                          card,
                          dishName: line.name,
                          itemId: line.mineItemIds[line.mineItemIds.length - 1],
                        })
                      }
                    >
                      撤回我这份
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="order-card__foot">
              <span>
                共 {card.dishCount} 道 · {card.ordererCount} 人点了
                {card.mineCount > 0 && `（含我点的 ${card.mineCount} 份）`}
              </span>
              <span>{formatSubmittedAt(card.submittedAt)}</span>
            </div>

            {/* 就餐人数（M4 / F4-05）：含没点菜只吃饭的家人，所以和"N 人点了"分开显示。
                能到这一餐的人才看得到；没定就写"还没定"，别显示 0。 */}
            <button type="button" className="order-card__diners" onClick={() => setDinersFor(card)}>
              🍚{' '}
              {card.dinerCount
                ? `${card.dinerCount} 人吃（${card.ordererCount} 人点了）`
                : '还没定几个人吃'}
              {card.nextActions.length > 0 && ' · 改'}
            </button>

            {/* 成品照（F9-08）：只有做好的那一餐才给这个入口——照片是"做出来了"的证据。
                已传过的显示张数，并给一个"去看看"的入口（照片都在打卡墙那一餐下） */}
            {card.status === 'DONE' && (
              <div className="order-card__photos">
                {card.photoCount > 0 && (
                  <Link className="order-card__photo-link" to="/checkins" state={{ from: '/order' }}>
                    已传 {card.photoCount} 张成品照，去看看 →
                  </Link>
                )}
                <button type="button" className="order-card__photo" onClick={() => setUploadMealKey(card.mealKey)}>
                  📷 {card.photoCount > 0 ? '再传一张' : '上传这餐的成品照'}
                </button>
              </div>
            )}

            {card.nextActions.length > 0 && (
              <div className="order-card__actions">
                {card.nextActions.map((action) => (
                  <button
                    key={action.status}
                    type="button"
                    className={[
                      'order-card__action',
                      action.status === 'CANCELED' ? 'order-card__action--danger' : 'is-primary',
                    ].join(' ')}
                    disabled={updateStatus.isPending}
                    onClick={() => {
                      // 影响别人的动作（取消整餐）先问一句；正常推进（选好了/开始做/做好了）直接生效
                      if (action.needsConfirm)
                        setPending({
                          kind: 'status',
                          card,
                          status: action.status,
                          label: action.label,
                        })
                      else advance(card, action.status)
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      {uploadMealKey && (
        <CheckInUploadSheet
          visible
          presetMealKey={uploadMealKey}
          onClose={() => setUploadMealKey(null)}
        />
      )}

      {dinersFor && <DinerCountSheet card={dinersFor} onClose={() => setDinersFor(null)} />}

      {/* key 每次打开都变：重挂载拿回干净的一份（抽屉不用 effect 清状态，见 FreeDishSheet） */}
      {freeDishOpen && (
        <FreeDishSheet key={`free-${freeDishSeq}`} visible onClose={() => setFreeDishOpen(false)} />
      )}

      <ConfirmDialog
        open={pending !== null}
        title={dialog.title}
        message={dialog.message}
        confirmText={dialog.confirmText}
        tone={dialog.tone}
        pending={updateStatus.isPending || removeItem.isPending}
        onConfirm={confirmAction}
        onCancel={closeDialog}
      />
    </Page>
  )
}
