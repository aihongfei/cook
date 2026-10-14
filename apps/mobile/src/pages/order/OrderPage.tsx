import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFamily, CAPABILITY, can } from '@/api/family'
import { useNotifications } from '@/api/notifications'
import { onTabRetap } from '@/lib/tab-retap'
import CheckInUploadSheet from '@/pages/checkins/components/CheckInUploadSheet'
import ConfirmMenuSheet from './components/ConfirmMenuSheet'
import DinerCountSheet from './components/DinerCountSheet'
import RepeatMealSheet from './components/RepeatMealSheet'
import SaveComboSheet from './components/SaveComboSheet'
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
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { STATUS_TONE } from '@/components/ui/status-tone'
import { toast } from '@/components/ui/toast'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { badgesOfMeal, firstPrepNotice, firstUnreadMealKey, unreadByMeal } from './unread-badges'
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
 *
 * 2026-10-14 补：**卡片上标出"这张卡有事没看过"**（用户报「订单有红点，但是里面的卡片
 * 看不出来哪个是提醒的」）。红点只说明"订单这边有事"，进了列表还得让人一眼找到是哪一餐。
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

/** 预填组合名用：把日期说成人话（今天/明天/后天，再远的用月-日） */
function labelOfDay(date: string): string {
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

function formatSubmittedAt(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)} / ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} 提交`
}

/** 确认留痕显示用（M4 / F4-05）：到分钟就够，"谁几点定下的"不需要秒 */
function formatConfirmedAt(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)} / ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function OrderPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const family = useFamily()
  const [scope, setScope] = useState<'family' | 'mine'>('family')
  const [filter, setFilter] = useState<string>('ALL')
  const [pending, setPending] = useState<PendingAction>(null)
  const [uploadMealKey, setUploadMealKey] = useState<string | null>(null)
  // 正在定这一餐（M4 / F4-05）：null = 抽屉关着
  const [confirmFor, setConfirmFor] = useState<MealCard | null>(null)
  // 确认抽屉里点了「去定人数」：等它真的收起来再开人数抽屉（两个不叠着开）
  const [openDinersAfterClose, setOpenDinersAfterClose] = useState(false)
  // 正在定人数的餐（M4 / F4-05）：null = 抽屉关着
  const [dinersFor, setDinersFor] = useState<MealCard | null>(null)
  // 「自己写一道」（F3-10）：每次打开 +1 用来给抽屉换 key（抽屉不在 effect 里清状态，靠重挂载拿回干净的一份）
  const [freeDishOpen, setFreeDishOpen] = useState(false)
  const [freeDishSeq, setFreeDishSeq] = useState(0)
  // 正在「存成常用组合」的那一餐（M4 / F4-04）：null = 抽屉关着
  const [comboFor, setComboFor] = useState<MealCard | null>(null)
  // 正在「再点一次」的那一餐（F3-06）：null = 抽屉关着
  const [repeatFor, setRepeatFor] = useState<MealCard | null>(null)
  const openFreeDish = () => {
    setFreeDishSeq((value) => value + 1)
    setFreeDishOpen(true)
  }

  // 没加入家庭就别请求点单接口（后端会 404）：等 family 查询回来再决定
  const orders = useOrders(scope, filter, { enabled: Boolean(family.data) })
  const updateStatus = useUpdateMealStatus()
  const removeItem = useRemoveOrderItem()

  /*
   * 卡片上那个"有事没看过"的标记（用户 2026-10-14 要求）。
   *
   * 用的是**和底栏红点同一份数据**（`useNotifications` 同一个 queryKey，不会多打一次接口）：
   * 两处各算一遍就会出现"红点说有事、卡片上却找不到"（计数写两处迟早分叉，见 D-059 三）。
   */
  const notifications = useNotifications()
  const badges = unreadByMeal(notifications.data?.items ?? [])
  // 「该备菜」那条没有卡可标（那一餐还空着），所以在列表顶上单独说一句
  const prepNotice = firstPrepNotice(notifications.data?.items ?? [])

  /*
   * 再点一次底栏的「订单」：滚到那条提醒对应的卡（用户 2026-10-14：「再加一下重复
   * 点击订单tab时自动滚到通知的那个卡片位置」）。
   *
   * 为什么需要它：列表按日子**倒序**，而"今天"恰恰在最下——提醒经常落在用户一眼
   * 看不到的那几张卡上（验收时那条就在 14 张卡的第 14 张），他会以为角标没做出来。
   *
   * 两段分工：**动状态的都在点击那一刻做**（弹开挡住它的筛选、把"要看哪一餐"记下来），
   * 下面那个 effect 只做"滚"这一件 DOM 事，不改任何 state——effect 里改 state 会引发
   * 连锁重渲染（lint 会为这一点报警），而这里本来就有一个真实的点击作为起因，
   * 没有理由把决定推迟到渲染之后。
   *
   * `seq` 是为了"连点两次仍要滚"：同一餐第二次点，`key` 没变、state 不变，
   * effect 就不会再跑——加一个自增序号让它每次都变。
   */
  const [jump, setJump] = useState<{ key: string; seq: number } | null>(null)
  useEffect(
    () =>
      onTabRetap('/order', () => {
        const target = firstUnreadMealKey(notifications.data?.items ?? [])
        if (!target) return
        setJump((prev) => ({ key: target, seq: (prev?.seq ?? 0) + 1 }))
        /*
         * 卡被筛掉了就先放开筛选（用户要的是"带我去看那条提醒"，让他自己发现是被
         * 「只看我的 / 待确认」挡住了没有道理）。放开之后数据会重取，下面那个 effect
         * 跟着 `orders.data` 再跑一次，那时卡就在了。
         */
        if (!document.querySelector(`[data-meal-key="${target}"]`)) {
          setFilter('ALL')
          setScope('family')
        }
      }),
    [notifications.data],
  )

  /*
   * 滚过去。找不到就**安静收场**（那一餐可能已被撤掉、或翻到 60 张卡之外）——
   * 不假装找到、不弹提示：这是"顺手带你去"，不是一次可能失败的操作。
   */
  useEffect(() => {
    if (!jump) return
    // jsdom 里没有 scrollIntoView（真实浏览器有），测试用间谍函数替它
    document
      .querySelector(`[data-meal-key="${jump.key}"]`)
      ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [jump, orders.data])

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

  /**
   * 卡片上的动作按钮。**只有"定这一餐"这一步先开汇总抽屉**（M4 / F4-05，D-030）：
   * 它是唯一会让菜单上锁的动作，点下去之前该能看清整桌是什么；
   * `开始做`/`做好了` 仍直接生效——厨房里干活的人不该被多问一句。
   *
   * 判据用 `status === 'PLANNED'`（目标状态），不是按钮文案：文案是给人看的，
   * 后端改一个字不该让这里的行为跟着变（`nextActions` 里带着目标状态，本来就不用猜）。
   */
  const onAction = (card: MealCard, action: { status: OrderStatus; label: string; needsConfirm: boolean }) => {
    if (action.status === 'PLANNED') {
      setConfirmFor(card)
      return
    }
    // 影响别人的动作（取消整餐）先问一句；其余正常推进直接生效
    if (action.needsConfirm)
      setPending({ kind: 'status', card, status: action.status, label: action.label })
    else advance(card, action.status)
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
                : pending.status === 'DONE'
                  ? // 「做好了」是**终态**：这一餐之后再也不能加菜、不能取消（2026-10-15 全家都能点它了，
                    // 误触的代价因此变高——见 D-075 第三条）。所以这里要说清"回不去了"，
                    // 而不是那句泛泛的"家里人都能看到这个状态"。
                    '标成「做好了」之后就定了：这一餐不能再加菜，也不能取消了（要留着当记录）。'
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
        <PageHeader title="家宴点菜单" subtitle="记录大家想吃什么，也记录每顿饭的回应" art="order" />

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

        {/* 两个整行入口并排一行：都是"进另一个地方"的动作，各占半行。
            说明文字随之改短——半行宽度放不下原来那句长说明。 */}
        {family.data && (
          <div className="order-shortcuts">
            {/* 点单历史（F3-09）：列表只看得到最近 60 张卡（约一个月，见 R-19），
                更早的点单在这一页往前翻。做成一行入口而不是又一个 Tab：
                它是"偶尔回看"，不是每天要用的那一屏。 */}
            <Link className="order-history-link" to="/order/history" state={{ from: location.pathname }}>
              <span className="order-history-link__icon">📖</span>
              <span className="order-history-link__text">
                点单历史
                <small>翻翻最近吃过的</small>
              </span>
              <span className="order-history-link__arrow">›</span>
            </Link>

            {/* 自己写一道（F3-10）：菜谱库里没有的菜（家里自己常做的、今天就想吃的）也能点。
                放在筛选之下、卡片之上：它是"加点什么"的动作，与浏览已有单子不是一回事。 */}
            <button type="button" className="order-freedish" onClick={openFreeDish}>
              <span className="order-freedish__icon">✍️</span>
              <span className="order-freedish__text">
                自己写一道
                <small>写个名字就能点</small>
              </span>
              <span className="order-freedish__arrow">›</span>
            </button>
          </div>
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

        {/*
          「该备菜」那条在列表顶上单独说一句（用户 2026-10-14：「还是没有通知的角标啊」）。
          它**没有卡可标**——说的正是"某一餐还空着"，空着才没有点单卡；但它的红点恰恰
          亮在订单这一支，所以列表里一处标记都没有时用户会觉得"通知没做出来"。
          那条提醒本来"点进去是备菜页"（`to` 由后端给），在这里也给同一个去处。
        */}
        {prepNotice && (
          <Link className="order-notice" to={prepNotice.to} state={{ from: location.pathname }}>
            <span className="order-notice__icon">🥬</span>
            <span className="order-notice__text">
              {prepNotice.title}
              {prepNotice.body && <small>{prepNotice.body}</small>}
            </span>
            <span className="order-notice__arrow">›</span>
          </Link>
        )}

        {orders.data?.cards.map((card) => {
          const cardBadges = badgesOfMeal(badges, card.mealKey)
          return (
          /*
           * 整张卡可点，进**这一餐的详情**（用户 2026-10-15：「订单里卡片增加下详情吧，
           * 可以点击进去看详细的」）。
           *
           * 卡片**不是** `<button>`：里面还有一堆真按钮（撤回、改人数、存组合、流转…），
           * 按钮套按钮是无效 HTML、点内层还会连带触发外层。所以外层只挂一个点击处理，
           * 遇到内层可交互元素就**放行不跳**（`closest` 一次判定，不必给每个内层按钮
           * 各加一句 stopPropagation——那种写法每加一个按钮就漏一个）。
           *
           * 同时把标题区做成真 `<Link>`：整卡 onClick 只对鼠标/触摸成立，
           * 键盘与读屏需要那个链接才进得去（与打卡卡片可点那次同一条理由，见 CheckInPage）。
           */
          <article
            className={['order-card', 'order-card--link', cardBadges.length > 0 && 'is-unread']
              .filter(Boolean)
              .join(' ')}
            key={card.mealKey}
            // 再点一次「订单」Tab 时靠它找这张卡（见上面那段 jumpTo 的说明）
            data-meal-key={card.mealKey}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return
              navigate(`/order/${card.mealKey}`, { state: { from: location.pathname } })
            }}
          >
            {/*
              右上角的"有新消息"角标（用户 2026-10-14：「卡片没有看到哪条是通知的啊，
              考虑加下角标之类的」）。

              三个决定：
              - **用角标，不用卡片里的一行小标**：角标挂右上角、压着卡片描边，扫一列卡片
                时一眼就能挑出哪张不一样（第一版把标记放在标题行里，和状态戳挤在一起，
                用户根本没注意到——在他看来那张卡与别的没什么区别）；
              - **文案是后端那条的 `tag`**（"做好了""菜单"），不在这里另写一张表，
                否则后端加了新类别而前端不知道（与"去处由后端给"同一条规矩）；
              - **一餐最多两条，并排写在一颗角标里**（`A · B`），不叠两颗——
                右上角只有一个位置，叠起来会互相盖住。
            */}
            {cardBadges.length > 0 && (
              <span className="order-card__corner">{cardBadges.join(' · ')}</span>
            )}
            <div className="order-card__head">
              <Link
                className="order-card__headlink"
                to={`/order/${card.mealKey}`}
                state={{ from: location.pathname }}
              >
                <span className="order-card__date">
                  {card.date} · {card.mealLabel}
                </span>
                <span className="order-card__who">{card.orderers.join(' · ')} 点的</span>
              </Link>
              <span className={['stamp', STATUS_TONE[card.status]].filter(Boolean).join(' ')}>
                {card.statusLabel}
              </span>
              <span className="order-card__arrow" aria-hidden="true">
                ›
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

            {/* 确认留痕（M4 / F4-05）：谁把这一版菜单定下来的。**纯信息，不是可点元素**——
                它没有能做的事（要改状态走下面的动作按钮），做成按钮只会让人白点一次。 */}
            {card.confirmedBy && card.confirmedAt && (
              <p className="order-card__confirmed">
                🔒 {card.confirmedBy.nickname} {formatConfirmedAt(card.confirmedAt)} 定下这餐
              </p>
            )}

            {/*
              这一排是"顺手能做的小事"：就餐人数、存成常用组合、再点一次。
              （用户 2026-10-14：「这三行按钮优化下，现在不太好看，不一定一个按钮一行」——
              原先三个各自 `display:block; width:100%`，左对齐的一列文字，看着像清单条目
              而不是按钮。现在排成**一行小药丸**，放不下就自己折行。）

              三个按钮的判据各自独立，注释见各自下面那几段。

              就餐人数（M4 / F4-05）：含没点菜只吃饭的家人，所以和"N 人点了"分开显示。
              能到这一餐的人才看得到；没定就写"还没定"，别显示 0。

              ⚠️ 那个「· 改」的判据是**改人数这件事自己**（`menu.manage`），不是
              "有没有下一步按钮"。原来写的是 `card.nextActions.length > 0`，在 2026-10-15
              放开「做好了」给吃货（D-075）之后就成了**假入口**：吃货在一餐"准备中"时
              `nextActions` 有 DONE，于是看到一个「· 改」，点下去 403
              （后端 `setDiners` 要 MENU_MANAGE）——这正是本项目最不能接受的那种东西
              （看起来能点，点了没用还不知道为什么）。
              任何"用 A 现象当 B 能力代理"的判据都会在权限调整时这样裂开，所以这里
              回到**它自己那一项能力**：前端据此显示/隐藏，判定仍然只由后端下。
            */}
            <div className="order-card__tools">
              <button
                type="button"
                className="order-card__diners"
                disabled={!can(family.data, CAPABILITY.MENU_MANAGE)}
                onClick={() => setDinersFor(card)}
              >
                🍚{' '}
                {card.dinerCount
                  ? `${card.dinerCount} 人吃（${card.ordererCount} 人点了）`
                  : '还没定几个人吃'}
                {can(family.data, CAPABILITY.MENU_MANAGE) && ' · 改'}
              </button>

              {/* 存成常用组合（M4 / F4-04）：刚把这一餐配齐时"下次也照这样点"的念头最强，
                  顺手存下来成本最低（组合页只管用与删，不从那里新建）。 */}
              {card.dishes.some((line) => line.recipeId) && (
                <button type="button" className="order-card__combo" onClick={() => setComboFor(card)}>
                  ⭐ 存成常用组合
                </button>
              )}

              {/* 再点一次（F3-06）：只出现在**定局的那一餐**（做好了 / 已取消 / 日子过去了，
                  判据在后端 `canRepeat`）。跟它并排的「存成常用组合」是另一件事：
                  那个是"想常做"，这个是"就照这桌再来一顿"。 */}
              {card.canRepeat && card.dishCount > 0 && (
                <button type="button" className="order-card__repeat" onClick={() => setRepeatFor(card)}>
                  🔁 再点一次
                </button>
              )}
            </div>

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
                    onClick={() => onAction(card, action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </article>
          )
        })}
      </div>

      {uploadMealKey && (
        <CheckInUploadSheet
          visible
          presetMealKey={uploadMealKey}
          onClose={() => setUploadMealKey(null)}
        />
      )}

      {dinersFor && <DinerCountSheet card={dinersFor} onClose={() => setDinersFor(null)} />}

      {/* 定这一餐的汇总视图（M4 / F4-05）。「去定人数」要等它**真的收起来**再开人数抽屉
          （见下面 onClose 里的 openDinersAfterClose）：两个抽屉同时挂在屏幕上会叠成两层，
          底下那层还在播退场动画，看起来像卡住了。 */}
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

      {comboFor && (
        <SaveComboSheet
          key={comboFor.mealKey}
          dishes={comboFor.dishes.map((line) => ({ recipeId: line.recipeId, name: line.name }))}
          defaultName={`${labelOfDay(comboFor.date)}${comboFor.mealLabel}`}
          onClose={() => setComboFor(null)}
        />
      )}

      {/* 再点一次（F3-06）：key 用来源那一餐——换了来源必须拿到干净的一份
          （抽屉里的"照到哪一餐"是本地选择，重挂载才不会被上一次的选择带过来） */}
      {repeatFor && (
        <RepeatMealSheet key={`repeat-${repeatFor.mealKey}`} card={repeatFor} onClose={() => setRepeatFor(null)} />
      )}

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
