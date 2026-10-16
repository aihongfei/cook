import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFamily, CAPABILITY, can } from '@/api/family'
import { useNotifications } from '@/api/notifications'
import { onTabRetap } from '@/lib/tab-retap'
import SwipePager from '@/components/ui/SwipePager'
import SwipeSegmented from '@/components/ui/SwipeSegmented'
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
import Icon from '@/components/icons/Icon'
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { STATUS_TONE } from '@/components/ui/status-tone'
import { toast } from '@/components/ui/toast'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { badgesOfMeal, firstPrepNotice, firstUnreadMealKey, unreadByMeal } from './unread-badges'
import '../shared.scss'
import './order.scss'

/**
 * 家庭点菜单（M3 / F3-01~F3-05，口径见 D-022；2026-10-16 那轮改版见 D-105）。
 *
 * 四点刻意的做法：
 * - **状态机不硬编码**：每张卡的按钮来自后端下发的 `nextActions`（按我的角色算好的），
 *   所以"吃货看不到管理按钮"不是前端藏出来的，改规则也不用发前端版本；
 * - **计数徽标由后端给**（`counts`），切换筛选时不会把其它状态的数字清成 0；
 * - **不可逆的动作先问一句**：取消整餐走 ConfirmDialog（砖红）。
 * - **卡片只表达"这一顿怎么样了"**（用户 2026-10-16：「订单页的卡片又显的很乱」）：
 *   信息收进**一条信息行**（统计 + 人数），动作收进**一行动作**（主操作 + 低频文字入口）。
 *
 * ---
 *
 * ## 2026-10-16 那轮（用户 2026-10-16 的原话与决定）
 *
 * 用户指着两张截图说「这两块我觉得有点重复了」「订单页的卡片又显的很乱，怎么优化下呢」，
 * 看过预览后逐条定下：
 *
 * 1. **列表永远只看今明后三天**（「这块永远就展示今明后三天的菜单，其余历史的都放入历史中」）。
 *    后端 `listWindowDays()` 收窗，并回一个 `beyondCount`——三天之外**真有**餐次时，
 *    列表底下给一句「还有 N 餐在三天之外 · 去备菜计划」。**为此备菜页每行必须点得进详情**
 *    （那一页排到第 7 天，列表收窗后那是它唯一的入口，见 PrepPage）。
 * 2. **不做多选了**（「不要多选了」）：长按多选与批量退菜整条去掉，那个位置让给「历史」。
 *    逐份退菜**能力一动没动**——它在详情页的「谁点了什么」里（按人分组，能看清退的是谁的），
 *    列表只负责"扫一眼 + 推进状态"。
 * 3. **「点单历史」从整行入口搬到筛选行右端**（用户：「历史放在右上角吧」→ 看过两版后定
 *    「把历史按钮放在筛选右侧吧」）：就是原来那枚「多选」圆钮的位置，插画与页头不动。
 * 4. **「自己写一道」改成悬浮胶囊**（用户：「自己写一道可以用悬浮的」）：压在 AI 球上方，
 *    全页常驻、不占列表高度。
 * 5. **卡片重新分层**：菜品区不再挂按钮；「共 N 道 · M 人点了 · 含我 X 份」与就餐人数
 *    并成一条信息行；「存成常用组合」「再点一次」降为无边框文字，与主操作同一行。
 *    日期也改说人话（`2026-10-16` → `今天`）——「今天·午餐」比一串数字更快读。
 */

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: '待确认',
  PLANNED: '已安排',
  COOKING: '准备中',
  DONE: '已做好',
  CANCELED: '已取消',
}

/** 待确认的动作：整餐流转 / 退掉一份菜 */
type PendingAction =
  | { kind: 'status'; card: MealCard; status: OrderStatus; label: string }
  | { kind: 'withdraw'; card: MealCard; dishName: string; itemId: string }
  | null

/**
 * 预填组合名用，也是**卡片日期**的说法（今天/明天/后天，再远的用月-日）。
 *
 * 日期说人话这件事在别处也各写了一遍（详情页的 `dayLabel`、后端的 `dayLabel`）——
 * 这里是列表卡，只关心"这一顿在近三天里的哪一天"。
 */
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

