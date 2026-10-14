import { Capacitor } from '@capacitor/core'
import { apiClient } from './client'

/**
 * 巡查（后台取提醒）的**手机侧**（M10 交付三）。
 *
 * ## 它是什么
 *
 * 交付一（应用内红点）与交付二（本机算得出来的提醒）都做完了，但**"别人刚做了什么"
 * 这类事仍然只有打开应用才看得到**。这一交付补上"应用在后台（或刚被杀掉）时也能收到"。
 *
 * ## 为什么不能靠应用自己定时去问（关键事实）
 *
 * 实测过：应用退到后台 **约 40 秒后 WebView 里的 JS 就完全不执行了**
 * （探针每 20 秒记一次，后台只记到第一次；拉回前台立刻恢复）。
 * 所以"前台定时器 + 后台继续跑"这条路在 Android 上根本不成立——
 * 必须把那段逻辑交给**系统的调度器**（WorkManager，见 `patrol-runner`）。
 *
 * ## 三样东西分工明确
 *
 * - **巡查令牌**（这里管）：长期、只读、不轮换的后台凭据。为什么不能借用登录令牌，
 *   见后端 `schema.prisma` 里 `NotificationPatrolToken` 那段说明（一句话：
 *   刷新令牌一用就轮换，后台拿它续期会把用户当场登出）；
 * - **上次取到哪儿**（`since`）：存在手机的 KV 里，按账号记——换账号就重新立水位线；
 * - **那段跑在系统调度器里的 JS**（`public/runners/patrol.js`）：拿上面两样去问后端，
 *   有新的就弹本机通知。它**跑在任何页面之外**，所以不能 import 这个文件里的东西
 *   （那正是它自己带一小份逻辑、而不是复用前端模块的原因）。
 *
 * ## 只在装到手机上时做事
 *
 * 浏览器里没有"应用在后台被系统唤起"这回事，所以这一整套在浏览器里是空转的
 * （与交付二同一条口径：不给"看着像能行、其实不会响"的东西）。
 */

/** 巡查令牌存在这儿（按设备一份，**不**跟着账号走：换账号要留着设备身份去换令牌） */
const DEVICE_KEY = 'yushan-patrol-device'
/** 水位线（上次取到哪儿）——按账号记，见文件头 */
const sinceKeyOf = (userId: string) => `yushan-patrol-since:${userId}`

/**
 * 这台手机的稳定标识。
 *
 * 它**不是**硬件信息（不碰 IMEI 之类），就是本地生成的一个随机串：
 * 后端按 `[userId, deviceId]` 一行记令牌，于是**同一台手机重登不会顶掉家里另一台**
 * （第一版按账号唯一，那会让第二台一登录就把第一台静默废掉）。
 * 卸载重装会换一个新的——代价只是多一行记录，没有别的后果。
 */
export function deviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY)
  if (existing) return existing
  const fresh = `dev_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
  localStorage.setItem(DEVICE_KEY, fresh)
  return fresh
}

/** 手机名（只给排查用；能随便改，不参与鉴权） */
export function deviceName(): string {
  const platform = Capacitor.getPlatform()
  return platform === 'android' ? 'Android 手机' : platform
}

/** 上次取到哪儿（没有就是 null = 第一次巡查，那时一条都不弹） */
export function readSince(userId: string): string | null {
  return localStorage.getItem(sinceKeyOf(userId))
}

/** 记下这次取到哪儿 */
export function writeSince(userId: string, since: string | null): void {
  if (since) localStorage.setItem(sinceKeyOf(userId), since)
}

/** 换账号/退出时清掉水位线（下一个账号从"第一次"开始，不会把别人的旧事当新的弹） */
export function clearSince(userId: string): void {
  localStorage.removeItem(sinceKeyOf(userId))
}

/**
 * 领一枚巡查令牌（**凭登录态领**，所以只在登录后调）。
 *
 * 每次登录/启动都领一枚新的、把这一台的那行换掉（`upsert` 按 userId+deviceId）：
 * 这样"换了账号"或"令牌过期了"都自然修好，不需要在别处判断"我手里这枚还能用吗"。
 */
export async function fetchPatrolToken(): Promise<string> {
  const { data } = await apiClient.post<{ token: string; expiresAt: string }>('/notifications/patrol/token', {
    deviceId: deviceId(),
    device: deviceName(),
  })
  return data.token
}

/** 交还令牌（退出登录时调）：这一台从此取不到提醒（家里的另一台不受影响） */
export async function revokePatrolToken(): Promise<void> {
  await apiClient.delete(`/notifications/patrol/token?deviceId=${encodeURIComponent(deviceId())}`)
}
