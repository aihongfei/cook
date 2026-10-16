/**
 * 界面图标：**图片**，不是文字符号（2026-10-16 用户：「一般都用的是符号图标，
 * 需要全部改为用图片生成……不要用符号图标了」）。
 *
 * 为什么走图片而不是 SVG 或 emoji：
 * - **emoji 的问题**是渲染由系统字体说了算——安卓与 iOS 长得不一样、同一台机器上
 *   也不受我们控制（字号一变、基线就动）。本项目已经为这件事栽过两次：
 *   `＋`（U+FF0B）实测偏左 3.7px / 偏下 2.7px、`×`（U+00D7）偏下 3.4px
 *   （见 TabIcons.tsx 里那两段 ⚠️）——那两次的解法是改画 SVG；
 * - **为什么这次不是 SVG**：这一批是**手绘水彩**，有笔触与晕染的质感，SVG 画不出
 *   （用户要的正是这个画风，与 `public/img/corner/`、`ingredients/` 同一套语汇）。
 *
 * 图从哪来：`image-generation` 技能，**一张拼图里同时出十几个**，再按格裁成独立小图
 *   （与 `ingredients/` 同一手法——一张里出十几个才保证风格一致，分批生成会出现
 *   "这批的橙偏红、那批偏黄"）。三张原表在 `generated-images/` 下（不入库）：
 *   `icons-solid-{a,b}.png` 出 32 个事物的图标，`ui-marks.png` 出 13 个方向与增减符号
 *   （用户说的「生成一张即可，然后裁剪」——一张只能出十六个上下，40 多个挤一张就糊了，
 *   所以按"事物 / 记号"分成三张，仍然是"拼图 + 裁剪"而不是一个图标一次生成）。
 *
 * ⚠️ **生成时底色必须是纯品红（#FF00FF），不能要"透明背景"**：模型嘴里的 transparent
 * 画出来是**棋盘格图案**（白 #FDFDFE + 灰 #E8E8E8 两种格子）——它把"透明"当成一种纹理画在了
 * 图里，而那层格子会被当成图的一部分显示在米色底上。品红是安全的：图标配色（奶油/蜜桃橙/
 * 砖红/鼠尾草绿/土褐）里绝不会有它，所以可以整片抠掉、且不碰图标内部的白（碗、盘子、米饭都是白的）。
 */
import './icon.scss'

export type IconName =
  | 'book' | 'basket' | 'pot' | 'hourglass' | 'chopsticks' | 'ice' | 'camera' | 'bubble'
  | 'house' | 'clipboard' | 'rice' | 'lock' | 'star' | 'refresh' | 'check' | 'cross'
  | 'plate' | 'family' | 'chili' | 'bell' | 'dice' | 'sparkle' | 'puzzle' | 'calendar'
  | 'pencil' | 'cart' | 'pan' | 'bulb' | 'heart' | 'heart-outline' | 'greens' | 'search'
  /*
   * ⚠️ **两套勾叉，别混**（这是本文件最容易用错的一处）：
   * - `check` / `cross` 是**带底圈的插图**（橄榄绿的圆 + 白勾、砖红的圆 + 白叉），
   *   用在"画一个状态"的地方（空态插画、回执的「已办妥」）；
   * - `tick` / `close` 是**裸记号**（只有墨迹，没有底），用在"压在别的颜色上"的地方
   *   （提示层那颗橙圆里的勾、多选框里的勾、各处删除的叉）。
   * 用错的后果很具体：带圈的图 `white` 一下会变成**一整块白饼**——圈也白了。
   */
  // 方向与增减（第二张表）：列表行的 ›、链接尾的 →、筛选、加减、勾叉、展开收起都走这些
  | 'plus' | 'minus' | 'tick' | 'close' | 'chevron-right' | 'chevron-double'
  | 'chevron-down' | 'chevron-up' | 'arrow-right' | 'arrow-left' | 'arrow-up-right'
  | 'filter' | 'album'
  // 状态点（第三张表）：今日安排那三行的行首圆点
  | 'dot-done' | 'dot-open' | 'dot-none'

interface IconProps {
  name: IconName
  /** 显示边长（px）。这些图是 128×128 的，给到 32 以下都还很锐利 */
  size?: number
  /**
   * 落在深底上时刷白（见 `icon.scss` 的 `.icon--white`）。
   *
   * 做成 prop 而不是让调用方写 `className="icon--white"`：这是一条**可及性**要求
   * （深褐压深底等于看不见），prop 在调用点读得出来、漏了也看得见；
   * 一个字符串 class 得先知道它存在。
   */
  white?: boolean
  className?: string
}

export default function Icon({ name, size = 16, white, className }: IconProps) {
  return (
    <img
      className={['icon', white && 'icon--white', className].filter(Boolean).join(' ')}
      src={`/img/icons/${name}.png`}
      width={size}
      height={size}
      /*
       * `alt=""` + `aria-hidden`：这些图标旁边**总有文字**（「📷 拍照」→「拍照」），
       * 读屏念出"照相机 拍照"是噪声。图标在这里是装饰，语义由文字承担
       * （与 CornerArt / TabIcons 同一处理）。
       */
      alt=""
      aria-hidden
    />
  )
}
