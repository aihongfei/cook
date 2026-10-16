import { expiryLabel, expiryState } from '../fridge/fridge.rules'

/**
 * 消息提醒（M10）的**纯规则**。
 *
 * ## 为什么"通知"分成两条路
 *
 * 最初这批通知**全都从已有数据现算**：菜单定下来了是 `MealOrder.confirmedAt`、
 * 饭做好了是 `MealOrder.doneAt`、快过期是 `FridgeItem.expiresOn`、该备菜是还空着的餐次。
 * 存一份通知表就是存一份**会与事实漂移的副本**（D-059 四那一族）。
 *
 * 2026-10-16 用户把范围扩大了：「订单有变化、打卡墙有上传、评论、家庭有变化、冰箱有变化，
 * 就是家庭相关修改的都需要通知」。新要的这几块里有一部分**没有事实可现算**：
 *
 * - "有人撤了一道菜"——撤完 `OrderItem` 那行就没了，库里查不出"曾经有一道菜被撤过"；
 * - "有人从冰箱拿走一盒奶"——`FridgeItem` 那行也删了；
 * - "谁改了家庭名 / 谁把谁移出了家庭"——`Family.name` 只留现在的值，没有旧值。
 *
 * 这三类说的都是**一件已经发生的事**，而不是"现在处于什么状态"。所以现在有两条路：
 *
 * | | 谁产生 | 什么时候写 | 事实没了会怎样 |
 * | --- | --- | --- | --- |
 * | **状态型** `plan`/`done`/`expiry`/`prep` | 取列表时现算 | 懒补进日志 | 提醒跟着消失（那一餐取消了，提醒也没了） |
 * | **事件型** `order`/`fridge`/`checkin`/`comment`/`family`/`recipe` | 做事的那一侧 | 动作当场写 | 提醒仍在（"十点撤过一道菜"是发生过的事） |
 *
 * 这张文件的职责也因此分成两半：**状态型的算法**（`buildNotifications`，从事实算）
 * 与**事件型的文案**（`buildChange`，把"谁做了什么"拼成一句话）。两半共用同一套
 * kind / 开关 / 区域 / 已读——所以列表、红点、巡查三条路都不必知道一条提醒从哪来。
 *
 * ## "未读"怎么定义
 *
 * **逐条记在事件行上**（`NotificationEvent.readAt`），不是"上次看到哪儿了"的水位线：
 * 一条提醒是不是未读，只取决于**它自己那行有没有被标已读**。
 * 用户 2026-10-15 明确要求「需要真的已读时才清」——所以点开某一条才清那一条，
 * 打开通知中心本身**不改变任何已读状态**（曾经按"推水位线"设计过一版，被这句话否掉了）。
 *
 * 难点在**状态派生的那两条**（快过期 / 该备菜）没有"事件时间"——它们说的是"现在这个状态"。
 * 若把 `at` 取成"请求那一刻"，那刚标记完已读、下次请求又变成未读，红点永远消不掉。
 * 所以它们的 `at` 取一个**当天稳定、跨天会动**的锚点（见 `dayAnchor`）：
 * 今天看过之后就是已读；到了明天锚点跳一天，会生成**新的**一条（键里带日期）——
 * **"今天有东西要过期"本来就该每天提醒一次**。
 */

/**
 * 已读的**区域**——与底栏的 Tab 一一对应（用户 2026-10-15：「底部菜单，订单之类的
 * 也需要小红点」）。区域只用来决定**这个红点该数哪些条**，不用来决定"清哪些"。
 *
 * 只有两个区域，是因为**底栏只有五个 Tab，其中两个会亮**：订单（点单、菜单、
 * 备菜这一支）与冰箱。家庭、打卡、菜谱这三块红点挂在「我的」页里的明细行上
 * （不占底栏）——所以它们归 `order` 之外的一个**第三个区域**，见下。
 */
export type NotificationArea = 'order' | 'fridge' | 'family'

