import type { ReactNode } from 'react'
import { AlertCircle, Check, Circle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type RunStepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'

export interface RunStepItem {
  id: string
  label: ReactNode
  status: RunStepStatus
  /** Units done out of planned; `total` null while the step is not planned yet. */
  progress?: { done: number; total: number | null }
  /** What the step is on right now, shown under an active step. */
  detail?: ReactNode
}

/**
 * The steps of a long computation, one per line: done, running (with its
 * count and what it is on), or still to come. For a job whose phases differ
 * in kind — sizing, counting, crossing — where one bar alone says how far,
 * not what is happening.
 */
export function RunSteps({ steps, className }: { steps: readonly RunStepItem[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {steps.map((step, i) => {
        const pct = step.progress?.total ? Math.min(100, (step.progress.done / step.progress.total) * 100) : null
        return (
          <li key={step.id} className="relative flex gap-2.5 pb-2 last:pb-0">
            {i < steps.length - 1 && (
              <span aria-hidden className={cn('absolute top-5 bottom-0 left-[7px] w-px', step.status === 'done' ? 'bg-emerald-500/40' : 'bg-border')} />
            )}
            <span className="relative z-10 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-card">
              {step.status === 'done' && <Check size={14} className="text-emerald-600 dark:text-emerald-400" />}
              {step.status === 'active' && <Loader2 size={14} className="animate-spin text-primary" />}
              {step.status === 'error' && <AlertCircle size={14} className="text-destructive" />}
              {(step.status === 'pending' || step.status === 'skipped') && <Circle size={10} className="text-muted-foreground/50" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  'text-xs',
                  step.status === 'active' ? 'font-medium text-foreground' : step.status === 'pending' || step.status === 'skipped' ? 'text-muted-foreground' : 'text-foreground',
                  step.status === 'skipped' && 'line-through',
                )}>
                  {step.label}
                </span>
                <span className="flex-1" />
                {step.progress && step.status !== 'skipped' && (step.progress.total ?? 0) > 1 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {step.progress.total == null ? step.progress.done : `${step.progress.done.toLocaleString()} / ${step.progress.total.toLocaleString()}`}
                  </span>
                )}
              </div>
              {step.status === 'active' && pct != null && (step.progress?.total ?? 0) > 1 && (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              )}
              {step.status === 'active' && step.detail && (
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{step.detail}</div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
