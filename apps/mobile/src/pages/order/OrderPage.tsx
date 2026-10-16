import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useFamily, CAPABILITY, can } from '@/api/family'
import { useNotifications } from '@/api/notifications'
import { onTabRetap } from '@/lib/tab-retap'
import { SelectIcon } from '@/components/icons/TabIcons'
import SwipePager from '@/components/ui/SwipePager'
import SwipeSegmented from '@/components/ui/SwipeSegmented'
import { useLongPress } from '@/lib/long-press'
import CheckInUploadSheet from '@/pages/checkins/components/CheckInUploadSheet'
import ConfirmMenuSheet from './components/ConfirmMenuSheet'
import DinerCountSheet from './components/DinerCountSheet'
import RepeatMealSheet from './components/RepeatMealSheet'
import SaveComboSheet from './components/SaveComboSheet'
import FreeDishSheet from './components/FreeDishSheet'
import {
  useClearMealItems,
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

/** 待确认的动作：整餐流转 / 退掉一份 / **整桌退掉多张卡**（长按多选，用户 2026-10-15） */
type PendingAction =
  | { kind: 'status'; card: MealCard; status: OrderStatus; label: string }
  | { kind: 'withdraw'; card: MealCard; dishName: string; itemId: string }
  | { kind: 'clear'; meals: MealCard[] }
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
  /*
   * 长按多选（用户 2026-10-15：「订单里面的卡片要能删除，可以用那个按住显示单选框，
   * 然后底部或上部有批量操作的功能，退菜这种的」）。
   *
   * 两件事分开记：`selecting` 是"现在在选择模式里"，`picked` 是选了哪几餐。
   * 选择模式**不跨页存活**（离开这一页就退出）——它是"我现在要动手"的临时状态，
   * 被 keep-alive 留在缓存里的话，下次进来会看到一堆单选框而不知道为什么。
   */
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
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
  const clearMealItems = useClearMealItems()

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

  /*
   * ---- 长按多选（用户 2026-10-15）----
   *
   * 长按一张卡就进选择模式并选中它；此后**点卡片=勾选/取消**（不再跳详情）。
   * 长按之外还留了一个显式入口（选择条上的「多选」在……见下面那颗小小的「管理」按钮）：
   * 长按是**不可发现**的手势，只给长按的话，第一次用的人永远找不到这个功能
   * （本项目在"点不动的箭头""看不见的角标"上各栽过一次，见 D-066 / D-082）。
   */
  const exitSelect = () => {
    setSelecting(false)
    setPicked([])
  }

  const togglePick = (mealKey: string) => {
    setPicked((current) =>
      current.includes(mealKey) ? current.filter((key) => key !== mealKey) : [...current, mealKey],
    )
  }

  /** 进选择模式。带 `mealKey` 就是"长按这张卡"（顺手选中它）；不带就是点了「多选」 */
  const enterSelect = (mealKey?: string) => {
    setSelecting(true)
    if (!mealKey) return
    setPicked((current) => (current.includes(mealKey) ? current : [...current, mealKey]))
  }

  /** 选中的那几餐（按列表顺序） */
  const pickedMeals = (orders.data?.cards ?? []).filter((card) => picked.includes(card.mealKey))
  /*
   * 「做好了」的餐退不掉（后端 `canRemoveItem` 同样会拦）。这里**不禁用整个按钮**，
   * 而是把原因写在按钮下面——禁用+不说原因正是 D-066 定的"点不动的箭头"那一类。
   */
  const blockedMeals = pickedMeals.filter((card) => card.status === 'DONE')

  const askClear = () => {
    if (pickedMeals.length === 0 || blockedMeals.length > 0) return
    setPending({ kind: 'clear', meals: pickedMeals })
  }

  /*
   * **一个长按实例服务整个列表**，而不是每张卡各一个：同时只可能有一张卡被按住，
   * 而 hook 不能写在 `cards.map()` 里面（那是 hooks 的规则，不是风格问题）。
   * 按下的那一刻先记下"是哪一餐"，计时到了再拿它进选择模式。
   */
  const pressedKey = useRef<string | null>(null)
  const longPress = useLongPress(() => {
    if (pressedKey.current) enterSelect(pressedKey.current)
    pressedKey.current = null
  })

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

    if (action.kind === 'clear') {
      /*
       * **逐餐退，不是一次请求**：后端只有"退掉这一餐整桌"这一个接口（按 mealKey），
       * 多选就是多个请求。**部分成功要说清是哪几餐没成**：一次网络抖动不该让整批白做，
       * 也不该假装全成了（与冰箱拍照逐条入库同一条规矩）。
       */
      const meals = action.meals
      void Promise.all(
        meals.map(async (meal) => {
          try {
            await clearMealItems.mutateAsync(meal.mealKey)
            return { meal, ok: true as const }
          } catch (error) {
            return { meal, ok: false as const, message: apiErrorMessage(error) }
          }
        }),
      ).then((results) => {
        const done = results.filter((row) => row.ok)
        const failedRows = results.filter((row) => !row.ok)
        if (done.length > 0) toast.success(`退掉了 ${done.length} 餐的菜`)
        for (const row of failedRows) {
          toast.error(`${row.meal.date} ${row.meal.mealLabel}：${row.message}`)
        }
        // 全成 → 退出选择模式；有没成的 → 只把它们留在选中状态里，让用户接着处理
        if (failedRows.length === 0) exitSelect()
        else setPicked(failedRows.map((row) => row.meal.mealKey))
      })
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
                  ? // 「做好了」是**终态**：这一餐之后再也不能加菜、不能取消（2026-10-15 全家都能点它了，
                    // 误触的代价因此变高——见 D-075 第三条）。所以这里要说清"回不去了"，
                    // 而不是那句泛泛的"家里人都能看到这个状态"。
                    '标成「做好了」之后就定了：这一餐不能再加菜，也不能取消了（要留着当记录）。'
                  : `把这餐标成「${STATUS_LABEL[pending.status]}」？家里人都能看到这个状态。`,
            confirmText: pending.label,
            tone: pending.status === 'CANCELED' ? ('danger' as const) : ('normal' as const),
          }
        : pending.kind === 'withdraw'
          ? {
              title: '退掉这道菜',
              message: `把「${pending.dishName}」从这餐里退掉？退掉后要重新加一次。`,
              confirmText: '退掉',
              tone: 'normal' as const,
            }
          : {
              title: `退掉这 ${pending.meals.length} 餐的菜`,
              /*
               * 把"要退掉什么"说具体：整桌退是**一次去掉别人点的菜**（现在家里谁都退得掉，
               * 见 D-084），所以这句必须点明餐次、并说清卡片会跟着消失——那是不可逆的。
               */
              message:
                `会把 ${pending.meals.map((meal) => `${meal.date} ${meal.mealLabel}`).join('、')}` +
                ' 里的菜**全部**退掉（包括家里人点的那几份），清空的卡片会从列表里消失。' +
                '\n要重新吃就得重新点。只是少一道菜的话，进那一餐的详情退一道就好。',
              confirmText: '全退掉',
              tone: 'danger' as const,
            }

  /*
   * 页头 / 段控 / 筛选行 / 两个入口行都交给 `fixed`（D-091，用户 2026-10-16
   * 「滑动时只滑动主题内容，tab 和操作区域不能动」）：它们是**页面级**的东西——
   * 滚到第 20 张卡时想换个状态、或进「点单历史」，不该先滚回顶上。
   *
   * 段控（全家点菜单 / 只看我的）也在这一块里，因为它**自己也要能滑**
   * （用户 2026-10-16 在"订单手势"那题上选的一边就是「段控也能滑」）：
   * 手势认的是"划在谁身上"，它若落在下面那个 `SwipePager` 里，同一次划动会被两边抢。
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

      {/*
        选择模式的操作条（用户 2026-10-15：「底部或上部有批量操作的功能」）。
        放**上部**：底栏是 Tab、右下角还有 AI 悬浮球，再多一层会跟它们抢位置
        （本项目在"提示被弹层盖住"上踩过一次，见 R-059）——而选择模式一进来，
        眼睛本来就在顶部那条。它也在固定区：选了 5 餐、滚到下面去挑第 6 餐时，
        「已选 N 餐 / 退菜」得一直看得见。
      */}
      {selecting ? (
        <div className="pick-bar">
          <div className="pick-bar__row">
            <button type="button" className="pick-bar__exit" onClick={exitSelect}>
              退出
            </button>
            <span className="pick-bar__count">已选 {picked.length} 餐</span>
            <button
              type="button"
              className="pick-bar__all"
              onClick={() => {
                const all = (orders.data?.cards ?? []).map((card) => card.mealKey)
                setPicked(picked.length === all.length ? [] : all)
              }}
            >
              {picked.length === (orders.data?.cards?.length ?? 0) ? '取消全选' : '全选'}
            </button>
            <button
              type="button"
              className="pick-bar__go"
              disabled={picked.length === 0 || blockedMeals.length > 0 || clearMealItems.isPending}
              onClick={askClear}
            >
              {clearMealItems.isPending ? '正在退…' : '退菜'}
            </button>
          </div>
          {/*
            有「做好了」的餐被选中时，为什么退不动要写在这条操作条**自己身上**
            （D-066：点不动又不解释最糟）。放在同一个卡片里、虚线之上：
            它是这一条操作的附注，不是页面上另外一段话（用户 2026-10-15 的间隙反馈）。
          */}
          {blockedMeals.length > 0 && (
            <p className="pick-bar__tip">
              {blockedMeals.map((meal) => `${meal.date} ${meal.mealLabel}`).join('、')}
              已经「做好了」，成品不再是能改的东西——要改记录去点单历史。
            </p>
          )}
        </div>
      ) : (
        family.data && orders.data && (
          <div className="order-filter">
            <Chips items={chips} value={filter} onChange={setFilter} />
            {/*
              多选的**显式入口**：长按是手势，第一次用的人找不到（见 enterSelect 那段说明）。
              用户 2026-10-15 两次给位置：「多选按钮位置不对」（当时是筛选行里一枚文字胶囊，
              看着像第 4 个 chip）→ 先搬去页头 → 看过之后定稿：**放这一行最右边、改成图标**
              （「多选按钮位置放到全部那行的右侧，改成图标吧，注意左右空白间隙」）。

              所以它与 chips **同一行但不在滚动区里**：chips 那截自己横着滚、它与页面右栏距对齐
              （见 `.order-filter` / `.order-multi` 的样式注释）。只在列表里真有卡时出现——
              没菜的时候给这个按钮是空的；选择模式里这一行整个换成操作条，它自然退场。
            */}
            {!selecting && (orders.data.cards.length > 0) && (
              <button
                type="button"
                className="order-multi"
                aria-label="多选"
                title="多选"
                onClick={() => enterSelect()}
              >
                <SelectIcon width={19} height={19} />
              </button>
            )}
          </div>
        )
      )}

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

        它留在**内容**里（不在固定区）：说的正是"这个列表里某一餐空着"，
        跟着卡片走才对得上（用户定的固定区是"页头 + tab + 页面级操作行"）。
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

      {/*
        卡片列表这一块**能左右跟手翻页**（用户 2026-10-15：「类似这种 tab 页（全部、已安排、
        已做好）……需要能左右滑动切换」，随后又要求「要跟随手指拖动，滑到中间时，两个页是都能看见的」），
        现在是**整屏**（`fill`，用户 2026-10-16：「整屏滑动，并高度要自适应，菜谱没有超出屏幕时
        不要空白滑动」）。
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
                  title={status === 'ALL' ? '还没有人点菜' : '这个状态下没有点单'}
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
          onPointerDown={(event) => {
            pressedKey.current = card.mealKey
            longPress.handlers.onPointerDown(event)
          }}
          onPointerMove={longPress.handlers.onPointerMove}
          onPointerUp={() => {
            pressedKey.current = null
            longPress.handlers.onPointerUp()
          }}
          onPointerCancel={longPress.handlers.onPointerCancel}
          onPointerLeave={() => {
            pressedKey.current = null
            longPress.handlers.onPointerLeave()
          }}
          onContextMenu={longPress.handlers.onContextMenu}
          /*
            选择模式下这张卡是一个**复选框**：`role` + `aria-checked` 让读屏也念得出
            "已选/未选"（只画一个 ✓ 的方块对读屏等于没有）。
          */
          role={selecting ? 'checkbox' : undefined}
          aria-checked={selecting ? picked.includes(card.mealKey) : undefined}
          onClick={(event) => {
            const target = event.target as HTMLElement
            /*
              **长按抬起时浏览器会补一次 click**：不吐掉的话，"长按选中"会被紧接着的
              这次点击立刻取消（表现为"按半天选不上"）。这一句必须在最前面。
            */
            if (longPress.consumeClick()) return
            if (target.closest('button, a, input, select, textarea')) return
            if (selecting) {
              togglePick(card.mealKey)
              return
            }
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
            - **文案是后端那条的 `tag`**（"选好了""做好了"），不在这里另写一张表，
              否则后端加了新类别而前端不知道（与"去处由后端给"同一条规矩）；
            - **一餐最多两条，并排写在一颗角标里**（`A · B`），不叠两颗——
              右上角只有一个位置，叠起来会互相盖住。
          */}
          {cardBadges.length > 0 && (
            <span className="order-card__corner">{cardBadges.join(' · ')}</span>
          )}
          {/*
            选择模式下的勾选方块（用户 2026-10-15：「按住显示单选框」）。挂在**左上角**：
            右上角是未读角标的位置（D-082），两个挤在一起会互相盖住。
            `aria-hidden`：状态已经由卡片的 role/aria-checked 说了，这里只是给眼睛看的。
          */}
          {selecting && (
            <span
              className={['order-card__pick', picked.includes(card.mealKey) && 'is-on']
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            >
              {picked.includes(card.mealKey) ? '✓' : ''}
            </span>
          )}
          <div className="order-card__head">
            {/*
              选择模式下标题区**不能是链接**：这时候点整张卡的意思是"勾选它"，
              留着一个会跳走的链接等于在最需要多选的时候把人带走。
            */}
            {selecting ? (
              <span className="order-card__headlink">
                <span className="order-card__date">
                  {card.date} · {card.mealLabel}
                </span>
                <span className="order-card__who">{card.orderers.join(' · ')} 点的</span>
              </span>
            ) : (
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
            )}
            <span className={['stamp', STATUS_TONE[card.status]].filter(Boolean).join(' ')}>
              {card.statusLabel}
            </span>
            {/*
              选择模式下**不画那个 ›**：它说的是"点进去"，而这时候点卡是勾选。
              一个指错方向的箭头比没有箭头糟（D-066 那条"点不动的东西一个不留"的同一族）。
            */}
            {!selecting && (
              <span className="order-card__arrow" aria-hidden="true">
                ›
              </span>
            )}
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
                {/*
                  退掉一道菜。口径 2026-10-15 放开（用户：「批量操作…退菜这种的」）：
                  **到「正在做」为止都能退**（原来只在「待确认」给，后端 `canRemoveItem` 同样校验）。

                  列表上仍然只画**我点过的那几道**（`mineItemIds`）：这张卡上的菜是**合并过的**
                  （`番茄炒蛋 ×2` 可能两个人都点了），而列表里没有"每份是谁的"这层信息——
                  退别人的那一份要看清是谁的，那是详情页的活（那里按人分组，弹窗也会点名）。
                  只是少一道菜而不是退整桌时，也走详情页。
                */}
                {line.mineItemIds.length > 0 && card.status !== 'DONE' && !selecting && (
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
                    退掉我这份
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
          {/*
            选择模式下**收起三行动作**（改人数/存组合/再点一次）与成品照、流转按钮：
            这时候整张卡只表达一件事——"选我"。留着它们既误导（点下去会跳出多选），
            也会在窄屏上把勾选状态挤得看不见。
          */}
          {!selecting && (
          <>
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
          </>
          )}
        </article>
        )
          })
        }}
      />
      )}

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