/**
 * 每一条属于哪个区域（底栏红点靠它，只此一份）。
 *
 * 分法是**"用户从哪儿能找到这件事"**，不是数据存在哪儿：
 * - `fridge` 是冰箱那一支：**快过期**（点进去去冰箱页把东西吃掉/扔掉）与
 *   **冰箱有变化**（用户 2026-10-16 要的那四块之一——有人放进来/拿走/改了，
 *   点进去就是那个冰箱）。两者都是"打开冰箱 Tab 能看到的事"；
 * - `order` 是点单与菜单那一支：点菜变动、菜单定了、做好了、该备菜——
 *   它们的入口与卡片都在订单页；
 * - `family` 是"家里的其他人做了什么"：打卡与评论、家庭变动、菜谱变动。
 *   它们**不亮底栏**（底栏那五个 Tab 里没有它们的入口），红点落在「我的」页
 *   对应的那几行上：打卡在「我的打卡」、家庭在「家庭」、菜谱在「我的菜谱」。
 */
export function areaOfKind(kind: NotificationKind): NotificationArea {
  switch (kind) {
    case 'expiry':
    // 「冰箱有变化」归冰箱 Tab：它点进去也是 `/fridge`，与"快过期"落在同一页上。
    // 归到 order 的话表现是"冰箱 Tab 不亮、订单 Tab 亮"，点进订单还找不到它
    // （那件事已经不在冰箱里了，订单页更不会显示它）——单测钉住了这一条。
    case 'fridge':
      return 'fridge'
    case 'checkin':
    case 'comment':
    case 'family':
    case 'recipe':
      return 'family'
    default:
      // plan / done / prep / order
      return 'order'
  }
}

/** 用户的开关（"已读"不在这张表上——逐条记在事件行上，见 D-078） */
export interface NotificationPrefs {
  mealPlan: boolean
  mealDone: boolean
  expiry: boolean
  prep: boolean
  orderChange: boolean
  fridgeChange: boolean
  checkin: boolean
  family: boolean
  recipe: boolean
}

/**
 * 十类提醒的标识（前端据此选图标与去处，也用于稳定 id）。
 *
 * 前四个是**状态型**（从事实现算，见文件头那张表），后六个是**事件型**（动作当场写）。
 * 十类归**九个开关**：`checkin` 与 `comment` 共用一个（都是打卡墙上的事、点进去同一处）。
 */
export type NotificationKind =
  | 'plan' | 'done' | 'expiry' | 'prep'
  | 'order' | 'fridge' | 'checkin' | 'comment' | 'family' | 'recipe'

/** 开关的键（`NotificationPrefs` 的键，也就是 `NotificationPref` 那九列） */
export type NotificationPrefKey = keyof NotificationPrefs

/**
 * 这一条属于哪个开关（**只此一份**）。
 *
 * 消息中心里关掉一个开关要**立刻少掉对应的那几条**，而"哪几条归这个开关"是个事实——
 * 写两遍必然分叉（关掉"打卡"之后列表里还留着一条打卡，用户只会以为开关坏了）。
 * 所以：算提醒时按它过滤、写开关的接口按它校验、界面上的开关清单也按它分组。
 */
export function prefOfKind(kind: NotificationKind): NotificationPrefKey {
  switch (kind) {
    case 'plan': return 'mealPlan'
    case 'done': return 'mealDone'
    case 'expiry': return 'expiry'
    case 'prep': return 'prep'
    case 'order': return 'orderChange'
    case 'fridge': return 'fridgeChange'
    case 'checkin':
    case 'comment':
      // 打卡与评论合成一个开关：两件事都在打卡墙上，用户说的也是"打卡墙有上传、评论"
      return 'checkin'
    case 'family': return 'family'
    case 'recipe': return 'recipe'
  }
}

/** 九个开关的键（顺序就是界面上那一列的顺序——状态型在前、事件型在后） */
export const NOTIFICATION_PREF_KEYS: NotificationPrefKey[] = [
  'mealPlan', 'mealDone', 'expiry', 'prep',
  'orderChange', 'fridgeChange', 'checkin', 'family', 'recipe',
]

