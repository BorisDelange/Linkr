import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Ban, CheckCircle2, XCircle, Hourglass } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isServerMode } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { listJobs, cancelJob, type Job } from '@/lib/api/environments'

const ACTIVE = new Set(['queued', 'running'])

/**
 * Footer jobs indicator (server mode): shows active long jobs (env builds today,
 * long runs later) with a popover to view status/log and cancel. Polls while a
 * project is open; hidden entirely in front-only mode.
 */
export function JobsIndicator() {
  const { t } = useTranslation()
  const projectUid = useAppStore((s) => s.activeProjectUid)
  const [jobs, setJobs] = useState<Job[]>([])
  const [reloadTick, setReloadTick] = useState(0)
  const enabled = isServerMode() && !!projectUid

  useEffect(() => {
    if (!enabled || !projectUid) return
    let cancelled = false
    const tick = () => {
      listJobs(projectUid)
        .then((j) => { if (!cancelled) setJobs(j) })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, projectUid, reloadTick])

  const activeCount = jobs.filter((j) => ACTIVE.has(j.status)).length

  if (!enabled || jobs.length === 0) return null

  const onCancel = async (id: string) => {
    await cancelJob(id)
    setReloadTick((n) => n + 1)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-accent/50 transition-colors">
          {activeCount > 0 ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Hourglass size={11} />
          )}
          <span>{t('jobs.title', { count: activeCount })}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2 text-xs">
        <div className="mb-1 font-medium">{t('jobs.recent')}</div>
        <ul className="flex flex-col gap-1">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
              <span className="flex min-w-0 items-center gap-1.5">
                <JobStatusIcon status={job.status} />
                <span className="truncate">{job.label}</span>
              </span>
              {ACTIVE.has(job.status) ? (
                <button
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => void onCancel(job.id)}
                  aria-label={t('jobs.cancel')}
                >
                  <Ban size={13} />
                </button>
              ) : (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t(`jobs.status.${job.status}`)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function JobStatusIcon({ status }: { status: Job['status'] }) {
  if (status === 'running' || status === 'queued')
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  if (status === 'done') return <CheckCircle2 size={12} className="text-emerald-500" />
  if (status === 'cancelled') return <Ban size={12} className="text-muted-foreground" />
  return <XCircle size={12} className="text-destructive" />
}
