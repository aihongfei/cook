/**
 * 巡查（手机后台取提醒）的**纯规则**（M10 交付三）。
 *
 * ## 这一层解决什么
 *
 * 手机在后台被系统唤醒一次，要回答三个问题：
 * ① **我手里拿的是哪一条**（令牌有效吗）；② **哪些是"新"的、要弹给用户**；
 * ③ **弹过之后别再弹**。前一条是鉴权（在 service 里），后两条在这里，
 * 因为它们全是"比较两个时刻/两个集合"，不碰库、不碰 HTTP——能单测。
 *
 * ## "新"的定义：**取过之后又发生的事**
 *
 * 手机每次巡查都会带回"我上次取到哪儿了"（`since`）。这里只挑 `at > since` 的那些。
 * 用**时刻**而不是"已读状态"：已读是用户在通知中心里的动作，与"手机上弹过没有"是两件事
 * ——用户可能扫一眼通知栏就划掉了，那条在通知中心里仍然是未读（他确实没点进去看）。
 * 若按已读判，同一条会**每 15 分钟弹一次**，直到他终于进应用点开它。
 *
 * ⚠️ 一台手机只记一个 `since`（不是每条一个已弹标记）：这是刻意的取舍。
 * 多台手机各自记自己的，互不影响；同一台手机换了账号则 `since` 随账号一起清掉
 * （见前端 `patrol-sync`）。代价是"先弹过的 A 条"之后如果又来了更早时刻的 B 条
 * （比如服务器时间回拨），B 会被漏掉——本项目所有 `at` 都来自服务端时钟，
 * 回拨的后果远小于"每 15 分钟重复弹一遍"。
 */

/** 一条要弹出来的提醒（= 通知中心那一条，原样带过去 + 手机要用的数字 id） */
export interface PatrolItem {
  /** 稳定 id（与通知中心同一套：`plan:<mealKey>`） */
  id: string
  /** 后端拼好的那句话（前端不重拼，与通知中心同一条规矩） */
  title: string
  body: string | null
  /** 点开去哪（应用内路径） */
  to: string
  /** 事件时刻（ISO）——手机用它推进 `since` */
  at: string
  /** 小标（"选好了""做好了"…） */
  tag: string
  /**
   * 系统通知要的数字 id（插件与 Android 都要数字）。
   *
   * **为什么由后端算**：那段后台代码跑在一个**极简的 JS 引擎**里（没有我们的前端模块，
   * 也 import 不了 `lib/local-notify.rules`）。若让它在那边再算一遍 FNV-1a，
   * 就成了"同一个 id 两处各算一遍"——本项目在"键各拼一遍"上栽过两次（D-078 四）。
   * 所以这里算好发过去，那一段代码只管用。
   */
  notifyId: number
}

/**
 * 字符串键 → 系统通知的数字 id。
 *
 * FNV-1a 折成 **31 位正整数**，与前端 `lib/local-notify.rules` 的 `reminderIdOf` 同一套
 * （那边给本机算出来的提醒用）。取正数：插件内部当 `Int`，负数在某些机型上会被当成另一个 id。
 *
 * 两处**必须同值**（同一件事在两条路径上弹出来得是同一个 id，否则会并排出现两条）——
 * 这就是上面说的"由后端算好给前端"的理由；前端那份保留是因为它的输入（菜单/冰箱数据）
 * 本来就在手机本地、不经过服务端。
 */
export function notifyIdOf(key: string): number {
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 1
}

/**
 * 该弹哪些：`since` 之后出现的那些，**最多 `limit` 条**。
 *
 * 上限是为了"别一次刷一屏"：手机被唤醒时可能积了十几条（关了三天应用），
 * 全部弹出来会把通知栏占满，用户只会全部划掉。取**最新的 limit 条**
 * （按 `at` 倒序），其余仍然在应用内的通知中心里等着他——不丢，只是不弹。
 *
 * `since` 为 null（第一次巡查、或换了账号）时**一条都不弹**：
 * 那种情况下的"新"是伪新（十几条历史会一次性糊到用户脸上），
 * 而且用户此刻刚登录/刚装完，本来就在看着应用。
 */
export function pickPatrolItems<T extends { at: string }>(items: T[], since: Date | null, limit: number): T[] {
  if (!since) return []
  const cutoff = since.getTime()
  return items
    .filter((item) => {
      const at = Date.parse(item.at)
      return Number.isFinite(at) && at > cutoff
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, Math.max(0, limit))
}

/**
 * 手机下次该带的 `since`：**这次取到的最大 `at`**，没有新的就保持原值。
 *
 * 为什么不直接用"现在"：手机与服务端的时钟可能差几分钟（也不该被信任）。
 * 用服务端返回的 `at` 推进，比较的两侧就都来自服务端时钟，
 * 判断"新不新"不会因为手机快了几分钟而漏掉一条。
 */
export function nextSince(items: { at: string }[], previous: Date | null): Date | null {
  let latest = previous ? previous.getTime() : null
  for (const item of items) {
    const at = Date.parse(item.at)
    if (!Number.isFinite(at)) continue
    if (latest === null || at > latest) latest = at
  }
  return latest === null ? null : new Date(latest)
}

/** 一次巡查最多弹几条（见 `pickPatrolItems` 的说明） */
export const PATROL_MAX_ITEMS = 3
