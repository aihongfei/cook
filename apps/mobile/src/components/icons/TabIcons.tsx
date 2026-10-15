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

/**
 * 拍照与相册。
 *
 * 这两个与底部的导航图标不是一回事，但同一套线描语言（同一个 `base`），
 * 所以留在这个文件里而不是另开一份——它们都只是"一个 24×24 的描边图形"。
 */
export function CameraIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="7.2" width="18" height="12.6" rx="3.2" />
      <path d="M9 7.2l1.3-2.3h3.4L15 7.2" />
      <circle cx="12" cy="13.4" r="3.5" />
    </svg>
  )
}

/** 相册：一张画着太阳与山的方图（比"文件夹"更贴近"从相册选一张照片"） */
export function AlbumIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="4.6" width="18" height="14.8" rx="3.2" />
      <circle cx="8.6" cy="9.8" r="1.6" />
      <path d="M4.2 17.4l4.4-4.1 3.2 2.9 3-2.4 4.8 3.6" />
    </svg>
  )
}

/**
 * 加号。
 *
 * ⚠️ **为什么不用文字 `＋`**（用户 2026-10-13：「这个加号没有居中」）：
 * 那是全角 `＋`（U+FF0B），墨迹只占字形的一个小数——实测量出来它比圆钮中心
 * **偏左 3.7px、偏下 2.7px**（字体自带的基线与边距，`align-items:center` 治不了）。
 * 描边图形是几何作图，中心就是中心；顺带在 38px 的钮里也比一个字更利落。
 */
export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.2} {...props}>
      <path d="M12 5.4v13.2M5.4 12h13.2" />
    </svg>
  )
}

/**
 * 关闭 / 去掉一个的「×」。
 *
 * ⚠️ 与 `PlusIcon` 同一个理由（用户 2026-10-13：「叉号没有居中」）：文字 `×`（U+00D7）
 * 的墨迹也不在字形框中心——实测在 38px 的圆钮里**偏下 3.4px**。
 * 凡是"一颗按钮上只有一个叉"的地方都用这个，尺寸交给 `width`/`height`。
 */
/**
 * 「多选」（订单页筛选行最右那颗）。画的是"方框里一个对勾"——
 * 用户 2026-10-15 要求这一处**用图标**（原来是一枚写着"多选"的文字胶囊）。
 *
 * 为什么是矢量而不是文字符号（`☑`/`▣` 这类）：本项目已经踩过两次——
 * 文字字形的度量不居中，`＋` 实测偏左 3.7px / 偏下 2.7px、`×` 偏下 3.4px（见 D-056 与 CloseIcon 的说明）。
 * 描边的方框 + 对勾在 20px 上是几何居中，且能用 `currentColor` 跟着文字色走。
 */
export function SelectIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.4" />
      <path d="M8 12.2l2.8 2.8L16.4 9.4" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} strokeWidth={2.3} {...props}>
      <path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />
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
