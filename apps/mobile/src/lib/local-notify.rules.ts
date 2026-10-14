import type { FridgeItem } from '@/api/fridge'
import type { MealProgressRow } from '@/api/orders'

/**
 * 本机通知的**纯规则**（M10 交付二）。
 *
 * ## 这里只排「这台手机自己就能判定」的事
 *
 * 两类，都是**时间驱动**的，不需要任何服务器参与，所以可以**提前排**给系统闹钟——
 * 排完了 App 死掉也照样响：
 * - **到点该做饭**：窗口内某一餐定了菜单，做饭时间前一小时说一句；
 * - **有东西到期**：冰箱里的东西在**到期那天的早上 9 点**说一句（不是"只在今天算一次"，
 *   见 `expiryReminders`——提前排是"关闭也会响"的前提）。
 *
 * 它们与"别人点了菜"那种**远端事件**是两回事——后者必须有推送通道才能送到关着的
 * App（调研见 `docs/context/RESEARCH.md` 七），而前者只要系统允许本机闹钟即可。
 * **刻意不把后者塞进来充数**：排一条永远不会响的提醒比不排更糟。
 *
 * ## 排程是**现算的、每次整批替换**（与通知中心同一条思路）
 *
 * 排的时候不写"已排过"的账。每次拿到最新数据就 `cancelAll()` + 重排一遍，
 * 于是**取消的那一餐、从冰箱删掉的那样东西，它们的提醒自动消失**。
 * 这就是 D-078 二那条"不存副本"的精神：排过的提醒不是事实，事实是菜单与保质期。
 *
 * ⚠️ **提前排的代价要说明白**：响出来的那句话基于**最后一次同步**的数据。
 * 家人从别的手机取消了那一餐，这台手机要到下次打开 App 才知道——那时会响一条
 * 已经过时的话。这是没有推送通道（R-63）时能做到的最好程度：宁可偶尔说一句过时的，
 * 也不要"没打开就不响"。
 *
 * ## 这个文件不碰 Capacitor
 *
 * 纯函数（算 id、算时刻、拼句子）在这里，插件的调用在 `local-notify.ts`——
 * 于是排程这件事能被单测钉住，而"什么时候请求权限、什么时候排"是另一层的事。
 */

/**
 * 做饭提醒的时刻（**24 小时制，本机时区**）。
 *
 * ⚠️ **这是本项目唯一一处凭空定的时间**：库里只有"日期 + 午/晚餐"，没有"几点吃"。
 * 取 11:00 / 17:00 是想在"还没开始做"与"别再拖了"之间留一小时左右
 * （一般人家 12 点前后吃午饭、18 点前后吃晚饭）。**它不影响任何其它功能**
 * （不改状态、不写库），所以是个随时可以调的常数——但必须写在明面上，
 * 不能假装它是从数据里来的。以后要做"我家的饭点"再让它可配。
 */
export const COOK_HOUR = { LUNCH: 11, DINNER: 17 } as const

/** 到期提醒的时刻：早上说一句，给一天时间处理 */
export const EXPIRY_HOUR = 9

/**
 * 最多往后排几天（做饭与到期共用）。
 *
 * 与**点菜窗口**（7 天）同数：菜单再远的也还没点，排了也没内容。
 * 顺带压住系统的待发闹钟数量（Android 对每个 App 的待发闹钟有上限）。
 * 到期提醒也限在这个窗口里：一周都没打开过 App 的话，手上的数据早就不作数了
 * （见文件头那条"提前排的代价"）。
 */
export const SCHEDULE_WINDOW_DAYS = 7

/** 一条待排的本机通知（插件调用要的最小形状，`id` 已算好） */
export interface LocalReminder {
  /** 插件要求数字 id；由 `reminderIdOf` 从稳定的字符串键算出来 */
  id: number
  /** 触发时刻 */
  at: Date
  title: string
  body: string | null
  /** 点开跳到哪儿（应用内路径，与通知中心的 `to` 同一族） */
  to: string
  /** 这条属于哪一类（排查与测试用） */
  kind: 'cook' | 'expiry'
}

/**
 * 字符串键 → 插件的数字 id。
 *
 * 插件只要数字，而我们的键是 `cook:2026-10-18-LUNCH` 这种字符串。用 FNV-1a
 * 折成 31 位正整数：**同一个键任何时候都得到同一个数字**，这正是"整批替换"
 * 需要的前提（否则重复排会留下两条同样的提醒）。
 *
 * 取正数（去掉符号位）是因为插件内部把它当 `Int`，负数在某些机型上会被系统
 * 当成另一个 id——那是"看起来排上了却弹不出来"的一类隐形故障。
 */
export function reminderIdOf(key: string): number {
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 1
}

