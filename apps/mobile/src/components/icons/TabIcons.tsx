import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function KitchenIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11 12 4l8 7" />
      <path d="M6 10.5V20h12v-9.5" />
      <path d="M10 20v-5h4v5" />
    </svg>
  )
}

export function OrderIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4.5" y="3.5" width="15" height="17" rx="3" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </svg>
  )
}

export function DiscoverIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5l1.8 4.4 4.4 1.8-4.4 1.8L12 15.9l-1.8-4.4-4.4-1.8 4.4-1.8z" />
      <path d="M18 16l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </svg>
  )
}

export function FridgeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="6" y="2.8" width="12" height="18.4" rx="3" />
      <path d="M6 10h12" />
      <path d="M9 6v1.6M9 13v2" />
    </svg>
  )
}

export function MineIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="8.6" r="3.9" />
      <path d="M4.6 20.6c1.4-3.6 4.1-5.2 7.4-5.2s6 1.6 7.4 5.2" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.4} {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.4 15.4 21 21" />
    </svg>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.2} {...props}>
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  )
}

/** 底部导航两角的手绘小枝（右侧用 CSS 镜像） */
export function LeafSprig(props: IconProps) {
  return (
    <svg
      width={26}
      height={24}
      viewBox="0 0 26 24"
      fill="none"
      stroke="#9FB183"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3.4 22.2C7.4 18 9.9 11.6 10.2 3.4" />
      <path d="M10 6.2c1.9-1.7 4.2-1.6 5.3.2-1.7 1.5-4 1.6-5.3-.2z" fill="#C6D3AC" />
      <path d="M8.9 10.8c-1.9-1.7-4.2-1.6-5.3.2 1.7 1.5 4 1.6 5.3-.2z" fill="#C6D3AC" />
      <path d="M7.6 15.4c1.9-1.6 4.1-1.4 5.2.4-1.7 1.4-3.9 1.5-5.2-.4z" fill="#C6D3AC" />
    </svg>
  )
}
