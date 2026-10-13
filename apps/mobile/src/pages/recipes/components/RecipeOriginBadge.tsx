/**
 * 来源徽标（F1-12，用户 2026-10-13：「自己上传的要和极速 api 的区分下」）。
 *
 * 两件事刻意的：
 * - **文案一律用后端给的 `sourceLabel`**，前端不查表：将来加一个新导入源，
 *   查表的那一版就会把它显示成空白或英文 key，而"新源上线"恰恰没人事先想到要改这里；
 * - **自建的实色、导入的弱色**：库里绝大多数是导入的，每个都抢眼就等于没有重点。
 *   自建的那道才是用户能改的、跟他有关系的，颜色差就是"这道是你的"的信号。
 *
 * 不画按钮、不接点击：它只是标记，别让人以为点它能筛出同类。
 */
export default function RecipeOriginBadge({
  origin,
  sourceLabel,
  className,
}: {
  origin: string
  sourceLabel: string
  className?: string
}) {
  const isSelf = origin === 'user'
  const label = sourceLabel || (isSelf ? '自己上传' : '')
  if (!label) return null
  return (
    <span className={['origin-badge', isSelf && 'origin-badge--mine', className].filter(Boolean).join(' ')}>
      {label}
    </span>
  )
}
