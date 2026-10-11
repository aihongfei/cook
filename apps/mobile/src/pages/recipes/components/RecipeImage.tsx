import { useState } from 'react'

/** 缺图与失效图片都用中性碗盘，不借用其他菜品的照片。 */
export default function RecipeImage({ src, name }: { src: string | null; name: string }) {
  const [failedSrc, setFailedSrc] = useState<string>()
  if (src && src !== failedSrc) {
    return <img src={src} alt={name} loading="lazy" onError={() => setFailedSrc(src)} />
  }
  return (
    <div className="recipe-image-placeholder" role="img" aria-label={`${name}暂无图片`}>
      <svg viewBox="0 0 160 100" aria-hidden="true">
        <ellipse cx="80" cy="81" rx="53" ry="8" fill="#d8c6a5" opacity=".3" />
        <path d="M32 45 Q35 78 78 79 Q123 81 129 46" fill="#f2dfb7" stroke="#b89b73" strokeWidth="2" />
        <ellipse cx="80" cy="45" rx="49" ry="13" fill="#fffbf2" stroke="#b89b73" strokeWidth="2" />
        <path d="M45 46 Q78 32 114 47 M61 22 Q54 14 62 6 M81 22 Q73 13 82 4 M100 24 Q91 17 99 9" fill="none" stroke="#c6ab86" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span>菜谱图片待补</span>
    </div>
  )
}
