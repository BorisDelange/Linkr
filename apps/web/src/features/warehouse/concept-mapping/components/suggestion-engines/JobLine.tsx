import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Pause, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cancelJob, type Job } from '@/lib/api/environments'

/**
 * A running job as one line: label, bar, last log line, Stop — and Pause when
 * the job can resume where it stopped (`onPause`).
 */
export function JobLine({ job, onPause }: { job: Job; onPause?: () => Promise<void> }) {
  const { t } = useTranslation()
  // A cancel lands once the job's process has stopped: until then the button says so.
  const [stopping, setStopping] = useState(false)
  // A pause also writes what is finished, which can take a moment on a large project.
  const [pausing, setPausing] = useState(false)
  const pause = async () => {
    if (!onPause) return
    setPausing(true)
    try {
      await onPause()
    } catch {
      setPausing(false)
    }
  }
  const last = job.logTail?.split('\n').filter((l) => l.trim()).at(-1)
  const stop = async () => {
    setStopping(true)
    try {
      await cancelJob(job.id)
    } catch {
      setStopping(false)
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <Loader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{job.status === 'queued' ? t('concept_mapping.engines_job_queued') : job.label}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{job.progress}%</span>
        {onPause && (
          <Button size="xs" variant="outline" className="gap-1" disabled={pausing || stopping} onClick={() => void pause()}>
            {pausing ? <Loader2 size={10} className="animate-spin" /> : <Pause size={10} />}
            {pausing ? t('concept_mapping.engines_pausing') : t('concept_mapping.engines_pause')}
          </Button>
        )}
        <Button size="xs" variant="destructive" className="gap-1" disabled={stopping || pausing} onClick={() => void stop()}>
          {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
          {stopping ? t('jobs.stopping') : t('jobs.stop')}
        </Button>
      </div>
      <Progress value={job.progress} className="h-1" />
      {last && <p className="truncate font-mono text-[10px] text-muted-foreground" title={last}>{last}</p>}
    </div>
  )
}
