import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { useAuth } from '@/stores/auth'
import { clearSince, deviceId, fetchPatrolToken, revokePatrolToken } from '@/api/patrol'
import { startNativeLink, stopNativeLink } from '@/api/realtime-native'

/**
 * 后台巡查的**接线层**（M10 交付三）：什么时候把配置交给那段后台代码。
 *
 * ## 它在做什么（一句话）
 *
 * 登录后领一枚巡查令牌 → 交给跑在系统调度器里的那段 JS（`public/runners/patrol.js`）
 * → 那段代码每隔一段时间自己醒来问后端有没有新事、有就弹通知。
 * 退出登录就把令牌交还（后端吊销 + 本地清掉），那台手机从此取不到提醒。
 *
 * ## 为什么这段接线必须挂在**路由之外**
 *
 * 交付二踩过一次：清理逻辑挂在 `TabLayout` 里，而退出登录会把那个布局卸载，
 * 于是"没登录就清干净"的代码永远不执行（实测：退出后 9 条闹钟还在）。
 * 这一层同理——它要跨登录态活着才看得见"从有到无"的那一刻，
 * 所以挂在 `main.tsx` 的根层（与 `LocalNotifySync` 并列）。
 *
 * ## 配置只能"推"进去（读不回来）
 *
 * 那段代码的存储（`CapacitorKV`）是插件给自己的私有 SharedPreferences，
 * 主应用**读不到**。所以每一次状态变化都要主动 `dispatchEvent` 送一份配置过去，
 * 而不是"改一处、让它自己读"。这也意味着两个方向都要覆盖：
 * 登录/换账号（送新令牌）、退出（送一份没有令牌的，让它停手）。
 */

/** 那段后台代码的 runner 名（与 capacitor.config.ts 里的 label 必须一致） */
export const PATROL_LABEL = 'com.yushan.cook.patrol'
/** 送配置的那个事件名（与 public/runners/patrol.js 里 addEventListener 的一致） */
const CONFIG_EVENT = 'patrolConfig'

/**
 * 后端地址。
 *
 * **必须在构建时就定下来**（那段后台代码没有 `import.meta.env`），
 * 所以与 `apiClient` 用的是同一个环境变量。取不到时返回 null，整件事就不启用——
 * 一个连不到后端的巡查没有任何意义，不如不排。
 */
function apiBase(): string | null {
  const base = import.meta.env.VITE_API_BASE_URL
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : null
}

/**
 * 把一份配置推给后台代码。
 *
 * `token` 传 null 表示"停手"（退出登录时用）。**不抛错**：插件在浏览器里、
 * 或者 runner 没配好时，这里失败不该让登录/退出流程跟着失败。
 */
async function pushConfig(config: { token: string | null; userId: string | null }): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const base = apiBase()
  if (!base) return
  try {
    const { BackgroundRunner } = await import('@capacitor/background-runner')
    await BackgroundRunner.dispatchEvent({
      label: PATROL_LABEL,
      event: CONFIG_EVENT,
      details: { config: { token: config.token, apiBase: base, userId: config.userId } },
    })
  } catch {
    // runner 没装/没配置：后台取提醒这件事不成立，但应用照常用
  }
}

/**
 * 挂载点：`main.tsx` 里放一个（渲染 `null`）。
 *
 * 抽成组件是因为 hook 不能在 `main.tsx` 里直接调；不是为了好看的一层包装。
 */
export function PatrolSync(): null {
  usePatrolSync()
  return null
}

export function usePatrolSync(): void {
  const userId = useAuth((state) => state.user?.id ?? null)

  useEffect(() => {
    if (!userId) {
      // 没登录（含刚退出）：让那段后台代码停手。本地水位线也清掉——
      // 不清的话下一个账号会被上一个人的旧事当成"新的"弹一遍
      void pushConfig({ token: null, userId: null })
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const token = await fetchPatrolToken()
        if (cancelled) return
        await pushConfig({ token, userId })
        /*
         * 同一枚令牌**顺便交给原生那条实时连接**（F10-08）。
         *
         * 必须复用这一枚，不能让它自己再领一次：`issuePatrol` 是 upsert，
         * 再领一次会把这枚换掉，而上面刚推给调度器的那份就成了废的
         * （表现是后台巡查从此 401，且只在"开了实时之后"才出现，很难查）。
         * 所以这个顺序也不能反：先领一次，两边共用。
         *
         * 失败了不影响什么：实时只"更快"，后台巡查与前台都在（见 realtime-native 文件头）。
         */
        const base = apiBase()
        if (base) await startNativeLink({ token, apiBase: base, userId })
      } catch {
        // 领不到（断网/后端没起）：这次不启用后台巡查，下次登录或下次启动会重来
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId])
}

/**
 * 退出登录时调（`api/auth.ts` 的 `logout` 里）：交还令牌 + 清本地水位线 + 停掉原生那条连接。
 *
 * 顺序：**先交还再清会话**（交还需要登录态）。交还不成也要清本地——
 * 那台手机从此不该再弹任何东西（它手里已经没凭据了，后端也吊销了）。
 */
export async function releasePatrol(userId: string): Promise<void> {
  clearSince(userId)
  /*
   * 原生那条连接要先停：它手里那枚令牌马上就会被吊销，而**断开的动作得由我们做**
   * ——不停的话它要等到自己下一次重连失败（最长 60 秒后才试）才知道，那期间
   * 通知栏里那条常驻通知还在，用户以为"退出了还在收家里的事"。
   */
  await stopNativeLink()
  try {
    await revokePatrolToken()
  } catch {
    // 网络不通：令牌会在 30 天后自然过期，不阻塞退出
  }
  await pushConfig({ token: null, userId: null })
}

/** 设备标识的导出（测试与排查用；令牌按"账号 + 设备"分行，见 api/patrol.ts） */
export { deviceId }
