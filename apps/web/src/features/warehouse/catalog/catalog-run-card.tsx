import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { RunSteps, type RunStepItem } from '@/components/ui/run-steps'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { CatalogUnitInfo } from '@/lib/duckdb/catalog-compute'
import type { CatalogRunSnapshot } from '@/lib/duckdb/catalog-runner'
import { formatDuration } from '@/lib/format-helpers'
import type { DataCatalog } from '@/types'

/** The run's card: where it is, its steps, and what can be done with it — run,
 *  pause, resume, start over, discard. */
export function CatalogRunCard({ catalog, snapshot, paused, done, locked, hasMapping, canWrite, onRun, onPause, onDiscard }: {
  catalog: DataCatalog
  snapshot: CatalogRunSnapshot
  paused: boolean
  done: boolean
  locked: boolean
  hasMapping: boolean
  canWrite: boolean
  onRun: (restart: boolean) => void
  onPause: () => void
  onDiscard: () => void
}) {
  const { t, i18n } = useTranslation()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const { running, pausing, error } = snapshot
  // The crossing units are planned only once the rankings are in: until then the bar has no total.
  const preparing = running && snapshot.total == null
  const computed = snapshot.computed ?? catalog.computedSteps ?? 0
  const total = snapshot.total ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((computed / total) * 100)) : 0
  const unitDetail = (u: CatalogUnitInfo | null): string | null => {
    if (!u) return null
    const parts: string[] = []
    if (u.crossing) parts.push(u.crossing.map((v) => t(`data_catalog.var_${v}`)).join(' × '))
    if (u.dictionary) parts.push(u.dictionary)
    if (u.ranked) parts.push(t(`data_catalog.var_${u.ranked}`))
    if (u.chunk) parts.push(t('data_catalog.run_chunk', { i: u.chunk[0], n: u.chunk[1] }))
    if (u.slice) parts.push(t('data_catalog.run_slice', { i: u.slice[0], n: u.slice[1] }))
    return parts.join(' · ') || null
  }
  const runSteps: RunStepItem[] = (['mounting', 'sizing', 'concepts', 'totals', 'ranking', 'crossings', 'saving'] as const)
    .filter((id) => id === 'mounting' || id === 'saving' || id === 'sizing' || snapshot.steps[id] != null || !running)
    .filter((id) => id !== 'ranking' || (snapshot.steps.ranking?.total ?? 0) > 0)
    .map((id, _, list) => {
      const order = list.indexOf(id)
      const current = snapshot.phase ? list.indexOf(snapshot.phase) : -1
      const progress = id !== 'mounting' && id !== 'saving' ? snapshot.steps[id] : undefined
      const status = snapshot.phase === id ? 'active' as const
        : (progress && progress.total != null && progress.done >= progress.total) || (current > order) ? 'done' as const
        : 'pending' as const
      return {
        id,
        label: t(`data_catalog.run_step_${id}`),
        status,
        progress,
        detail: snapshot.phase === id ? unitDetail(snapshot.current) : undefined,
        startedAt: snapshot.phase === id ? snapshot.phaseStartedAt : undefined,
        reading: snapshot.phase === id ? snapshot.reading : undefined,
      }
    })

  return (
    <>
      {/* Progress + controls */}
      <Card className="flex flex-col gap-2 p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {/* Each phase says what it is doing: silence here reads as a button
                that did nothing, and the concept pass alone can take minutes. */}
            {pausing
              ? t('data_catalog.compute_pausing_status')
              : running
              ? (catalog.lastComputeDurationMs != null
                ? t('data_catalog.compute_running_last', { duration: formatDuration(catalog.lastComputeDurationMs) })
                : t('data_catalog.compute_running'))
              : catalog.lastComputedAt
                ? (paused
                  ? t('data_catalog.compute_paused', { date: new Date(catalog.lastComputedAt).toLocaleString(i18n.language) })
                  : t('data_catalog.compute_complete', { date: new Date(catalog.lastComputedAt).toLocaleString(i18n.language) }))
                : t('data_catalog.compute_idle')}
          </span>
          {total > 0 && !preparing && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('data_catalog.compute_progress_count', {
                computed: computed.toLocaleString(i18n.language),
                total: total.toLocaleString(i18n.language),
              })}
            </span>
          )}
        </div>

        {/* A finished computation reads as a full bar, whenever it ran. */}
        <Progress value={done ? 100 : preparing ? 0 : percent} indicatorClassName={done ? 'bg-foreground' : undefined} />
        {running && <RunSteps steps={runSteps} className="mt-2" />}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onPause} disabled={pausing}>
              {pausing ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
              {pausing ? t('data_catalog.compute_pausing') : t('data_catalog.compute_pause')}
            </Button>
          ) : (
            <Button size="sm" className="gap-1.5" onClick={() => onRun(false)} disabled={!hasMapping || !canWrite}>
              <Play size={14} />
              {paused ? t('data_catalog.compute_resume') : done ? t('data_catalog.compute_again') : t('data_catalog.compute')}
            </Button>
          )}
          {/* Once finished, the main button already recomputes from scratch: starting over only differs from resuming. */}
          {paused && (
            <Button variant="destructive" size="sm" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
              <RotateCcw size={14} />
              {t('data_catalog.compute_restart')}
            </Button>
          )}
          {(done || paused) && !running && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmDiscard(true)}
            >
              <Trash2 size={14} />
              {t('data_catalog.compute_discard')}
            </Button>
          )}
          {running && !pausing && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
        </div>

        {locked && <p className="text-[10px] text-muted-foreground">{t('data_catalog.config_locked')}</p>}
        {!hasMapping && <p className="text-[10px] text-muted-foreground">{t('data_catalog.compute_no_mapping')}</p>}
        {done && catalog.lastComputeDurationMs != null && (
          <p className="text-[10px] text-muted-foreground">
            {t('data_catalog.compute_done_hint', { duration: formatDuration(catalog.lastComputeDurationMs) })}
          </p>
        )}
      </Card>

      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_catalog.compute_restart_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('data_catalog.compute_restart_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { setConfirmRestart(false); onRun(true) }}>
              {t('data_catalog.compute_restart')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_catalog.compute_discard_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('data_catalog.compute_discard_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => { setConfirmDiscard(false); onDiscard() }}>
              {t('data_catalog.compute_discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
