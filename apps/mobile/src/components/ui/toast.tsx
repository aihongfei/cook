import { create } from 'zustand'
import './ui.scss'

/**
 * 共用 toast（F0-05 的统一反馈）。
 *
 * 为什么自己做而不是用组件库的：手绘风里"系统样式"的提示很跳（直角、冷灰、投影生硬），
 * 这里用与页面同一套 token（纸色卡片 + 手绘描边 + 暖色墨字），看起来像贴在屏幕上的小纸条。
 *
 * 用法：`toast.success('邀请码已复制')` / `toast.error('这个操作需要更高的家庭角色')`
 * 需要在应用根部挂一次 `<Toaster />`（见 main.tsx）。
 */

export type ToastTone = 'success' | 'error'

interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

interface ToastState {
  items: ToastItem[]
  push: (text: string, tone: ToastTone) => void
  dismiss: (id: number) => void
}

/** 成功提示看一眼就够；错误要留久一点，让用户读得完 */
const DURATION: Record<ToastTone, number> = { success: 2200, error: 3600 }

let nextId = 0

export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push: (text, tone) => {
    const id = (nextId += 1)
    // 同一条文案不重复堆叠（连点两下"复制"只提示一次）
    const items = get().items.filter((item) => item.text !== text)
    set({ items: [...items, { id, text, tone }] })
    setTimeout(() => get().dismiss(id), DURATION[tone])
  },
  dismiss: (id) => set({ items: get().items.filter((item) => item.id !== id) }),
}))

export const toast = {
  success: (text: string) => useToasts.getState().push(text, 'success'),
  error: (text: string) => useToasts.getState().push(text, 'error'),
}

/** 挂在应用根部（main.tsx）一次即可 */
export function Toaster() {
  const items = useToasts((state) => state.items)
  const dismiss = useToasts((state) => state.dismiss)

  // 空的时候不渲染容器：避免一个透明的固定层长期挂在页面底部
  if (items.length === 0) return null

  return (
    <div className="toaster" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={`toast toast--${item.tone}`}
          role={item.tone === 'error' ? 'alert' : 'status'}
          onClick={() => dismiss(item.id)}
        >
          <span className="toast__mark" aria-hidden="true">
            {item.tone === 'error' ? '!' : '✓'}
          </span>
          <span className="toast__text">{item.text}</span>
        </div>
      ))}
    </div>
  )
}