export interface NotificationItem {
  /** 稳定 id：同一条提醒在多次请求里必须是同一个（前端列表 key、也是"你看到的就是这条"） */
  id: string
  kind: NotificationKind
  /** 一句话标题（后端拼好，与 `stockLabel`/`cookedLabel` 同一条规矩：前端不各拼一遍） */
  title: string
  /** 一句补充（可空——不是每条都需要第二句） */
  body: string | null
  /** 这条提醒对应的时刻（**事件发生的那一刻**；排序用它，已读不用它） */
  at: string
  /** 点进去看哪儿（应用内路由，后端给；前端不按 kind 硬编码跳转表） */
  to: string
  /**
   * 这条提醒**属于哪一餐**（`2026-10-18-DINNER`）；不属于具体某一餐时为 `null`。
   *
   * 用户 2026-10-14：「订单有红点，但是里面的卡片看不出来哪个是提醒的」——
   * 点单列表要把"这张卡有事没看过"标出来，而它需要的正是这个对应关系。
   *
   * **结构化给出，而不是让前端从 `id` 或 `to` 里切字符串**：那种切法迟早切错
   * （`prep` 的键里没有 mealKey、`expiry` 指向冰箱），而"这一条对应哪一餐"是
   * 一个**事实**，事实应该由知道它的一侧给出（与"去处由后端给"同一条规矩）。
   */
  mealKey: string | null
  /** 标题后面那个小标（"已做好""快过期"…），前端直接渲染 */
  tag: string
  /**
   * 这一条是**怎么来的**——状态型（现算）还是事件型（当时写下的）。
   *
   * **目前没有一处"按它分支"**（巡查、通知中心、红点都不看它），这是有意的：
   * 两条路的差别已经被 `at` 与 `id` 的**产生方式**吃掉了，不需要再分叉——
   * - 事件型的 `at` 取自库里那行（`mergeStored` 用 `row.at`），写下去就**不再动**；
   * - 状态型的 `at` 按天锚定（`dayAnchor`），跨天**跳一格**是刻意的：
   *   "今天有东西要过期"本来就该每天提醒一次（换了新 id，所以是"新的一条"）；
   * - 巡查只按 `at > since` 挑（见 `patrol.rules`），上面两条合起来正好是它要的口径。
   *
   * 它存在的意义是**让"这条会不会自己消失"在数据里看得见**（见文件头那张表）——
   * 单测与真实请求验收都据此断言两类不会互相串（如"事件型那几条不会自己消失"）。
   * 将来若真有谁要按它分支（比如"历史里只留事件型"），这里就是那个判据。
   */
  origin: 'derived' | 'event'
}

/** 排序后的每一条都补上 `unread`（列表元素类型，见 `buildNotifications` 末尾） */
export type NotificationRow = NotificationItem & { unread: boolean }

export interface NotificationInput {
  /**
   * 每天会翻的锚点（`YYYY-MM-DD`）：状态派生的提醒用它当 `at`。
   * 传"今天"的日期串——跨天它就变了，正是我们要的。
   */
  today: string
  /**
   * **状态型那四个**开关：过滤放在这一层，不放在服务层。
   *
   * 服务层已经按开关决定"要不要查那批数据"（少查一次是顺带的），但**只有这一层知道**
   * 「这一条属于哪个开关」——那份对应关系写两遍必然分叉：关掉"备菜"之后通知中心里
   * 还有一条备菜，用户只会以为开关坏了。所以开关在这里再过一遍，是**有意的重复**。
   *
   * 类型只取这四列（而不是整张 `NotificationPrefs`）：这一层**只产出状态型**，
   * 传进来另外五个开关它也用不上——窄一点的类型能让"谁负责哪一半"在签名上看得见。
   * 事件型那六类的开关在**写入时**就用掉了（见 `NotificationsService.recordChange`），
   * 读取时过一遍是在 `mergeStored` 里（那里拿到的是完整的九列）。
   */
  prefs: Pick<NotificationPrefs, 'mealPlan' | 'mealDone' | 'expiry' | 'prep'>
  plan: PlanFact[]
  done: DoneFact[]
  fridge: FridgeFact[]
  prep: PrepFact[]
}

/** 菜单定下来了（F10-01）。`byMe` = 是我定的（自己定的不提醒自己） */
export interface PlanFact {
  mealKey: string
  /** 谁定的 */
  byName: string
  byMe: boolean
  /** 定下来的时刻 */
  at: Date
  /** 「今天晚餐」这样一句（由服务层拼：它才有日期标签与餐次表，这一层不碰中文） */
  whenLabel: string
  dishCount: number
}

