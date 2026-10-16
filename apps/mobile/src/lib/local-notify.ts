import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { pendingSummary } from './local-notify.rules'
import type { LocalReminder, NotifyStatus } from './local-notify.rules'

/**
 * 本机通知的原生调用层（M10 交付二）。**排什么**的判定全在 `local-notify.rules.ts`。
 *
 * ## 只在装到手机上的那版里做事
 *
 * 浏览器里"排一条 11 点的提醒"是**做不到**的：页面一关就没有任何东西会响。
 * 插件的 Web 实现只能用 `setTimeout` 顶一会儿，页面关掉就没了——那会变成
 * "我明明看到它说排上了，到点却没响"，比没有这个功能更糟。
 * 所以 `isSupported()` 在浏览器里一律 false，界面上如实说"装到手机上才有"。
 *
 * ## 默认开启、不给开关（用户 2026-10-14）
 *
 * 原话：「手机上的弹窗提醒要开启啊，这个是默认的，不用设置……删掉这块配置」。
 * 所以这里**没有开关**：登录后如果系统还没问过通知权限，`useLocalNotifySync()`
 * 会自动问一次（`prompt` 表示从没问过；问过被拒之后系统不会再弹第二次，
 * 那种情况只剩界面上的引导）。
 *
 * ## 排程是整批替换
 *
 * `cancelAll()` 再排一遍。取消掉的那一餐、从冰箱删掉的那样东西，提醒随之消失
 * （见规则文件头）。
 */

/** 装到手机上才有（浏览器里没有"关掉页面还能响"这件事） */
export function isSupported(): boolean {
  return Capacitor.isNativePlatform()
}

/** 当前权限：'granted' | 'denied' | 'prompt'；不支持时是 'unsupported' */
export type NotifyPermission = 'granted' | 'denied' | 'prompt' | 'unsupported'

/** 读权限**不问**用户（问的是 `requestPermission`） */
export async function permissionState(): Promise<NotifyPermission> {
  if (!isSupported()) return 'unsupported'
  try {
    const status = await LocalNotifications.checkPermissions()
    return status.display === 'granted' ? 'granted' : status.display === 'denied' ? 'denied' : 'prompt'
  } catch {
    // 插件调用失败（壳版本旧、系统受限）不该让界面炸掉：当成"还没同意"，
    // 让用户点一下再走一次请求，那时错误会回到界面上
    return 'prompt'
  }
}

/**
 * 请求权限。
 *
 * **谁调**：`useLocalNotifySync()` 在"从没问过"（`prompt`）时自动调一次（默认开启，
 * 用户 2026-10-14 定的）；界面上的引导文案不触发它——被拒过之后系统根本不会再弹框，
 * 那时唯一的出路是去系统设置里打开。
 *
 * 精确闹钟（Android 12+）是另一层权限，这里**不用**：见下面 `INEXACT`。
 */
export async function requestPermission(): Promise<NotifyPermission> {
  if (!isSupported()) return 'unsupported'
  const status = await LocalNotifications.requestPermissions()
  return status.display === 'granted' ? 'granted' : 'denied'
}

/**
 * 排程时**一律标成不精确**（`isExactNotification: false`）。
 *
 * 这不是省事，是用户 2026-10-14 明确要求的：「这个是默认的，不用设置」。
 * Android 12+ 的"精确闹钟"是个需要用户在系统设置里单独开的权限，而插件的默认行为是
 * **排程时自己拉起那个设置页**——那正是"我什么都没点，怎么跳到设置里去了"。
 * 标成不精确之后插件不再问，代价是可能晚几分钟到半小时（系统挑时机）。
 * 对"到点该做饭"这件事完全可以接受：提醒本来就提前一小时，留了余量。
 */
const INEXACT = { isExactNotification: false } as const

/**
 * 本文件的提醒排在哪个通知渠道（Android 8+）。
 *
 * ## 为什么必须显式指定（2026-10-16）
 *
 * 不指定时插件会把它落到自己那个叫 `default` 的渠道上——而那个渠道在系统设置里的
 * **名字**就是 "Default"、说明栏是空的。vivo 开放平台那条要求是"把所有**正在使用的
 * 本地通知渠道**登记备案"，一个叫 "Default" 的渠道根本说不清它发什么；
 * 用户到系统设置里看到它也不知道该不该关。
 *
 * 所以：本文件的提醒（到点做饭、东西快过期）走 `meal_reminders`（"做饭与到期提醒"），
 * "别人做了什么"那类走 `family_events`（"家里的事"）——两个渠道由
 * `android/app/src/main/java/com/yushan/cook/NotifyChannels.java` **一处建齐**，
 * 这里只引用它的 id。
 *
 * ## 名字为什么写死在这里
 *
 * 渠道 id 是一个**跨语言约定**（Java 侧建、JS 侧用），与 `capacitor.config.ts` 里那个
 * runner label、后端的 `REALTIME_PATH` 是同一类东西。多一层"从原生读回来"不会让它更安全，
 * 只会多一个能坏的地方。**这两处必须一致**（改一处就要改另一处）。
 */
