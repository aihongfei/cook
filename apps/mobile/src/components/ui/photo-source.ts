/**
 * 「拍照 / 从相册选」两个控件的 id 规矩。
 *
 * 单独一个文件、不跟组件放一起：那条 `react(only-export-components)` 规则是对的——
 * 一个文件里既导出组件又导出普通函数，改这个文件时 Fast Refresh 会退化成整页重载。
 * 而这里这两个**必须**共享一份 id 生成规则（见下），所以不能各写各的。
 *
 * 为什么要有这个函数：label 要用 `htmlFor` 指到那两个隐藏控件上，
 * 而两边各写一遍字符串迟早会打错一个字母——**打错的表现是"点了没反应"**（最难查的那种）。
 */
export interface PhotoSourceIds {
  /** 直接开相机（`capture="environment"`） */
  cameraId: string
  /** 走相册/文件选择 */
  albumId: string
}

export function photoSourceIds(id: string): PhotoSourceIds {
  return { cameraId: `${id}-camera`, albumId: `${id}-album` }
}