/** 饭做好了（F10-02）。只给"我点过菜"的那些餐。`byMe` = 是我标成做好的 */
export interface DoneFact {
  mealKey: string
  /** 谁做的 */
  byName: string
  byMe: boolean
  at: Date
  whenLabel: string
  /** 我在这一餐点的菜（用来拼"你点的 红烧排骨 等 3 道"） */
  myDishes: string[]
}

/** 冰箱有东西快过期（F10-03） */
export interface FridgeFact {
  id: string
  name: string
  expiresOn: Date
  /** 记进冰箱的时刻——今天新记的、今天就到期的，要让它是未读（见 `dayAnchor`） */
  createdAt: Date
}

/** 接下来有餐次还空着（F10-03 的备菜提醒） */
export interface PrepFact {
  dateLabel: string
  mealLabel: string
  mealKey: string
}

/**
 * 状态派生提醒的锚点时刻：**今天零点与"它自己产生的时刻"取晚的那个**。
 *
 * 用两个例子说明为什么是 `max` 而不是任选一个：
 * - 三天前放进冰箱的东西**今天**才进入"快过期"（时间自己走到了这一步）→ 取今天零点，
 *   于是今天看过之后就是已读，明天锚点再跳；
 * - **今天刚记**的东西今天就到期（用户自己刚造成的）→ 取 `createdAt`，
 *   于是"我刚记完再打开通知中心"它是未读的——这条提醒确实是新的。
 *
 * 若只取今天零点，第二种情况会被当成"今天早些时候看过了"而漏掉；
 * 若只取 `createdAt`，第一种情况会拿到三天前那个时刻，于是它**一出生就是"旧的"**、红点不会亮
 * （已读是逐条判定的，`at` 直接决定这一条落在列表的什么位置、算不算当天的事）。
 */
export function dayAnchor(today: string, createdAt: Date): Date {
  const startOfDay = new Date(`${today}T00:00:00`)
  return createdAt.getTime() > startOfDay.getTime() ? createdAt : startOfDay
}

