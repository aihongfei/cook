import { Dialog, Toast } from 'antd-mobile'

/**
 * 统一反馈（F0-05）：基于 antd-mobile，避免各处自己拼提示。
 * 后续如需统一品牌色，在 ui.scss 里覆盖 antd-mobile 的 CSS 变量即可。
 */
export function toast(content: string) {
  Toast.show({ content, position: 'center' })
}

export function toastSuccess(content: string) {
  Toast.show({ content, position: 'center', icon: 'success' })
}

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
