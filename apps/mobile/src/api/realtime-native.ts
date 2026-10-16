import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * 原生实时连接的**手机侧接线**（F10-08）。
 *
 * ## 它是什么
 *
 * 应用在前台时，WebView 里那条连接（`lib/realtime-sync.ts`）就够了——毫秒级。
 * 但 WebView 的 JS **退到后台约 40 秒就被系统冻住**（实测，见 D-081），
 * 冻住之后那条连接虽然 TCP 上还开着、**回调却不会执行**，于是"家里刚发生的事"
 * 要等到下一次巡查（最多约一刻钟）。
 *
 * 用户 2026-10-16 明确要的是实时（「另一台同家庭的设备要立马收到」）。
 * 答案就是让**连接活在 WebView 之外**：一个 Android 前台服务里的 OkHttp WebSocket
 * （`RealtimeService.java`），它不受 WebView 冻不冻的影响。
 *
 * | 应用状态 | 谁在盯着 | 延迟 |
 * | --- | --- | --- |
 * | 前台 | WebView 那条 | 毫秒 |
 * | 后台（WebView 已冻） | **原生那条** | 毫秒 |
 * | 进程被杀 | 系统的调度器 | 最多约一刻钟 |
 *
 * ## 浏览器里这些方法不存在
 *
 * `RealtimeNative` 是**本项目自己的** Android 插件（不是 npm 包），所以：
 * - 浏览器 / iOS 上**根本没有这个插件**，调用会抛 "not implemented"。
 *   这里用 `Capacitor.getPlatform() === 'android'` 先挡一道，
 *   与交付二/三同一条口径（不给"看着像能行、其实不会响"的东西）；
 * - 所以 `start/stop/status` 在浏览器里是**明确的三条空实现**，而不是 try/catch 之后假装成功。
 */

interface RealtimeNativePlugin {
  start(options: { token: string; apiBase: string; userId: string }): Promise<{ running: boolean }>
  stop(): Promise<{ running: boolean }>
  status(): Promise<{ running: boolean }>
}

const RealtimeNative = registerPlugin<RealtimeNativePlugin>('RealtimeNative')

/** 装到 Android 手机上才有原生那条路（浏览器与 iOS 没有） */
export function nativeSupported(): boolean {
  return Capacitor.getPlatform() === 'android'
}

/**
 * 启动原生那条连接。
 *
 * **失败不抛**：它只是"更快"的那一半——就算它起不来（系统不给前台服务、插件没装上），
 * 前台有 WebView 那条、后台有巡查那条，功能都在，只是慢一点。
 * 把失败抛出去会让登录流程跟着报错，那是本末倒置。
 */
export async function startNativeLink(options: { token: string; apiBase: string; userId: string }): Promise<boolean> {
  if (!nativeSupported()) return false
  try {
    const result = await RealtimeNative.start(options)
    return Boolean(result?.running)
  } catch {
    return false
  }
}

/** 停手（退出登录时调）：这台手机从此不再靠原生那条收（与巡查令牌一并交还） */
export async function stopNativeLink(): Promise<void> {
  if (!nativeSupported()) return
  try {
    await RealtimeNative.stop()
  } catch {
    // 没在跑的时候停一次也无所谓；插件缺失同样忽略（见文件头）
  }
}

/** 现在是不是靠原生那条连着（「我的」页那行现状要如实说，别让用户猜） */
export async function nativeLinkRunning(): Promise<boolean> {
  if (!nativeSupported()) return false
  try {
    const result = await RealtimeNative.status()
    return Boolean(result?.running)
  } catch {
    return false
  }
}

/** 后端地址（原生那条也要它——它不含任何前端构建产物，拿不到 import.meta.env） */
export function apiBaseUrl(): string | null {
  const base = import.meta.env.VITE_API_BASE_URL
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : null
}
