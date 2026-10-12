import CornerArt from './CornerArt'

/**
 * 页面标题区：标题 + 副标题 + 右上角角落插画（用户 2026-10-12：「每个页的右上角都有点空」）。
 *
 * 为什么做成一个组件而不是各页自己摆：**每个页面自己摆一遍，位置迟早会漂**（有的贴边、
 * 有的留白 20px、有的被标题挤下去），而这类装饰一旦不齐，比没有更显乱。这里只有一种摆法：
 * 标题与副标题占左侧固定宽度（`flex: 1`，留出插画的位置），插画绝对定位贴右上。
 *
 * 标题那一行**不用 flex 居中**：标题是多行时插画要在第一行右侧，居中会让它跟着整体垂直居中，
 * 看起来像浮在标题中间。所以用绝对定位 + 给文字留右侧内边距。
 *
 * 页面右上角已有操作按钮时传 `withAction`（插画往左让开）——两个东西叠一起比没有插画更糟。
 */
interface PageHeaderProps {
  title: string
  subtitle?: string
  /** 角落插画（不传就不显示；纯装饰，见 CornerArt） */
  art?: 'order' | 'fridge' | 'mine' | 'recipes' | 'discover' | 'checkins' | 'family'
  /** 右上角已有按钮：插画让开 */
  withAction?: boolean
}

export default function PageHeader({ title, subtitle, art, withAction }: PageHeaderProps) {
  return (
    <div className="page-head">
      {art && <CornerArt name={art} withAction={withAction} />}
      <div className="ptitle">{title}</div>
      {subtitle && <div className="psub">{subtitle}</div>}
    </div>
  )
}
