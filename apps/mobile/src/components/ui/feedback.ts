import { Dialog } from 'antd-mobile'

/**
 * 统一反馈（F0-05）：基于 antd-mobile，避免各处自己拼提示。
 * 后续如需统一品牌色，在 ui.scss 里覆盖 antd-mobile 的 CSS 变量即可。
 *
 * 注意：轻提示（成功/失败的一句话）请用 `@/components/ui/toast` 里的 toast —— 那是自己做的
 * 手绘风toast；这里曾包过 antd-mobile 的 Toast，与它重复且样式与页面不搭，已移除。
 */

/** 危险/确认操作，返回 Promise<boolean> */
export async function confirmAction(title: string, content: string): Promise<boolean> {
  const result = await Dialog.confirm({
    title,
    content,
    confirmText: '确定',
    cancelText: '取消',
  })
  return Boolean(result)
}
