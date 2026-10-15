import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFamily, CAPABILITY, can } from '@/api/family'
import { useMeal, useRemoveOrderItem, useUpdateMealStatus, type MealCard, type OrderStatus } from '@/api/orders'
import CheckInUploadSheet from '@/pages/checkins/components/CheckInUploadSheet'
import ConfirmMenuSheet from './components/ConfirmMenuSheet'
import DinerCountSheet from './components/DinerCountSheet'
import RepeatMealSheet from './components/RepeatMealSheet'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { STATUS_TONE } from '@/components/ui/status-tone'
import { toast } from '@/components/ui/toast'
import { readBackLink } from '@/pages/back-link'
import '@/pages/shared.scss'
import './order-detail.scss'

/**
 * 某一餐的详情（用户 2026-10-15：「订单里卡片增加下详情吧，可以点击进去看详细的」）。
 *
 * 列表卡片是**摘要**（谁点的、几道菜、状态），装不下的那几样在这里：
 * **谁点的是哪一份**（逐份列出，含备注与时间）、**谁定的、谁做的**、成品照、以及全部动作。
 *
 * 三段分开的理由：这三件事的**更新时刻完全不同**——点菜随时在加、定菜单是一次性的、
 * 做好了是终态。混在一段里，用户没法一眼看出"这一餐现在走到哪一步了"。
 *
 * 数据来源与列表是**同一个接口形状**（`GET /orders/:mealKey` 回的就是 `MealCard`），
 * 所以这里不另立一套口径；可见性也由后端守着（共享关闭时吃货看不到自己没参与的餐）。
 */

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: '待确认',
  PLANNED: '已安排',
  COOKING: '准备中',
  DONE: '已做好',
  CANCELED: '已取消',
}

type PendingAction =
  | { kind: 'status'; card: MealCard; status: OrderStatus; label: string }
  | { kind: 'withdraw'; card: MealCard; dishName: string; itemId: string; byWhom: string | null }
  | null

