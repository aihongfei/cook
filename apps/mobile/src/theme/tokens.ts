/**
 * 设计 token 的 TS 视图。
 * 主要给 JS 侧使用（图表配色、canvas、动态样式），CSS 侧请直接用 var(--color-*)。
 * 数值与 src/styles/tailwind.css 的 @theme 保持一致。
 */
export const colors = {
  brand: '#E07B39',
  brick: '#B94A2C',
  ink: '#5A3520',
  ink2: '#8E6B52',
  ink3: '#A8785A',
  cream: '#FCF1DA',
  cream2: '#F8EAD4',
  paper: '#FFFBF2',
  line: '#EADCC4',
  peach: '#F6C9A8',
  sage: '#BCCBA6',
  butter: '#F5D98B',
  rose: '#E8B4A6',
  teal: '#A8BFB4',
} as const

/** 分类粉彩，按索引取用（与 cat-1..5.png 顺序一致） */
export const categoryTints = [colors.peach, colors.sage, colors.butter, colors.rose, colors.teal] as const

/** 图表配色（Recharts / ECharts 用） */
export const chartPalette = [colors.brand, colors.sage, colors.butter, colors.rose, colors.teal] as const

/** 圆角 */
export const radius = {
  card: '20px',
  tile: '18px',
} as const