/** `YYYY-MM-DD`（按服务器本地日历，与冰箱那套相对日期同一口径） */
export function dateKey(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 快过期的那些（按"最紧急"排前面：过了期的 > 今天 > 明天 > 还有几天） */
export function dueFridge(facts: FridgeFact[], now: Date = new Date()): FridgeFact[] {
  return facts
    .filter((fact) => expiryState(fact.expiresOn, now) !== null)
    .sort((a, b) => a.expiresOn.getTime() - b.expiresOn.getTime() || a.name.localeCompare(b.name))
}

/**
 * 「快过期」那条提醒的正文。
 *
 * **一样都不许编**：没有名字就没有这条提醒（`dueFridge` 已经过滤过）。
 * 三种句子分别对应"已经坏了""今天要吃掉""过两天要吃掉"，与冰箱页那句 `expiryLabel` 同源
 * （直接复用它，不在这一侧再写一遍日期说法）。
 */
export function fridgeBody(items: FridgeFact[], now: Date = new Date()): string {
  const head = (list: FridgeFact[]) => {
    const names = list.map((item) => item.name)
    return `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 样` : ''}`
  }
  /*
   * 已经过期的要**单独说清楚**：「快过期」与「已经坏了」是两件事，
   * 混在一句里会让用户以为还有时间（而它已经不能吃了）。
   * 三种句式分别对应"全坏了""有一部分坏了""都还来得及"——
   * 中间那种最容易写坏（第一版写成"酸奶、牛奶 · 最早 过期 1 天"，读起来像绕口令），
   * 所以分成两句、把两类各说一遍。
   */
  const expired = items.filter((item) => expiryState(item.expiresOn, now) === 'expired')
  const fresh = items.filter((item) => expiryState(item.expiresOn, now) !== 'expired')
  if (expired.length === items.length) return `${head(expired)} 已经过期了`
  if (expired.length > 0) return `${head(expired)} 已经过期了 · 另外 ${fresh.length} 样快到期`
  const label = items[0] ? expiryLabel(items[0].expiresOn, now) : null
  return label ? `${head(items)} · 最早 ${label}` : head(items)
}

/**
 * 算出全部提醒（已按时间倒序排好；**新的在前面**）。
 *
 * 这里**只产出事实与文案**，不碰已读：`unread` 由 `mergeStored` 按事件日志里
 * 各自那行的 `readAt` 补上。排序也只看 `at`、不看已读——排序若把已读算进去，
 * 用户标完一条列表会**重新排一遍**，"我刚看的那条跑哪去了"。
 */
export function buildNotifications(input: NotificationInput, now: Date = new Date()): NotificationItem[] {
  const items: NotificationItem[] = []

  for (const fact of input.prefs.mealPlan ? input.plan : []) {
    // 自己定的菜单不提醒自己：提醒的意义是"我不知道这件事发生了"
    if (fact.byMe) continue
    items.push({
      id: `plan:${fact.mealKey}`,
      kind: 'plan',
      title: `${fact.whenLabel}的菜单定下来了`,
      body: `${fact.byName}定了 ${fact.dishCount} 道菜`,
      at: fact.at.toISOString(),
      /*
       * 直接进**那一餐的详情**（用户 2026-10-15：「通知可以点击跳转到对应的地方去」）。
       * 原先给的是 `/order` 列表页——用户还得在里面找是哪一餐。既然详情页按 `mealKey`
       * 取数、而这条提醒的 id 里就有 `mealKey`，没有理由让他自己找。
       */
      to: `/order/${fact.mealKey}`,
      mealKey: fact.mealKey,
      /*
       * 角标上写的是一个**动作**（"选好了"），不是名词（"菜单"）。
       *
       * 用户 2026-10-14：「菜单那条改为选好了」。原因在点单卡上看得最清楚：那颗角标
       * 就贴在状态戳「已安排」旁边，而「菜单」既可以是状态也可以是页面名，读起来像
       * "这里有一份菜单"，不像"有人做了什么、你还没看"。「选好了」正是掌勺人点的那一步
       * 在按钮上的原话——做的人和看的人用同一个词。
       */
      tag: '选好了',
      origin: 'derived',
    })
  }

  for (const fact of input.prefs.mealDone ? input.done : []) {
    /*
     * 两条都不提醒：**没点过这一餐的**（`myDishes` 空——没在等这顿饭的人不必知道它好了）
     * 与**自己标的**（我自己知道）。
     *
     * 这两条判据**写在规则里而不是服务层的查询里**：「什么算一条提醒」是这个文件的事，
     * 服务层只负责把事实收集齐。写在查询里的话它就测不到，而它恰恰是这一条提醒最容易被
     * 改坏的地方（"饭好了"发给了全家人 vs 只发给点菜的人，是个产品判断，不是查询细节）。
     */
    if (fact.byMe) continue
    if (fact.myDishes.length === 0) continue
    const dishes = fact.myDishes.slice(0, 2).join('、')
    const more = fact.myDishes.length > 2 ? ` 等 ${fact.myDishes.length} 道` : ''
    items.push({
      id: `done:${fact.mealKey}`,
      kind: 'done',
      title: `${fact.whenLabel}做好了`,
      body: `你点的 ${dishes}${more} 可以吃了`,
      at: fact.at.toISOString(),
      // 同上：进**这一餐**的详情，而不是列表页里自己找
      to: `/order/${fact.mealKey}`,
      mealKey: fact.mealKey,
      tag: '做好了',
      origin: 'derived',
    })
  }

  const due = input.prefs.expiry ? dueFridge(input.fridge, now) : []
  if (due.length > 0) {
    /*
     * 锚点取**这批里最早的那个**：它决定这条提醒什么时候算"新"。
     * 同一批里有的旧有的新时，取最早的会让整条偏旧（可能一进来就是已读）——
     * 所以取**最晚**的那个反而更贴事实："这一批里最新出现的那件事"。
     */
    const anchors = due.map((item) => dayAnchor(input.today, item.createdAt))
    const at = anchors.reduce((latest, current) => (current.getTime() > latest.getTime() ? current : latest))
    items.push({
      id: `expiry:${input.today}`,
      kind: 'expiry',
      title: `${due.length} 样食材该处理了`,
      body: fridgeBody(due, now),
      at: at.toISOString(),
      to: `/fridge`,
      // 冰箱的事不属于某一餐（点单列表上没有它的位置）
      mealKey: null,
      tag: '快过期',
      origin: 'derived',
    })
  }

  const prepFacts = input.prefs.prep ? input.prep : []
  if (prepFacts.length > 0) {
    const first = prepFacts[0]
    const at = dayAnchor(input.today, new Date(`${input.today}T00:00:00`))
    items.push({
      id: `prep:${input.today}`,
      kind: 'prep',
      title: prepFacts.length === 1 ? `${first.dateLabel}${first.mealLabel}还没安排` : `接下来 ${prepFacts.length} 餐还没安排`,
      body: prepFacts.length === 1 ? '想吃什么去点两道' : `最近的是${first.dateLabel}${first.mealLabel}`,
      at: at.toISOString(),
      to: `/prep`,
      /*
       * 「该备菜」说的是"某一餐还空着"——**那一餐没有点单卡**（没人点菜才空着），
       * 所以它标不到卡片上。这不是漏了：红点归订单，是因为备菜的入口在订单那一支。
       * 前端据此把"没法标到卡上"的那些排除掉，而不是在界面上留一个指不到任何东西的标记。
       */
      mealKey: null,
      tag: '备菜',
      origin: 'derived',
    })
  }

  items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return items
}

/**
 * **事件型**提醒要说的那件事（"谁做了什么"）——由做事的那一侧**当场**构造出来。
 *
 * 与 `PlanFact`/`DoneFact` 那几个"事实"的区别是：那些描述**现在是什么状态**
 * （那一餐的菜单定了、做好了），由服务层查库查出来；这一份描述**刚刚发生了什么**，
 * 只能由做事的那一侧提供——撤了一道菜之后，库里已经没有那道菜了。
 *
 * ## 这里没有"谁"，也没有"提醒谁"
 *
 * **谁做的**由 `recordChange` 从 `actorId` 查出来补上（调用方只报"发生了什么"）：
 * 让每个写接口各自查一次昵称，就意味着五个地方各写一遍同样的查询，
 * 而"谁做的"这件事在那五处**完全一样**——这正是该收在一处的那种重复。
 *
 * **提醒谁**同样不在这里：`recordChange` 扇出给家里人（排掉做事的人自己、
 * 排掉关掉这一类开关的人）。所以这一份只描述事实，不含任何人。
 *
 * ## 为什么 `body` 是可空的
 *
 * 有些变动没有细节可补（"有人退出了家庭"）。空的时候 `title` 单独成立。
 */
export interface ChangeFact {
  /** 这件事归哪一类（决定开关、区域、图标、角标） */
  kind: Extract<NotificationKind, 'order' | 'fridge' | 'checkin' | 'comment' | 'family' | 'recipe'>
  /** 一句话里那个"做了什么"（如"加了一道菜"）——不带人名，人名由 `recordChange` 拼在前面 */
  action: string
  /** 补一句细节（菜名、食材名、家庭名…），可空 */
  body: string | null
  /** 点进去看哪儿 */
  to: string
  /** 属于哪一餐（点单列表据此标卡片）；不涉及具体某一餐时为 null */
  mealKey: string | null
  /** 标题旁边那个小标（"加菜""入库""新菜谱"…） */
  tag: string
  /**
   * **幂等键的业务部分**（`<scope>:<目标 id>`，如 `order:<OrderItem.id>`）。
   *
   * 与状态型不同，事件型的键**不能只看"哪一类 + 目标"**：同一个人可以对同一餐
   * 撤一次、再加一次——那是两件不同的事，该有两条提醒（"十点加了一道菜、
   * 十一点撤了一道菜"）。所以调用方把一个**能区分同一动作不同次调用**的片段带进来
   * （加菜用那一条 `OrderItem.id`、打卡上传用 `CheckIn.id`）。
   *
   * 需要区分形状时用 `<目标>:<动作>` 的写法（如 `diners:<mealKey>:8`），
   * 但**不要拿"现在几点"当后缀**：那样重放同一个请求会写出第二条（见 `recordChange` 的幂等说明）。
   *
   * 键里带 userId 那一层由 `dedupeKeyOf` 加（同一件事对家里人各一条、各记各的已读）。
   */
  scope: string
}

/**
 * 把一条**事件型**变动拼成提醒（事件型那半的唯一入口）。
 *
 * 两件事在这里定：**文案的形状**（"谁 + 做了什么"）与**稳定 id**。
 * 已读不在这里（由 `mergeStored` 从库里那行取），收件人也不在这里（见 `ChangeFact`）。
 */
export function buildChange(byName: string, fact: ChangeFact): NotificationItem {
  return {
    id: `${fact.kind}:${fact.scope}`,
    kind: fact.kind,
    // 「谁做了什么」——一句话里主谓宾齐了，比"XX有变动"这种没有信息量的标题强
    title: `${byName}${fact.action}`,
    body: fact.body,
    /*
     * 事件型没有"现算"这一步，`at` 就是**发生的那一刻**（= 写入那一刻）。
     * 这与状态型里"菜单定下来了"取 `confirmedAt` 是同一条：记的是事发生的时刻，
     * 不是"用户打开通知中心"的时刻。
     */
    at: new Date().toISOString(),
    to: fact.to,
    mealKey: fact.mealKey,
    tag: fact.tag,
    origin: 'event',
  }
}

/** 未读条数（**不是**列表长度——已读的那些还要能翻回去看） */
export function unreadCount(rows: NotificationRow[]): number {
  return rows.filter((row) => row.unread).length
}

/**
 * 按区域数未读（底栏那两个红点各取自己那一项）。
 *
 * **底栏红点用它，不在界面里再"三加一"算一遍**：那种算术写在两处，迟早一处改了
 * 另一处没改（改完的表现是"订单的红点少了一个"）。
 */
export function unreadByArea(rows: NotificationRow[]): Record<NotificationArea, number> {
  const counts: Record<NotificationArea, number> = { order: 0, fridge: 0, family: 0 }
  for (const row of rows) {
    if (row.unread) counts[areaOfKind(row.kind)] += 1
  }
  return counts
}

/**
 * 一条提醒在**事件日志**里的键：`<那条的 id>:<userId>`。
 *
 * 抽成一个函数是**必须的**——写入与查回两侧都要用它，各拼一遍的经典后果是
 * "写进去用 `id:user`、查回来拿 `id` 去比"，于是列表永远是空的
 * （第一版就是这么写的，真实请求一跑就发现了：9 条提醒一条都没出来）。
 * 带上 userId 是为了让同一件事对不同人各有一行、各记各的已读。
 */
export function dedupeKeyOf(itemId: string, userId: string): string {
  return `${itemId}:${userId}`
}

/** 库里那一条事件（`NotificationEvent` 的一行，只取合并时要用的字段） */
export interface StoredEvent {
  dedupeKey: string
  kind: string
  title: string
  body: string | null
  toPath: string
  at: Date
  readAt: Date | null
  mealKey: string | null
  tag: string | null
}

/** 这一类的提醒是**事件型**（动作当场写下，见文件头那张表）——库里存过就该一直显示 */
export function isEventKind(kind: string): kind is Extract<NotificationKind, 'order' | 'fridge' | 'checkin' | 'comment' | 'family' | 'recipe'> {
  return kind === 'order' || kind === 'fridge' || kind === 'checkin' || kind === 'comment' || kind === 'family' || kind === 'recipe'
}

/**
 * `dedupeKeyOf` 的**逆**：从库里的键取回"当时那条提醒的 id"。
 *
 * 事件型那半没有"现算的那条"可依，列表里的 id 只能从库里的键取回来——
 * 而列表 id 必须是**原来那个**（前端拿它调 `markRead`，那边会用 `dedupeKeyOf` 再拼一次；
 * 拼出来对不上就永远标不上已读，见 D-078 四那两次教训）。
 *
 * 所以这里不做"看起来能work"的字符串切分（`split(':')` 会在 id 自带冒号时切错），
 * 而是**按已知的后缀精确剥掉** `:userId`；剥不掉时返回 null，由调用方跳过这一条
 * （宁可少显示一条，也不要给出一个标不上已读的 id）。
 */
export function itemIdOf(dedupeKey: string, userId: string): string | null {
  const suffix = `:${userId}`
  if (!dedupeKey.endsWith(suffix)) return null
  const itemId = dedupeKey.slice(0, -suffix.length)
  return itemId || null
}

/**
 * 把"现在算出来的"与"库里记下的"合起来 —— **历史与看板的交汇点**。
 *
 * 三条规矩：
 *
 * 1. **文案与去处取库里那份**（不重算）：日志的价值在于如实回放**当时那句话**。
 *    一道菜后来改了名、那一餐被取消了，回看历史时句子不该跟着变
 *    （重算那一份只在首次入库时才用得上，见 `NotificationEvent` 的说明）；
 * 2. **已读只认库里的 `readAt`**：这样"读过了就不会再变回未读"是**结构性成立**的，
 *    不依赖"算出来的时间戳恰好没动"——后者会被"今天刚记的东西今天就到期"这类
 *    锚点变化打破（那正是这一版改动的起因）；
 * 3. **两条路各出各的**（2026-10-16）：
 *    - **状态型**那四类只显示"现算还有的那几条"——库里存过、现在算不出来的
 *      （那一餐被取消了、东西被吃了）**不显示**：它说的是"现在这个状态"，事实没了就不该在；
 *    - **事件型**那六类**以库为准**全部显示——它说的是"发生过这件事"，
 *      撤掉的那道菜不会因为没有那道菜了就没发生过。库里没有对应的现算条目，照样出。
 */
export function mergeStored(
  items: NotificationItem[],
  stored: Map<string, StoredEvent>,
  userId: string,
  prefs: NotificationPrefs,
): NotificationRow[] {
  const rows: NotificationRow[] = []
  const merged = new Set<string>()

  // ① 现算的那些：逐条用库里那份覆盖文案与已读（库里没有的说明还没落库，调用方先写再读）
  for (const item of items) {
    const key = dedupeKeyOf(item.id, userId)
    const row = stored.get(key)
    if (!row) continue
    merged.add(key)
    rows.push({
      ...item,
      // 文案与去处取库里那份（"当时那句话"）
      title: row.title,
      body: row.body,
      to: row.toPath,
      at: row.at.toISOString(),
      unread: row.readAt === null,
    })
  }

  /*
   * ② 事件型的那些：库里存过就出，与"现在还能不能算出它"无关。
   *
   * 仍然过一遍开关：用户关掉"打卡"之后，列表里不该还留着一串打卡——
   * 与四类状态型被开关过滤掉是同一条可见性口径（"这一页显示的是你现在允许的那些"）。
   * 写入时也按开关跳过（`recordChange`），所以关掉期间发生的事不会攒着、重新打开时涌出来。
   */
  for (const row of stored.values()) {
    if (merged.has(row.dedupeKey)) continue
    if (!isEventKind(row.kind)) continue
    if (!prefs[prefOfKind(row.kind)]) continue
    const id = itemIdOf(row.dedupeKey, userId)
    if (!id) continue
    rows.push({
      id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      at: row.at.toISOString(),
      to: row.toPath,
      mealKey: row.mealKey,
      // 老行（这一版之前写的）没有这两列：空标不显示，前端按"没有小标"处理
      tag: row.tag ?? '',
      origin: 'event',
      unread: row.readAt === null,
    })
  }

  /*
   * 排序放在**合并之后**：两条路各自排过了，但合起来才是用户看到的那个列表。
   * 按 `at` 倒序（新的在前）、同刻按 id 定序——与 `buildNotifications` 末尾同一条。
   */
  rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return rows
}

/**
 * 备菜提醒的窗口：**只看最近这几天**。
 *
 * 三天是"还能改变结果"的范围：今天的晚餐还来得及点；往后第 10 天那一餐现在提醒
 * 只是噪音（用户会划掉，然后真正该提醒的那条也被顺带忽略了）。
 * 与 `fridge` 的 `SOON_DAYS`（3 天）同一个数，但**理由不同**，所以各自留一个常量。
 */
export const PREP_WINDOW_DAYS = 3
