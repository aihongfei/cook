import './ui.scss'

/**
 * 页面右上角的角落插画（用户 2026-10-12：「每个页的右上角都有点空」）。
 *
 * 放在**标题那一行的右侧**、绝对定位贴着右边缘——之所以不给个 `pad` 里的普通位置：
 * 它要的正是"填充标题右侧那块空白"，做成流式元素就会把标题挤窄，标题一换行反而更空。
 *
 * 所以这一块是**纯装饰**：`aria-hidden` + `pointer-events: none`（它不该被读屏软件念出来、
 * 也不该挡住右上角可能出现的操作按钮）。有些页面右上角本来就有按钮（比如菜谱小书的搜索），
 * 那时传 `withAction` 把它往左让开——两个东西叠在一起比没有插画更糟。
 *
 * 图都是 320px 的透明底水彩（`/img/corner/*.png`，见 `RUNBOOK.md` R-019）：
 * 透明是关键，页面背景带点阵纹理，带底色的方图贴上去会像一张贴纸。
 */
interface CornerArtProps {
  /** 用哪张插画（文件名，对应 public/img/corner/<name>.png） */
  name: 'order' | 'fridge' | 'mine' | 'recipes' | 'discover' | 'checkins' | 'family'
  /** 右上角已有操作按钮时传 true：插画往左让开，别叠在上面 */
  withAction?: boolean
}

export default function CornerArt({ name, withAction = false }: CornerArtProps) {
  return (
    <img
      className={['corner-art', withAction && 'corner-art--shifted'].filter(Boolean).join(' ')}
      src={`/img/corner/${name}.png`}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
    />
  )
}