/** 到分钟就够；"谁几点定的"不需要秒 */
function formatClock(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)} / ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 日期说成人话（今天/明天/后天，再远的写月-日）——与卡片列表同一口径 */
function dayLabel(date: string): string {
  const today = new Date()
  const keyOf = (offset: number) => {
    const value = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  if (date === keyOf(0)) return '今天'
  if (date === keyOf(1)) return '明天'
  if (date === keyOf(2)) return '后天'
  return date.slice(5)
}

export default function OrderDetailPage() {
  const { mealKey } = useParams<{ mealKey: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const family = useFamily()
  const back = readBackLink(location.state, '/order')

  const meal = useMeal(mealKey)
  const updateStatus = useUpdateMealStatus()
  const removeItem = useRemoveOrderItem()

  const [pending, setPending] = useState<PendingAction>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [confirmFor, setConfirmFor] = useState<MealCard | null>(null)
  const [dinersFor, setDinersFor] = useState<MealCard | null>(null)
  const [repeatFor, setRepeatFor] = useState<MealCard | null>(null)
  // 确认抽屉里点了「去定人数」：等它**真的收起来**再开人数抽屉（两个不叠着开）
  const [openDinersAfterClose, setOpenDinersAfterClose] = useState(false)

  const card = meal.data

  /**
   * 逐份的清单按**人**归拢：卡片列表把同一道菜合成一行（"红烧排骨 ×2"），
   * 但详情页要回答的是"谁点的是哪一份"——所以这里用 `items`（未合并的原始记录）。
   * 同一道菜两人的备注不同，合并后就看不出来了（这正是摘要装不下的东西）。
   */
  const byPerson = useMemo(() => {
    if (!card) return []
    const groups = new Map<string, { nickname: string; avatar: string; isMe: boolean; lines: typeof card.items }>()
    for (const item of card.items) {
      const group = groups.get(item.userId) ?? {
        nickname: item.nickname,
        avatar: item.avatar,
        isMe: item.isMe,
        lines: [],
      }
      group.lines.push(item)
      groups.set(item.userId, group)
    }
    // 我排在最前（"我点了什么"是这一页最常被看的），其余按名字稳定排序
    return [...groups.values()].sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.nickname.localeCompare(b.nickname))
  }, [card])

  const advance = (target: MealCard, status: OrderStatus) => {
    if (status === 'PLANNED') {
      setConfirmFor(target)
      return
    }
    updateStatus.mutate(
      { mealKey: target.mealKey, status },
      {
        onSuccess: (updated) => toast.success(`这餐：${STATUS_LABEL[updated.status]}`),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const onAction = (target: MealCard, action: { status: OrderStatus; label: string; needsConfirm: boolean }) => {
    if (action.needsConfirm) setPending({ kind: 'status', card: target, status: action.status, label: action.label })
    else advance(target, action.status)
  }

  const closeDialog = () => setPending(null)

  const confirmAction = () => {
    const action = pending
    if (!action) return
    closeDialog()

    if (action.kind === 'status') {
      updateStatus.mutate(
        { mealKey: action.card.mealKey, status: action.status },
        {
          onSuccess: (updated) => toast.success(`这餐：${STATUS_LABEL[updated.status]}`),
          onError: (error) => toast.error(apiErrorMessage(error)),
        },
      )
      return
    }

    removeItem.mutate(action.itemId, {
      onSuccess: () => {
        toast.success('已退掉这道菜')
        // 撤最后一份会让这一餐变成空卡（后端回 dishCount=0）：那一餐就不存在了，
        // 留在详情页会看到一张空壳——退回列表，那里也没有它了
        void meal.refetch()
      },
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  const dialog =
    pending === null
      ? { title: '', message: '', confirmText: '确定', tone: 'normal' as const }
      : pending.kind === 'status'
        ? {
            title: pending.label,
            message:
              pending.status === 'CANCELED'
                ? '取消后这一餐就作废了。之后想再点，重新点这道菜就行，这一餐会回到「待确认」。'
                : pending.status === 'DONE'
                  ? '标成「做好了」之后就定了：这一餐不能再加菜，也不能取消了（要留着当记录）。'
                  : `把这餐标成「${STATUS_LABEL[pending.status]}」？家里人都能看到这个状态。`,
            confirmText: pending.label,
            tone: pending.status === 'CANCELED' ? ('danger' as const) : ('normal' as const),
          }
        : {
            title: '退掉这道菜',
            /*
             * 退**别人的**那一份时把名字写出来：现在家里谁都退得掉任何一份
             * （2026-10-15 定的口径），而"我退的不是自己的菜"这件事必须在按下去之前看到。
             */
            message: pending.byWhom
              ? `把${pending.byWhom}点的「${pending.dishName}」退掉？退掉后要重新加一次。`
              : `把「${pending.dishName}」从这餐里退掉？退掉后要重新加一次。`,
            confirmText: '退掉',
            tone: 'normal' as const,
          }

  return (
    <Page>
      <div className="pscreen order-detail">
        <Link className="page-back" to={back.to}>
          ← {back.label}
        </Link>

        <PageHeader title="这一餐" subtitle="谁点的、谁定的、谁做的，都在这儿" art="order" />

        {meal.isPending && (
          <div className="order-status">
            <RecipeStatus title="正在翻这一餐…" loading />
          </div>
        )}

        {meal.isError && (
          <div className="order-status">
            <RecipeStatus
              title="这一餐打不开"
              onRetry={() => {
                void meal.refetch()
              }}
            >
              {apiErrorMessage(meal.error)}
            </RecipeStatus>
          </div>
        )}

        {card && (
          <>
            {/* ① 这一餐是什么、走到哪一步 */}
            <section className="od-hero">
              <div className="od-hero__top">
                <div>
                  <div className="od-hero__date">
                    {card.date} · {card.mealLabel}
                  </div>
                  <div className="od-hero__day">{dayLabel(card.date)}的{card.mealLabel}</div>
                </div>
                <span className={['stamp', STATUS_TONE[card.status]].filter(Boolean).join(' ')}>
                  {card.statusLabel}
                </span>
              </div>
              <p className="od-hero__summary">
                共 {card.dishCount} 道 · {card.ordererCount} 人点了
                {card.mineCount > 0 && `（含我点的 ${card.mineCount} 份）`}
                {card.dinerCount ? ` · ${card.dinerCount} 人吃` : ''}
              </p>
              <p className="od-hero__submitted">{formatClock(card.submittedAt)} 开始点这一餐</p>

              {/* 谁定的菜单 / 谁做的（M4 的确认留痕 + M10 的「谁标的好做了」）：
                  两件事可能是两个人，所以分两行说，而不是合成一句"妈妈定的" */}
              {card.confirmedBy && card.confirmedAt && (
                <p className="od-hero__stamp">
                  🔒 {card.confirmedBy.nickname} {formatClock(card.confirmedAt)} 定下这餐
                </p>
              )}
              {card.doneBy && card.doneAt && (
                <p className="od-hero__stamp od-hero__stamp--done">
                  🍲 {card.doneBy.nickname} {formatClock(card.doneAt)} 标了「做好了」
                </p>
              )}

              {/*
                就餐人数（M4 / F4-05）+「再点一次」（F3-06）：与列表页同属"顺手能做的小事"，
                排成一样的一行小药丸（用户 2026-10-14：「这三行按钮优化下」）。

                「再点一次」在详情页给的是**同一个动作的两个入口之一**（另一个在列表卡上）：
                从列表点进某一餐的人，常常正是想"就照这桌再来一顿"，让他退出去再找那张卡
                没有道理。判据仍然是后端的 `canRepeat`，前端不自己推。
              */}
              <div className="order-card__tools">
                {/*
                  「再加一道」（用户 2026-10-15：「今天点了餐就不能修改了，也不能继续点，都要优化」）。
                  判据用后端的 `canAdd`（到「正在做」为止都能加，只有"做好了"封口）——
                  与备菜计划那一行的「加菜」**同一条路**：跳到菜谱小书并带上这一餐当目标，
                  挑完菜「点这道」就落进这一餐（见 plan-target），不在这一页另做一套点菜抽屉。
                */}
                {card.canAdd && (
                  <Link
                    className="order-card__add"
                    to="/recipes"
                    state={{ from: location.pathname, plan: { date: card.date, meal: card.meal, label: `这一餐（${card.date.slice(5)} ${card.mealLabel}）` } }}
                  >
                    ＋ 再加一道
                  </Link>
                )}
                <button
                  type="button"
                  className="order-card__diners"
                  disabled={!can(family.data, CAPABILITY.MENU_MANAGE)}
                  onClick={() => setDinersFor(card)}
                >
                  🍚 {card.dinerCount ? `${card.dinerCount} 人吃` : '还没定几个人吃'}
                  {can(family.data, CAPABILITY.MENU_MANAGE) && ' · 改'}
                </button>
                {card.canRepeat && card.dishCount > 0 && (
                  <button type="button" className="order-card__repeat" onClick={() => setRepeatFor(card)}>
                    🔁 再点一次
                  </button>
                )}
              </div>
            </section>

            {/* ② 谁点了什么——逐份，不合并 */}
            <section className="od-block">
              <h2 className="od-block__title">谁点了什么</h2>
              {byPerson.map((person) => (
                <div className="od-person" key={person.nickname}>
                  <div className="od-person__head">
                    <span className="od-person__avatar">{person.avatar}</span>
                    <span className="od-person__name">
                      {person.nickname}
                      {person.isMe && <b className="od-person__me">我</b>}
                    </span>
                    <span className="od-person__count">{person.lines.length} 份</span>
                  </div>
                  {person.lines.map((line) => (
                    <div className="od-line" key={line.id}>
                      {line.image && <img className="od-line__img" src={line.image} alt="" loading="lazy" />}
                      <div className="od-line__main">
                      {line.recipeId ? (
                        <Link
                          className="od-line__name od-line__name--link"
                          to={`/recipes/${line.recipeId}`}
                          state={{ from: location.pathname }}
                        >
                          {/*
                            箭头放**最右边**（用户 2026-10-14：「详情菜品的箭头放到右侧」）。
                            原先它紧跟菜名（`名字 ›`），而右边隔着一大段空白——箭头在中文里
                            就是"这一行能进去"的记号，它该贴在**可点区域的右端**，与列表页
                            那排卡片、以及各处"能进去"的行同一个位置。名字本身占满剩余宽度
                            （`flex: 1`），点哪儿都能进。
                          */}
                          <span className="od-line__name-text">{line.name}</span>
                          <span className="od-line__name-arrow" aria-hidden="true">
                            ›
                          </span>
                        </Link>
                      ) : (
                          <span className="od-line__name">
                            {line.name}
                            <i className="od-line__free">自己写的</i>
                          </span>
                        )}
                        {line.note && <div className="od-line__note">备注：{line.note}</div>}
                        <div className="od-line__at">{formatClock(line.createdAt)}</div>
                      </div>
                      {/*
                        退掉一份（用户 2026-10-15：「…批量操作…退菜这种的」）。
                        两条口径都在那次放开了（后端 `canRemoveItem` 同样会校验）：
                        **家里谁都退得掉任何一份**（不再限于自己点的），
                        **到「正在做」为止都能退**（只有「做好了」封口）。

                        别人的那一份也标出"是谁的"：这一列本来就是按人分组的（上面写着昵称），
                        但确认弹窗里必须再说一次——退别人的菜是个大动作，弹窗要把话说全。
                      */}
                      {card.status !== 'DONE' && (
                        <button
                          type="button"
                          className="order-card__withdraw"
                          onClick={() =>
                            setPending({
                              kind: 'withdraw',
                              card,
                              dishName: line.name,
                              itemId: line.id,
                              byWhom: person.isMe ? null : person.nickname,
                            })
                          }
                        >
                          {line.isMe ? '退掉' : '退掉这份'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </section>

            {/* ③ 这一餐的总览 + 成品照 + 动作 */}
            <section className="od-block">
              <h2 className="od-block__title">这一餐</h2>
              <p className="od-block__plain">合计 {card.dishCount} 道菜，{card.ordererCount} 个人点了。</p>

              {card.status === 'DONE' && (
                <div className="order-card__photos">
                  {card.photoCount > 0 && (
                    <Link className="order-card__photo-link" to="/checkins" state={{ from: location.pathname }}>
                      已传 {card.photoCount} 张成品照，去看看 →
                    </Link>
                  )}
                  <button type="button" className="order-card__photo" onClick={() => setUploadOpen(true)}>
                    📷 {card.photoCount > 0 ? '再传一张' : '上传这餐的成品照'}
                  </button>
                </div>
              )}

              {/* 「再点一次」（F3-06）在头部那一排里（与「改人数」并排），
                  这里不再重复一个——同一件事在同一个页面上给两个入口只会让人犹豫 */}

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
                      onClick={() => onAction(card, action)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}

              {/* 详情页特有的出路：回到列表。返回按钮也能回去，但那一个是"从哪来回哪去"，
                  而这里明确是"看别的餐"——两个意图，给两个入口（`replace` 不叠历史）。 */}
              <button
                type="button"
                className="od-back-list"
                onClick={() => navigate('/order', { replace: true })}
              >
                回到点菜单
              </button>
            </section>
          </>
        )}
      </div>

      {uploadOpen && card && (
        <CheckInUploadSheet visible presetMealKey={card.mealKey} onClose={() => setUploadOpen(false)} />
      )}

      {dinersFor && <DinerCountSheet card={dinersFor} onClose={() => setDinersFor(null)} />}

      {/*
        定这一餐的汇总视图（与列表页同一个抽屉）。
        「去定人数」要等它**真的收起来**再开人数抽屉：两个抽屉同时挂在屏幕上会叠成两层，
        底下那层还在播退场动画，看起来像卡住了（列表页为此踩过，这里沿用同一处理）。
      */}
      {confirmFor && (
        <ConfirmMenuSheet
          key={confirmFor.mealKey}
          card={confirmFor}
          onClose={() => {
            const card = confirmFor
            setConfirmFor(null)
            if (openDinersAfterClose) {
              setOpenDinersAfterClose(false)
              setDinersFor(card)
            }
          }}
          onAdjustDiners={() => setOpenDinersAfterClose(true)}
        />
      )}

      {repeatFor && (
        <RepeatMealSheet key={`repeat-${repeatFor.mealKey}`} card={repeatFor} onClose={() => setRepeatFor(null)} />
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
