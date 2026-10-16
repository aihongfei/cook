import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * 返回手势的**原生侧接线**（D-109）。
 *
 * `BackGesture` 是**本项目自己的** Android 插件（不是 npm 包，源码在
 * `android/app/src/main/java/com/yushan/cook/BackGesturePlugin.java`），
 * 与 `RealtimeNative` 同一族做法：浏览器 / iOS 上根本没有这个插件。
 *
 * 它送四件事过来（`kind`）：`start` / `progress` / `cancel` / `press`。
 * 前三件是**手势过程**（只有 Android 14+ 有，低版本没有它们），
 * 第四件是**松手/按实体键**（全版本都有）——判定与动作都在网页这一侧，
 * 原生那边只负责如实转发与"听网页的话决定接不接管"。
 */

export type BackGestureKind = 'start' | 'progress' | 'cancel' | 'press'

export interface BackGestureEvent {
  kind: BackGestureKind
  /** 拖动进度 0→1（只有 `progress` 有；`start` 上可能是 0） */
  progress?: number
  /** 触点（排查用，不参与计算） */
  touchX?: number
  touchY?: number
  /** 从哪条边起手：0 左边 / 1 右边 / 2 都不是（`BackEventCompat.EDGE_*`） */
  edge?: number
}

interface BackGesturePlugin {
  setEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>
  isEnabled(): Promise<{ enabled: boolean }>
  addListener(
    eventName: 'backGestureProgress',
    listener: (event: BackGestureEvent) => void,
  ): Promise<PluginListenerHandle>
}

const BackGesture = registerPlugin<BackGesturePlugin>('BackGesture')

/** 这台设备上有没有原生那条路（浏览器与 iOS 没有） */
export function backGestureSupported(): boolean {
  return Capacitor.getPlatform() === 'android'
}

/**
 * 告诉原生"这次返回归我们"或"放手"。
 *
 * **放手很重要**：在厨房根页把 `enabled` 关掉，放手那一刻就是**系统**在处理——
 * 于是系统自带的预测式退出预览（窗口缩回桌面）真的会出现，那是最"原生"的那种退出。
 *
 * @returns 原生真的收到了吗。**这个返回值有实际用途**：插件在启动早期可能还没挂上
 *   （`main.tsx` 那行与 bridge 初始化之间存在窗口），那次调用会落空——
 *   调用方据此把"已同步"的记号抹掉、下次重试（见 `lib/back-gesture` 的 `syncBackGesture`）。
 */
export async function setBackGestureEnabled(enabled: boolean): Promise<boolean> {
  if (!backGestureSupported()) return false
  try {
    await BackGesture.setEnabled({ enabled })
    return true
  } catch {
    // 插件缺失/还没就绪：见文件头，不外抛；由调用方决定要不要重试
    return false
  }
}

/** 现在归不归我们管（排查用） */
export async function backGestureEnabled(): Promise<boolean> {
  if (!backGestureSupported()) return false
  try {
    const result = await BackGesture.isEnabled()
    return Boolean(result?.enabled)
  } catch {
    return false
  }
}

/** 订阅手势事件。返回值是取消订阅（浏览器里返回一个空的取消函数） */
export async function onBackGesture(
  handler: (event: BackGestureEvent) => void,
): Promise<() => void> {
  if (!backGestureSupported()) return () => {}
  try {
    const handle = await BackGesture.addListener('backGestureProgress', handler)
    return () => void handle.remove()
  } catch {
    return () => {}
  }
}
