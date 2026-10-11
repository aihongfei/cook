/**
 * 首屏 hero：手绘厨房场景 + 透明底笔绘品牌字。
 * 品牌字直接落在插画上，不用遮挡层，只加米色微光保证可读（见 docs/ui-preview/README.md）。
 */
export default function HeroBanner() {
  return (
    <header className="hero">
      <img className="hero__art" src="/img/hero.png" alt="" />
      <img className="hero__logo" src="/img/logo-t.png" alt="御膳私房菜" />
    </header>
  )
}
