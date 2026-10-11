import type { ReactNode } from 'react'

export default function RecipeStatus({
  title,
  children,
  onRetry,
  loading = false,
}: {
  title: string
  children?: ReactNode
  onRetry?: () => void
  loading?: boolean
}) {
  return (
    <div className="recipe-status" role={onRetry ? 'alert' : 'status'} aria-busy={loading}>
      <p>{title}</p>
      {children && <div className="recipe-status__description">{children}</div>}
      {onRetry && <button className="recipe-button" type="button" onClick={onRetry}>再试一次</button>}
    </div>
  )
}
