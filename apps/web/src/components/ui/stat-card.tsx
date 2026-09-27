import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

interface StatCardProps {
  icon: ReactNode
  /** Tinted square behind the icon — usually an `ENTITY_COLORS` `bg` + `icon` pair. */
  iconBg: string
  value: ReactNode
  label: ReactNode
  /** A secondary line under the label (a share, a caveat). */
  detail?: ReactNode
  to?: string
  onClick?: () => void
  className?: string
}

/** A headline figure with its icon square, as the workspace and project summaries show them. */
export function StatCard({ icon, iconBg, value, label, detail, to, onClick, className }: StatCardProps) {
  const content = (
    <div className="flex items-center gap-3">
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', iconBg)}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        {detail && <div className="mt-0.5 truncate text-xs">{detail}</div>}
      </div>
    </div>
  )
  const base = cn('rounded-xl border bg-card p-4 text-left shadow-sm', className)
  if (to) {
    return (
      <Link to={to} className={cn(base, 'block transition-colors hover:bg-accent')}>
        {content}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(base, 'transition-colors hover:bg-accent')}>
        {content}
      </button>
    )
  }
  return <div className={base}>{content}</div>
}