/** 提交时间：卡片信息行里只说"几点几分"，日期已经由卡片标题承担了 */
function formatSubmittedAt(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())} 提交`
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

  /*
   * 没加入家庭就别请求点单接口（后端会 404）：等 family 查询回来再决定。
   *
   * **状态筛选改成在前端筛**（用户 2026-10-15 要求"左右滑动切换筛选，滑到中间两页都能看见"）：
   * 跟手拖到一半时，邻页那一组卡也得当场画得出来——按状态分别请求的话，那半页会是一段
   * "正在取…"，翻起来像卡住。后端本来就一次性把每个状态的数量算在 `counts` 里
   * （它也是**全量**取回来再算的），所以这里不再带 `status`，切换筛选是零请求、瞬时的。
   */
  const orders = useOrders(scope, 'ALL', { enabled: Boolean(family.data) })
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
   * 为什么需要它：提醒经常落在用户一眼看不到的那几张卡上，他会以为角标没做出来。
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
   * 滚过去。找不到就**安静收场**（那一餐可能已被撤掉、或翻到三天之外了）——
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
      onSuccess: () => toast.success('已退掉这道菜'),
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
                  ? // 「做好了」是**终态**：这一餐之后再也不能加菜、不能取消。所以这里要说清"回不去了"，
                    // 而不是那句泛泛的"家里人都能看到这个状态"。
                    '标成「做好了」之后就定了：这一餐不能再加菜，也不能取消了（要留着当记录）。'
                  : `把这餐标成「${STATUS_LABEL[pending.status]}」？家里人都能看到这个状态。`,
            confirmText: pending.label,
            tone: pending.status === 'CANCELED' ? ('danger' as const) : ('normal' as const),
          }
        : {
            title: '退掉这道菜',
            message: `把「${pending.dishName}」从这餐里退掉？退掉后要重新加一次。`,
            confirmText: '退掉',
            tone: 'normal' as const,
          }

  /*
   * 页头 / 段控 / 筛选行都交给 `fixed`（D-091，用户 2026-10-16
   * 「滑动时只滑动主题内容，tab 和操作区域不能动」）：它们是**页面级**的东西——
   * 滚到第 6 张卡时想换个状态、或进「点单历史」，不该先滚回顶上。
   *
   * 段控（全家点菜单 / 只看我的）也在这一块里，因为它**自己也要能滑**
   * （用户 2026-10-16 在"订单手势"那题上选的一边就是「段控也能滑」）：
   * 手势认的是"划在谁身上"，它若落在下面那个 `SwipePager` 里，同一次划动会被两边抢。
   *
   * 「历史」占的是**筛选行最右**（用户 2026-10-16 定）：与 chips 同一行但不在滚动区里
   * ——chips 那截自己横着滚，它与页面右栏距对齐（见 `.order-filter` / `.order-history` 的
   * 样式注释）。它替代的是原来那枚「多选」圆钮，而多选整条已经不做了。
   */
  const chrome = (
    <div className="pscreen">
      <PageHeader title="家宴点菜单" subtitle="记录大家想吃什么，也记录每顿饭的回应" art="order" />

      <SwipeSegmented
        label="看谁的点单"
        items={[
          { key: 'family', title: '全家点菜单' },
          { key: 'mine', title: '只看我的' },
        ]}
        activeKey={scope}
        onChange={(key) => setScope(key as 'family' | 'mine')}
      />

      {family.data && orders.data && (
        <div className="order-filter">
          <Chips items={chips} value={filter} onChange={setFilter} />
          {/* 点单历史（F3-09）：列表只看得到今明后三天，更早的点单在这一页往前翻。
              做成这一行最右的小胶囊而不是整行入口——它是"偶尔回看"，不是每天要用的那一屏。 */}
          <Link
            className="order-history"
            to="/order/history"
            state={{ from: location.pathname }}
          >
            <span className="order-history__icon" aria-hidden="true">
              <Icon name="book" size={15} />
            </span>
            历史
          </Link>
        </div>
      )}
    </div>
  )

  return (
    /*
     * 「页头不动、只滚主体」+ 卡片整屏左右滑（D-091，用户 2026-10-16）。
     * `fixed` 那一块见上面 `chrome`；这里只剩**这一页的内容**。
     */
    <Page fixed={chrome}>
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

      {/*
        「该备菜」那条在列表顶上单独说一句（用户 2026-10-14：「还是没有通知的角标啊」）。
        它**没有卡可标**——说的正是"某一餐还空着"，空着才没有点单卡；但它的红点恰恰
        亮在订单这一支，所以列表里一处标记都没有时用户会觉得"通知没做出来"。
        那条提醒本来"点进去是备菜页"（`to` 由后端给），在这里也给同一个去处。
      */}
      {prepNotice && (
        <Link className="order-notice" to={prepNotice.to} state={{ from: location.pathname }}>
          <span className="order-notice__icon"><Icon name="greens" size={18} /></span>
          <span className="order-notice__text">
            {prepNotice.title}
            {prepNotice.body && <small>{prepNotice.body}</small>}
          </span>
          <span className="order-notice__arrow"><Icon name="chevron-right" size={14} /></span>
        </Link>
      )}

      {/*
        卡片列表这一块**能左右跟手翻页**（用户 2026-10-15：「类似这种 tab 页（全部、已安排、
        已做好）……需要能左右滑动切换」，随后又要求「要跟随手指拖动，滑到中间时，两个页是都能看见的」），
        现在是**整屏**（`fill`）。
        筛选胶囊那一行自己会横滚、带着 `data-no-swipe`，在它上面划动一律不接
        （那是"看后面的选项"，不是换筛选）——它现在在固定区，标记仍然生效（手势认的是划在谁身上）。
        一页就是"某个状态下的那几张卡"：数据是同一份（`counts`/卡片一次性取回），
        所以邻页当场就画得出来，不会有"翻到一半是空的"。

        空态**每一页各画自己那一份**（原来是画在翻页区外面、按当前筛选写死）：
        跟手拖到一半时，邻页也得说出它自己"有没有东西"——共用一句会在那一刻说错话。
      */}
      {family.data && orders.data && (
        <SwipePager
          keys={chips.map((chip) => chip.id)}
          activeKey={filter}
          onChange={setFilter}
          fill
          renderPanel={(status) => {
            const all = orders.data?.cards ?? []
            const cards = status === 'ALL' ? all : all.filter((card) => card.status === status)
            if (cards.length === 0) {
              return (
                <div className="order-panel__empty">
                  <EmptyState
                    title={status === 'ALL' ? '这三天还没有人点菜' : '这个状态下没有点单'}
                    desc={
                      status === 'ALL'
                        ? '翻到想吃的菜，点「想吃这道」，家里人就能看到；也可以自己写一道。'
                        : '换个状态看看。'
                    }
                  />
                </div>
              )
            }
            return cards.map((card) => {
              const cardBadges = badgesOfMeal(badges, card.mealKey)
              const canManageDiners = can(family.data, CAPABILITY.MENU_MANAGE)
              return (
                /*
                 * 整张卡可点，进**这一餐的详情**（用户 2026-10-15：「订单里卡片增加下详情吧，
                 * 可以点击进去看详细的」）。
                 *
                 * 卡片**不是** `<button>`：里面还有一堆真按钮（改人数、存组合、流转…），
                 * 按钮套按钮是无效 HTML、点内层还会连带触发外层。所以外层只挂一个点击处理，
                 * 遇到内层可交互元素就**放行不跳**（`closest` 一次判定，不必给每个内层按钮
                 * 各加一句 stopPropagation——那种写法每加一个按钮就漏一个）。
                 *
                 * 同时把标题区做成真 `<Link>`：整卡 onClick 只对鼠标/触摸成立，
                 * 键盘与读屏需要那个链接才进得去（与打卡卡片可点那次同一条理由）。
                 */
                <article
                  className={['order-card', 'order-card--link', cardBadges.length > 0 && 'is-unread']
                    .filter(Boolean)
                    .join(' ')}
                  key={card.mealKey}
                  // 再点一次「订单」Tab 时靠它找这张卡（见上面那段 jumpTo 的说明）
                  data-meal-key={card.mealKey}
                  onClick={(event) => {
                    const target = event.target as HTMLElement
                    if (target.closest('button, a, input, select, textarea')) return
                    navigate(`/order/${card.mealKey}`, { state: { from: location.pathname } })
                  }}
                >
                  {/*
                    右上角的"有新消息"角标（用户 2026-10-14：「卡片没有看到哪条是通知的啊，
                    考虑加下角标之类的」）。

                    三个决定：
                    - **用角标，不用卡片里的一行小标**：角标挂右上角、压着卡片描边，扫一列卡片
                      时一眼就能挑出哪张不一样；
                    - **文案是后端那条的 `tag`**（"选好了""做好了"），不在这里另写一张表，
                      否则后端加了新类别而前端不知道（与"去处由后端给"同一条规矩）；
                    - **一餐最多两条，并排写在一颗角标里**（`A · B`），不叠两颗。
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
                        {labelOfDay(card.date)} · {card.mealLabel}
                      </span>
                      <span className="order-card__who">
                        {card.orderers.join(' · ')} 点的 · {formatSubmittedAt(card.submittedAt)}
                      </span>
                    </Link>
                    <span className={['stamp', STATUS_TONE[card.status]].filter(Boolean).join(' ')}>
                      {card.statusLabel}
                    </span>
                    <span className="order-card__arrow" aria-hidden="true">
                      <Icon name="chevron-right" size={15} />
                    </span>
                  </div>

                  {/*
                    菜品区**只念菜**（用户 2026-10-16：卡片太乱）。
                    原来每道菜行尾挂着一颗「退掉我这份」药丸，两道菜就是右侧一列药丸——
                    而那张卡上还有一整排工具与流转按钮。现在逐份退菜收进**详情页**的
                    「谁点了什么」（那里按人分组，能看清退的是谁的哪一份，弹窗会点名），
                    列表回到"扫一眼就知道这一顿有什么"。
                  */}
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
                      </div>
                    ))}
                  </div>

                  {/*
                    信息行：**一处把这一顿说全**（用户 2026-10-16：原来统计、人数、提交时间
                    散在四处，每处都在说同一档事）。
                    左边是"几道菜、几个人点了、我点了几份"，右边是"几个人吃"。
                    人数右边那个「· 改」是**改人数这件事自己**（`menu.manage`）的入口，
                    不是"有没有下一步按钮"——任何"用 A 现象当 B 能力代理"的判据都会在权限
                    调整时裂开（这条在 D-075 那轮踩过：吃货看到一个点下去就 403 的「· 改」）。
                  */}
                  <div className="order-card__info">
                    <span>
                      共 {card.dishCount} 道 · {card.ordererCount} 人点了
                      {card.mineCount > 0 && ` · 含我 ${card.mineCount} 份`}
                    </span>
                    <span className="order-card__diners-line">
                      <button
                        type="button"
                        className="order-card__diners"
                        disabled={!canManageDiners}
                        onClick={() => setDinersFor(card)}
                      >
                        {<Icon name="rice" size={14} />} {card.dinerCount ? `${card.dinerCount} 人吃` : '还没定几个人吃'}
                        {canManageDiners && ' · 改'}
                      </button>
                    </span>
                  </div>

                  {/* 确认留痕（M4 / F4-05）：谁把这一版菜单定下来的。**纯信息，不是可点元素** */}
                  {card.confirmedBy && card.confirmedAt && (
                    <p className="order-card__confirmed">
                      {<Icon name="lock" size={13} />} {card.confirmedBy.nickname} {formatConfirmedAt(card.confirmedAt)} 定下这餐
                    </p>
                  )}

                  {/*
                    「已做好」的那一餐：成品照在这里给（F9-08）——照片是"做出来了"的证据。
                    已传过的显示张数，并给一个"去看看"的入口（照片都在打卡墙那一餐下）。
                  */}
                  {card.status === 'DONE' && card.photoCount > 0 && (
                    <p className="order-card__photo-line">
                      <Link className="order-card__photo-link" to="/checkins" state={{ from: '/order' }}>
                        已传 {card.photoCount} 张成品照，去看看<Icon name="arrow-right" size={13} className="icon--trail" />
                      </Link>
                    </p>
                  )}

                  {/*
                    **一行动作**（用户 2026-10-16：三层控件太乱）。
                    左边是"顺手能做的小事"——**无边框文字**（它们本来就是低频动作，
                    做成药丸就会跟右边的主操作抢注意力）；右边是这一餐的流转按钮（实心药丸）。
                  */}
                  <div className="order-card__actions">
                    <div className="order-card__quick">
                      {/* 存成常用组合（M4 / F4-04）：刚把这一餐配齐时"下次也照这样点"的念头最强 */}
                      {card.dishes.some((line) => line.recipeId) && (
                        <button
                          type="button"
                          className="order-card__quick-btn order-card__quick-btn--brand"
                          onClick={() => setComboFor(card)}
                        >
                          {<Icon name="star" size={14} />} 存组合
                        </button>
                      )}

                      {/* 再点一次（F3-06）：只出现在**定局的那一餐**（判据在后端 `canRepeat`） */}
                      {card.canRepeat && card.dishCount > 0 && (
                        <button
                          type="button"
                          className="order-card__quick-btn order-card__quick-btn--brand"
                          onClick={() => setRepeatFor(card)}
                        >
                          {<Icon name="refresh" size={14} />} 再点一次
                        </button>
                      )}

                      {/* 成品照（F9-08）：只有做好的那一餐才给这个入口 */}
                      {card.status === 'DONE' && (
                        <button
                          type="button"
                          className="order-card__quick-btn"
                          onClick={() => setUploadMealKey(card.mealKey)}
                        >
                          {<Icon name="camera" size={14} />} {card.photoCount > 0 ? '再传一张' : '传成品照'}
                        </button>
                      )}
                    </div>

                    <div className="order-card__main">
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
                  </div>
                </article>
              )
            })
          }}
        />
      )}

      {/*
        三天之外还有安排时的那一句（用户 2026-10-16：「永远就展示今明后三天」）。
        **真有才说**：`beyondCount` 是后端数出来的（第 4～7 天的餐次），为 0 时一句都不提，
        免得给用户一个空入口。去处是备菜计划——那一页排到第 7 天，是收窗后那些餐唯一的家。
      */}
      {family.data && orders.data && orders.data.beyondCount > 0 && (
        <p className="order-window-hint">
          还有 {orders.data.beyondCount} 餐在三天之外 ·{' '}
          <Link to="/prep" state={{ from: location.pathname }}>
            去备菜计划<Icon name="arrow-right" size={13} className="icon--trail" />
          </Link>
        </p>
      )}

      {/*
        列表底部留白：悬浮的「自己写一道」（40.8）+ 间距（12）+ AI 球（54）+ 呼吸（14）
        ≈ 120px。不留够的话滚到底时最后一张卡的动作行正好压在悬浮件下面
        （预览里实测盖住了「选好了 / 取消这餐」）。
      */}
      {family.data && <div className="order-float-tail" aria-hidden="true" />}

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

      {/* 再点一次（F3-06）：key 用来源那一餐——换了来源必须拿到干净的一份 */}
      {repeatFor && (
        <RepeatMealSheet key={`repeat-${repeatFor.mealKey}`} card={repeatFor} onClose={() => setRepeatFor(null)} />
      )}

      {/* key 每次打开都变：重挂载拿回干净的一份（抽屉不用 effect 清状态，见 FreeDishSheet） */}
      {freeDishOpen && (
        <FreeDishSheet key={`free-${freeDishSeq}`} visible onClose={() => setFreeDishOpen(false)} />
      )}

      {/*
        「自己写一道」（F3-10）改成**悬浮胶囊**（用户 2026-10-16：「自己写一道可以用悬浮的」）：
        它压在 AI 球正上方，全页常驻——不占列表高度，也不会被滚走
        （原来它是固定区里的一整行入口，三件事里它最重）。
        菜谱库里没有的菜（家里自己常做的、今天就想吃的）也能点。

        只在有家庭时出现：点菜是家庭内的协作（与空态、接口的可见性同一条口径）。
      */}
      {family.data && (
        <button type="button" className="order-write" onClick={openFreeDish}>
          <span className="order-write__icon" aria-hidden="true">
            <Icon name="pencil" size={15} />
          </span>
          自己写一道
        </button>
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
