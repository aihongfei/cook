import { expiryLabel, expiryState } from '../fridge/fridge.rules'

/**
 * 消息提醒（M10）的**纯规则**。
 *
 * ## 为什么不建"通知表"
 *
 * 这批通知**全都能从已有数据现算出来**：菜单定下来了是 `MealOrder.confirmedAt`、
 * 饭做好了是 `MealOrder.doneAt`、快过期是 `FridgeItem.expiresOn`、该备菜了是
 * `MealOrder` 里还空着的那些餐次。存一份通知表就是存一份**会与事实漂移的副本**——
 * 用户把那一餐取消了，"饭做好了"那条通知还躺在表里；这正是本项目反复踩过的
 * "同一个事实两处各存一遍必然分叉"（D-059 四那一族）。
 *
 * 所以这里只有**两类落库的东西**，都不存通知正文：
 * **这张纯规则**（怎么从事实算出通知）+ **`NotificationPref`**（用户的四个开关）
 * + **`NotificationEvent`**（事件日志：某时刻发生过这件事、提醒过谁、他看过没有）。
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
 */
export type NotificationArea = 'order' | 'fridge'

/** 每一条属于哪个区域（底栏红点靠它，只此一份） */
export function areaOfKind(kind: NotificationKind): NotificationArea {
  // 「该备菜」归订单：它点进去是备菜页，而备菜是从订单那一支进去的（用户看到的入口在订单侧）
  return kind === 'expiry' ? 'fridge' : 'order'
}

/** 用户的四个开关（"已读"不在这张表上——逐条记在事件行上，见 D-078） */
export interface NotificationPrefs {
  mealPlan: boolean
  mealDone: boolean
  expiry: boolean
  prep: boolean
}

/** 四类提醒的标识（前端据此选图标与去处，也用于稳定 id） */
export type NotificationKind = 'plan' | 'done' | 'expiry' | 'prep'

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
   * 四个开关：**过滤放在这一层，不放在服务层**。
   *
   * 服务层已经按开关决定"要不要查那批数据"（少查一次是顺带的），但**只有这一层知道**
   * 「这一条属于哪个开关」——那份对应关系写两遍必然分叉：关掉"备菜"之后通知中心里
   * 还有一条备菜，用户只会以为开关坏了。所以开关在这里再过一遍，是**有意的重复**。
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
      tag: '菜单',
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
    })
  }

  items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return items
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
  const counts: Record<NotificationArea, number> = { order: 0, fridge: 0 }
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
  title: string
  body: string | null
  toPath: string
  at: Date
  readAt: Date | null
}

/**
 * 把"现在算出来的"与"库里记下的"合起来 —— **历史与看板的交汇点**。
 *
 * 两条规矩：
 *
 * 1. **文案与去处取库里那份**（不重算）：日志的价值在于如实回放**当时那句话**。
 *    一道菜后来改了名、那一餐被取消了，回看历史时句子不该跟着变
 *    （重算那一份只在首次入库时才用得上，见 `NotificationEvent` 的说明）；
 * 2. **已读只认库里的 `readAt`**：这样"读过了就不会再变回未读"是**结构性成立**的，
 *    不依赖"算出来的时间戳恰好没动"——后者会被"今天刚记的东西今天就到期"这类
 *    锚点变化打破（那正是这一版改动的起因）。
 *
 * **只回库里已有的那些条**：库里没有的（新发生的事）由调用方先写进去再调这里，
 * 于是列表上的每一条都必然有 `readAt` 可依。
 */
export function mergeStored(items: NotificationItem[], stored: Map<string, StoredEvent>, userId: string): NotificationRow[] {
  return items.flatMap((item) => {
    const row = stored.get(dedupeKeyOf(item.id, userId))
    if (!row) return []
    return [{
      ...item,
      // 文案与去处取库里那份（"当时那句话"）
      title: row.title,
      body: row.body,
      to: row.toPath,
      at: row.at.toISOString(),
      unread: row.readAt === null,
    }]
  })
}

/**
 * 备菜提醒的窗口：**只看最近这几天**。
 *
 * 三天是"还能改变结果"的范围：今天的晚餐还来得及点；往后第 10 天那一餐现在提醒
 * 只是噪音（用户会划掉，然后真正该提醒的那条也被顺带忽略了）。
 * 与 `fridge` 的 `SOON_DAYS`（3 天）同一个数，但**理由不同**，所以各自留一个常量。
 */
export const PREP_WINDOW_DAYS = 3