const MEAL_REMINDERS_CHANNEL = 'meal_reminders'

/**
 * 整批重排（先撤掉旧的，再排新的）。
 *
 * 调用方负责：**只在权限已给时调用**（否则插件会自己弹权限框）。
 * 返回排上了几条，便于测试与排查。
 */
export async function rescheduleAll(reminders: LocalReminder[]): Promise<number> {
  if (!isSupported()) return 0
  await LocalNotifications.cancelAll()
  if (reminders.length === 0) return 0

  await LocalNotifications.schedule({
    notifications: reminders.map((reminder) => ({
      id: reminder.id,
      title: reminder.title,
      // 插件的 `body` 是必填 string：没有第二句时给空串（通知栏只显示标题那一行）
      body: reminder.body ?? '',
      // 落到「做饭与到期提醒」那个渠道（不写就会掉进插件的 default，见上面那段）
      channelId: MEAL_REMINDERS_CHANNEL,
      schedule: { at: reminder.at, allowWhileIdle: true },
      ...INEXACT,
      // 点开跳到哪儿（`localNotificationActionPerformed` 里读回来）
      extra: { to: reminder.to },
      /*
       * 点一下就把它从通知栏收走。**默认是 false**（通知留在栏里直到用户划掉），
       * 而这里是"该做饭了""有东西到期了"这种**一次性的事**：点开去做就完了，
       * 留着只是攒一堆过期提醒。
       */
      autoCancel: true,
    })),
  })
  return reminders.length
}

/**
 * 「要权限（没问过就问一次）→ 按这批提醒重排」——界面与外壳都只调这一个入口。
 *
 * `reminders` 传 `undefined` 表示"只要把权限要一下、先别排"（启动时用）。
 *
 * 三种情况分开处理，**都不弹系统设置页**：
 * - `prompt`（从没问过）→ 什么都不做，返回 `prompt` 让调用方去 `requestPermission()`；
 * - `granted` → 排；
 * - `denied`（问过被拒）→ 一条都不排，也不反复问（系统也不会再弹）。
 */
export async function syncScheduled(reminders: LocalReminder[] | undefined): Promise<NotifyPermission> {
  if (!isSupported()) return 'unsupported'
  if (reminders === undefined) return permissionState()
  const permission = await permissionState()
  if (permission !== 'granted') return permission
  await rescheduleAll(reminders)
  return permission
}

/** 全部取消（退出登录时清干净：这些提醒里带着"这家今天吃什么"） */
export async function cancelAll(): Promise<void> {
  if (!isSupported()) return
  await LocalNotifications.cancelAll()
}

/** 点了一条本机通知之后要去哪儿（拿不到就给 null，界面回退到通知中心） */
export function targetOf(extra: unknown): string | null {
  const to = (extra as { to?: unknown } | null)?.to
  return typeof to === 'string' && to.startsWith('/') ? to : null
}

/**
 * 读一次本机提醒的现状：**权限 + 已排几条 + 最近一条**。
 *
 * 为什么值得有：用户 2026-10-15 报「真机也没收到通知」——而"没收到"这件事
 * 在界面上**完全看不出来**（是没排上？权限没给？还是本来就没有要提醒的事？），
 * 与 `RISKS.md` R-66 那一族（分不出"做成了"与"看着做成了"）是同一类问题。
 * 这个函数把三件事一次性读出来，界面照着说人话（文案见 `notifyStatusText`）。
 *
 * 任何一步失败都**当成"读不出来"**（pending 0 / next null），不抛：
 * 它只是"我的"页上的一行说明，读不到不该把整页弄崩。
 */
export async function readNotifyStatus(): Promise<NotifyStatus> {
  const permission = await permissionState()
  if (permission !== 'granted') return { permission, pending: 0, next: null }
  try {
    const list = await LocalNotifications.getPending()
    /*
     * "条数 + 最近一条"这点判断放在纯规则里（`pendingSummary`）：原生桥回来的
     * `schedule.at` 是**字符串**不是 `Date`（实测见那边的说明），这种平台细节要能单测，
     * 埋在接线层里就只能靠真机去撞。
     */
    return { permission, ...pendingSummary(list.notifications) }
  } catch {
    return { permission, pending: 0, next: null }
  }
}
