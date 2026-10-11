import { Popup } from 'antd-mobile'
import type { PropsWithChildren } from 'react'

interface BottomSheetProps {
  visible: boolean
  title?: string
  /** 高度，默认自适应内容 */
  height?: string
  onClose: () => void
}

/** 底部抽屉（F0-05）：封装 antd-mobile Popup，统一圆角与配色 */
export default function BottomSheet({
  visible,
  title,
  height,
  onClose,
  children,
}: PropsWithChildren<BottomSheetProps>) {
  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      onClose={onClose}
      destroyOnClose
      bodyStyle={{
        height,
        padding: '18px 16px calc(20px + var(--safe-bottom))',
        background: 'var(--color-paper)',
        borderTopLeftRadius: '22px',
        borderTopRightRadius: '22px',
      }}
    >
      {title && <div className="sheet__title">{title}</div>}
      <div className="sheet__body">{children}</div>
    </Popup>
  )
}
