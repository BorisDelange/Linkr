import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEtlStore } from '@/stores/etl-store'
import { cn } from '@/lib/utils'
import { currentStatementNumber, statementPreview } from './statement-preview'
import type { EtlFile } from '@/types'

interface Props {
  /** The scripts of this run, in order, so "3 / 12" counts the right set. */
  files: EtlFile[]
  /** Open the running script at the statement being executed. Omit where there
   *  is no editor to jump to (the Pipeline toolbar passes it through). */
  onGoToStatement?: (fileId: string, statement: string | undefined) => void
}

/**
 * What the run is doing right now: which script, how far through the set, and
 * how long the current one has been going.
 *
 * The elapsed time matters as much as the counter — a script can sit on one
 * statement for minutes, and without a moving number there is no way to tell
 * work from a hang.
 */
export function RunProgressBar({ files, onGoToStatement }: Props) {
  const { t } = useTranslation()
  const running = useEtlStore((s) => s.pipelineRunning)
  const statuses = useEtlStore((s) => s.scriptStatuses)

  const current = files.find((f) => statuses.get(f.id)?.status === 'running')
  const log = current ? statuses.get(current.id) : undefined
  const done = files.filter((f) => {
    const s = statuses.get(f.id)?.status
    return s === 'success' || s === 'skipped'
  }).length

  const elapsed = useElapsed(log?.startedAt, running)

  if (!running) return null

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Loader2 size={12} className="shrink-0 animate-spin text-blue-500" />
      {/* Explicit separators: at this size the flex gap alone ran the values
          together ("stmt 4/26" + "7s" read as "stmt 4/267s"). */}
      <div className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {done}/{files.length}
        </span>
        {current && <span className="truncate font-medium">{current.name}</span>}
        {log?.statementsTotal != null && log.statementsTotal > 1 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role={onGoToStatement ? 'button' : undefined}
                tabIndex={onGoToStatement ? 0 : undefined}
                onClick={onGoToStatement && current
                  ? () => onGoToStatement(current.id, log.currentStatement)
                  : undefined}
                onKeyDown={onGoToStatement && current
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onGoToStatement(current.id, log.currentStatement)
                      }
                    }
                  : undefined}
                className={cn(
                  'shrink-0 tabular-nums text-muted-foreground',
                  onGoToStatement && current
                    ? 'cursor-pointer underline-offset-2 hover:text-foreground hover:underline'
                    : 'cursor-default',
                )}
              >
                · {t('etl.run_statement_progress', {
                  done: currentStatementNumber(log),
                  total: log.statementsTotal,
                })}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[420px]">
              <span className="font-mono text-[10px] leading-relaxed">
                {statementPreview(log.currentStatement) ?? t('etl.run_statement_progress', {
                  done: currentStatementNumber(log),
                  total: log.statementsTotal,
                })}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {elapsed && (
          <span className="shrink-0 tabular-nums text-muted-foreground">· {elapsed}</span>
        )}
      </div>
    </div>
  )
}

/** Ticking "1m 04s" since `startedAt`, while a run is in progress. */
function useElapsed(startedAt: string | undefined, running: boolean): string | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running || !startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running, startedAt])

  if (!startedAt) return null
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}
