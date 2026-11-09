import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, Circle, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDuration } from '@/lib/format-helpers'
import { cn } from '@/lib/utils'

export type RunStepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'

export interface RunStepItem {
  id: string
  label: ReactNode
  status: RunStepStatus
  /** Units done out of planned; `total` null while the step is not planned yet. */
  progress?: { done: number; total: number | null }
  /** How far its bar goes (0 to 1) when its units weigh unequally — the count
   *  beside it stays in units. */
  share?: number | null
  /** What its percent counts, on hover: said when it is not its units. */
  shareHint?: ReactNode
  /** Seconds it has left, as last estimated: counted down until the next. */
  eta?: number | null
  /** What the step is on right now, shown under an active step. */
  detail?: ReactNode
  /** When the active step began (epoch ms): its elapsed time ticks beside it. */
  startedAt?: number | null
  /** Percent of its data the query in flight has read, when the database can
   *  tell (a server DuckDB). Not the work left: a final aggregation sits on it. */
  reading?: number | null
}

/** The current time, ticking every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/** A time left, as rough as an estimate is: minutes, hours. */
function roughDuration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes <= 1) return '< 1 min'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/** A step's percent and the time it has left — counted down from its last
 *  estimate until the next — with what they count on hover. */
function StepShare({ pct, eta, hint }: { pct: number; eta: number | null; hint?: ReactNode }) {
  const { t } = useTranslation()
  const now = useNow(eta != null)
  const [mark, setMark] = useState<{ eta: number; at: number } | null>(null)
  if ((mark?.eta ?? null) !== eta) setMark(eta == null ? null : { eta, at: now })
  const left = mark ? Math.max(0, mark.eta * 1000 - (now - mark.at)) : null
  const text = [
    t('run_steps.percent', { pct: Math.floor(pct) }),
    left != null ? t('run_steps.eta', { time: roughDuration(left) }) : null,
  ].filter(Boolean).join(' · ')
  const shown = <span className="text-[10px] tabular-nums text-muted-foreground">{text}</span>
  if (!hint) return shown
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default underline decoration-muted-foreground/50 decoration-dotted underline-offset-2">{shown}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The steps of a long computation, one per line: done, running (with its
 * count and what it is on), or still to come. For a job whose phases differ
 * in kind — sizing, counting, crossing — where one bar alone says how far,
 * not what is happening. A step that is one long query shows how long it has
 * run and, where the database tells, how much of the data it has read.
 */
export function RunSteps({ steps, className }: { steps: readonly RunStepItem[]; className?: string }) {
  const { t } = useTranslation()
  const now = useNow(steps.some((s) => s.status === 'active' && s.startedAt != null))
  return (
    <ol className={cn('flex flex-col', className)}>
      {steps.map((step, i) => {
        const active = step.status === 'active'
        const units = (step.progress?.total ?? 0) > 1
        const pct = step.share != null ? Math.min(100, step.share * 100)
          : units ? Math.min(100, (step.progress!.done / step.progress!.total!) * 100) : null
        const reading = active && step.reading != null ? Math.min(100, Math.round(step.reading)) : null
        const detail = [step.detail, reading != null ? t('run_steps.reading', { pct: reading }) : null].filter(Boolean)
        return (
          <li key={step.id} className="relative flex gap-2.5 pb-2 last:pb-0">
            {i < steps.length - 1 && (
              <span aria-hidden className={cn('absolute top-[18px] bottom-0.5 left-[7px] w-px', step.status === 'done' ? 'bg-emerald-500/40' : 'bg-border')} />
            )}
            {/* As tall as the label's line (text-xs: 16px), so their centres meet. */}
            <span className="relative z-10 flex size-4 shrink-0 items-center justify-center rounded-full bg-card">
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
                {active && step.startedAt != null && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">{formatDuration(Math.max(0, now - step.startedAt))}</span>
                )}
                {step.progress && step.status !== 'skipped' && units && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {`${step.progress.done.toLocaleString()} / ${step.progress.total!.toLocaleString()}`}
                  </span>
                )}
                {active && pct != null && units && <StepShare pct={pct} eta={step.eta ?? null} hint={step.shareHint} />}
              </div>
              {active && (pct ?? reading) != null && (
                // Units done when the step has several; else the share of data read.
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full transition-[width]', pct != null ? 'bg-primary' : 'bg-primary/60')} style={{ width: `${pct ?? reading}%` }} />
                </div>
              )}
              {active && detail.length > 0 && (
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {detail.map((d, k) => <span key={k}>{k > 0 && ' · '}{d}</span>)}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
