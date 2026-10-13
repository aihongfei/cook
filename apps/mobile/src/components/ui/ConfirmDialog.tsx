import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { registerBackCloser } from '@/lib/android-back'
import './ui.scss'

/**
 * 共用确认弹窗（模态框）。
 *
 * 用于**不可逆或影响别人的操作**：退出/解散家庭、移出成员、转让掌勺人。
 * 几处刻意的选择：
 * - 屏幕居中 + 遮罩：弹窗是"必须回应才能继续"的东西，居中比贴在底部更能让人停下来看一眼；
 * - 遮罩点击与 Esc 都算**取消**（永远不会因为误触而确认）；
 * - 打开时焦点落在「取消」上（键盘用户连按回车不会误删）；
 * - 危险操作的确认键用砖红色，和普通确认区分开。
 *
 * 用法：
 * ```tsx
 * <ConfirmDialog
 *   open={Boolean(pending)}
 *   title="移出成员"
 *   message="把小满移出家庭？他需要重新用邀请码才能回来。"
 *   confirmText="移出"
 *   tone="danger"
 *   onCancel={() => setPending(null)}
 *   onConfirm={doIt}
 * />
 * ```
 */

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  /** 确认键文案，默认「确定」 */
  confirmText?: string
  /** 取消键文案，默认「取消」 */
  cancelText?: string
  /** danger：砖红确认键，用于删除/移出/退出这类不可逆操作 */
  tone?: 'normal' | 'danger'
  /** 请求进行中：两个键都禁用，避免重复提交 */
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  tone = 'normal',
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // 打开时锁住背景滚动：否则在弹窗上滑动会把下面的页面滚走
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // 焦点默认给「取消」：危险操作不该一键回车就执行
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, pending, onCancel])

  /*
   * 系统返回键（安卓）等同按「取消」（F14-01 / R-13 ①）：与 Esc 同一条语义——
   * 确认框是"必须回应才能继续"的一层，按返回该先关它，而不是把背后的页面一起带走。
   * 执行中（pending）不登记：那会儿 Esc 也不响应，返回键更不该让用户以为"取消掉了"。
   */
  useEffect(() => {
    if (!open || pending) return
    return registerBackCloser(onCancel)
  }, [open, pending, onCancel])

  if (!open) return null

  // 用 portal 挂到 body：页面容器可能有 transform/overflow，会让 fixed 定位跑偏或被裁掉
  return createPortal(
    <div
      className="confirm-mask"
      onClick={() => {
        if (!pending) onCancel()
      }}
    >
      <div
        className="confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        // 点卡片本身不该关掉弹窗，只有点遮罩才算取消
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm__title" id="confirm-title">
          {title}
        </div>
        <div className="confirm__message" id="confirm-message">
          {message}
        </div>
        <div className="confirm__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm__btn"
            disabled={pending}
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            type="button"
            /* 数组拼接而非模板字符串：模板里少个空格会把两个类名粘成一个（--primaryconfirm__btn--danger），样式静默失效 */
            className={[
              'confirm__btn',
              'confirm__btn--primary',
              tone === 'danger' && 'confirm__btn--danger',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
