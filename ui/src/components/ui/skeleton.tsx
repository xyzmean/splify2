import { cn } from '@/lib/utils'

// Placeholder block for content that is still loading. Used instead of a bare
// "Загрузка…" line so the page keeps its final shape while the diagnostics half
// arrives — the layout must not jump under the operator's cursor.
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

// A few rows of skeleton, sized like a table body.
export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  )
}
