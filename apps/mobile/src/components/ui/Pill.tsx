import type { PropsWithChildren } from 'react'
import './ui.scss'

type PillVariant = 'ok' | 'wait' | 'brand'

interface PillProps {
  variant?: PillVariant
}

/** 小状态胶囊（已确定 / 收集中 / 徽标） */
export default function Pill({ variant = 'brand', children }: PropsWithChildren<PillProps>) {
  return <span className={`pill pill--${variant}`}>{children}</span>
}