/** 本地时区某一天的 YYYY-MM-DD（与后端 `dateKey` 同一口径） */
function dayKeyOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD` + 小时 → 本机时区的那一时刻 */
function atHour(day: string, hour: number): Date {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, hour, 0, 0, 0)
}

/** 往后 n 天（本机时区）的日期，含今天 */
function upcomingDays(now: Date, days: number): string[] {
  const out: string[] = []
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    out.push(dayKeyOf(day))
  }
  return out
}

/**
 * 做饭提醒：这一餐定了菜单、还没做好，就在饭点前一小时说一句。
 *
 * **要说话的三类情况分开拼**（与通知中心那套"后端拼句子"同一条规矩，前端不各写一份）：
 * - 没定人数（`dinerCount === null`）→ 提醒里明说，顺手把"定人数"这件事带出来；
 * - 有菜没定人数、有菜有定人数 → 报菜数与人数。
 *
 * `status` 只认 `PLANNED` / `COOKING`：`PENDING` 是"还没定下来"（点了菜但没确认，
 * 可能还会改），`DONE` / `CANCELED` 是过去的事。
 */
export function cookReminders(
  rows: { day: string; meals: MealProgressRow[] }[],
  now: Date,
  windowDays = SCHEDULE_WINDOW_DAYS,
): LocalReminder[] {
  const days = new Set(upcomingDays(now, windowDays))
  const out: LocalReminder[] = []

  for (const day of rows) {
    if (!days.has(day.day)) continue
    for (const meal of day.meals) {
      if (meal.status !== 'PLANNED' && meal.status !== 'COOKING') continue
      // 没有菜就没有"要做饭"这回事（空餐次由通知中心的"该备菜"负责，那是应用内的事）
      if (meal.dishCount <= 0) continue

      const at = atHour(day.day, COOK_HOUR[meal.meal])
      if (at.getTime() <= now.getTime()) continue

      const who = meal.dinerCount ? `${meal.dinerCount} 个人吃` : '还没定几个人吃'
      out.push({
        id: reminderIdOf(`cook:${meal.mealKey}`),
        at,
        title: `${meal.label}该做饭了`,
        body: `${meal.dishCount} 道菜 · ${who}`,
        to: `/order/${meal.mealKey}`,
        kind: 'cook',
      })
    }
  }
  return out
}

/**
 * 到期提醒：**每样东西在它到期的那天早上 9 点**说一句（同一天的多件合成一条）。
 *
 * ⚠️ 关键在"**提前排**"：通知要在 App 没打开时也能弹，就必须在**那天到来之前**
 * 交给系统闹钟。所以这里看的是**未来 `windowDays` 天里各自的到期日**，而不是
 * 只算"今天到期"——只看今天的话，哪天早上 9 点前没打开过 App，那天就没有提醒。
 * "到期当天说一句"的口径不变：每一批东西都排在**它自己的那天**早上响。
 *
 * 三条刻意的：
 * - **过期之后不再天天催**：过期了还留在冰箱里的，只在**今天早上**补说最后一次
 *   （"该处理了"），之后不再排——反复催一件已经知道的事会让人关掉这个功能。
 *   应用内的红点不受此限：那是"打开就看到"的一层，不打扰；
 * - **没写保质期的不排**：那是"不知道什么时候坏"，不是"今天坏"（F6-05 定的口径）；
 * - **已经过期的当天也算**（早上 9 点排的时候，昨天过期的还没处理）——
 *   如实说"已经过期"，不假装它今天才到期。
 */
export function expiryReminders(
  items: FridgeItem[],
  now: Date,
  windowDays = SCHEDULE_WINDOW_DAYS,
): LocalReminder[] {
  const today = dayKeyOf(now)
  const horizon = new Set(upcomingDays(now, windowDays))

  // 按"要在哪天早上说"分桶：窗口内的按各自到期日；已经过期的并进今天（最后一次）
  const byDay = new Map<string, { names: string[]; expired: number }>()
  const addTo = (day: string, item: FridgeItem) => {
    const bucket = byDay.get(day) ?? { names: [], expired: 0 }
    bucket.names.push(item.name)
    if (item.expiryLabel?.startsWith('过期')) bucket.expired += 1
    byDay.set(day, bucket)
  }

  for (const item of items) {
    if (!item.expiresOn) continue
    if (item.expiresOn < today) {
      if (item.expiryLabel?.startsWith('过期') === true) addTo(today, item)
      continue
    }
    if (horizon.has(item.expiresOn)) addTo(item.expiresOn, item)
  }

  const out: LocalReminder[] = []
  for (const [day, bucket] of byDay) {
    const at = atHour(day, EXPIRY_HOUR)
    // 那一刻已经过了（比如用户下午才装上）就不再补一条"今天到期"——
    // 那会在装好的一瞬间弹出来，像是刚发生的事，其实是几小时前的提醒
    if (at.getTime() <= now.getTime()) continue

    const names = bucket.names
    const head = names.slice(0, 3).join('、')
    const more = names.length > 3 ? ` 等 ${names.length} 样` : ''
    out.push({
      id: reminderIdOf(`expiry:${day}`),
      at,
      title: bucket.expired > 0 ? `冰箱里有 ${names.length} 样该处理了` : `冰箱里有 ${names.length} 样今天到期`,
      body: bucket.expired > 0 ? `${head}${more}（${bucket.expired} 样已经过期）` : `${head}${more}`,
      to: '/fridge',
      kind: 'expiry',
    })
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/**
 * 全部要排的（已按时刻排好）。
 *
 * **同一时刻多条、id 撞了怎么办**：这里不去重——`reminderIdOf` 是 31 位，
 * 真实数据里几条提醒撞上的概率可以忽略；真撞了的表现是"少一条提醒"，
 * 而**多一条**（编号错开）才是更坏的：整批替换时会留下一条指向不存在内容的提醒。
 * 由测试钉住"不同键得到不同 id"这条性质。
 */
export function planLocalReminders(
  input: {
    /** 菜单安排：每天每餐一行（`/orders/plan` 的形状） */
    plan: { day: string; meals: MealProgressRow[] }[]
    /** 冰箱条目（`/fridge` 的四个区摊平） */
    fridge: FridgeItem[]
  },
  now: Date = new Date(),
): LocalReminder[] {
  return [...cookReminders(input.plan, now), ...expiryReminders(input.fridge, now)].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id,
  )
}
