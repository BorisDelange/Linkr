import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Ban, CheckCircle2, XCircle, Hourglass, ScrollText, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isServerMode } from '@/lib/api-client'
import { CodeViewer } from '@/components/editor/CodeViewer'
import { stripAnsi } from '@/lib/ansi'
import { cn } from '@/lib/utils'
import { sanitizeHtml } from '@/lib/sanitize'
import { useProjectRouteUid } from '@/hooks/use-project-route'
import { listJobs, cancelJob, clearJobs, type Job } from '@/lib/api/environments'

const ACTIVE = new Set(['queued', 'running'])

/** True when the poll returned nothing this indicator would draw differently. The
 *  common case by far is "no jobs at all", where re-rendering the footer every 3s
 *  also re-rendered every dialog mounted in it (the environments manager). While a
 *  job IS running, progress/logTail move and the compare correctly reports a change. */
function sameJobs(a: Job[], b: Job[]): boolean {
  if (a.length !== b.length) return false
  return a.every((j, i) => {
    const o = b[i]
    return (
      j.id === o.id &&
      j.status === o.status &&
      j.progress === o.progress &&
      j.label === o.label &&
      j.logTail === o.logTail
    )
  })
}

/**
 * Footer jobs indicator (server mode): shows active long jobs (env builds today,
 * long runs later) with a popover to view status/log and cancel. Polls while a
 * project is open; hidden entirely in front-only mode.
 */
export function JobsIndicator() {
  const { t } = useTranslation()
  const projectUid = useProjectRouteUid()
  const [jobs, setJobs] = useState<Job[]>([])
  const [reloadTick, setReloadTick] = useState(0)
  const [logJobId, setLogJobId] = useState<string | null>(null)
  // Controlled so opening a job's detail modal closes the list, and closing the
  // modal reopens the list (natural back-to-list flow).
  const [popoverOpen, setPopoverOpen] = useState(false)
  const enabled = isServerMode() && !!projectUid

  useEffect(() => {
    if (!enabled || !projectUid) return
    let cancelled = false
    const tick = () => {
      listJobs(projectUid)
        .then((j) => {
          if (!cancelled) setJobs((prev) => (sameJobs(prev, j) ? prev : j))
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, projectUid, reloadTick])

  const activeCount = jobs.filter((j) => ACTIVE.has(j.status)).length

  if (!enabled) return null

  const onCancel = async (id: string) => {
    await cancelJob(id)
    setReloadTick((n) => n + 1)
  }

  const onClearAll = async () => {
    if (!projectUid) return
    await clearJobs(projectUid)
    setReloadTick((n) => n + 1)
  }

  const logJob = jobs.find((j) => j.id === logJobId) ?? null
  const hasFinished = jobs.some((j) => !ACTIVE.has(j.status))

  return (
    <>
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
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
      <PopoverContent align="end" className="w-96 p-2 text-xs">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-medium">{t('jobs.recent')}</span>
          {hasFinished && (
            <button
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void onClearAll()}
            >
              <Trash2 size={11} />
              {t('jobs.clear_all')}
            </button>
          )}
        </div>
        {jobs.length === 0 && (
          <p className="px-1.5 py-3 text-center text-[11px] text-muted-foreground">
            {t('jobs.empty')}
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
              {/* Click the row to open the full log in a modal. */}
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => { setLogJobId(job.id); setPopoverOpen(false) }}
                title={t('jobs.show_log')}
              >
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">{formatJobTime(job.createdAt)}</span>
                <JobStatusIcon status={job.status} />
                <span className="truncate">{job.label}</span>
                <ScrollText size={11} className="shrink-0 text-muted-foreground/50" />
              </button>
              {ACTIVE.has(job.status) ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void onCancel(job.id)}
                        aria-label={t('jobs.cancel')}
                      >
                        <Ban size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {t('jobs.cancel_tooltip')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
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

    {/* Full log in a modal — the complete captured output (commands + results) of
        a build/package op, shown in the read-only editor so shell commands get the
        same syntax highlighting as the IDE. */}
    <Dialog open={!!logJob} onOpenChange={(o) => { if (!o) { setLogJobId(null); setPopoverOpen(true) } }}>
      {/* h-[90vh], not max-h: the log editor fills the body and scrolls inside
          itself, so the modal must claim its full height up front rather than
          shrink-wrap the (unwrapped, 3-line) content. */}
      <DialogContent className="flex h-[90vh] w-[90vw] flex-col sm:max-w-[60vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {logJob && <JobStatusIcon status={logJob.status} />}
            {logJob?.label}
          </DialogTitle>
        </DialogHeader>
        {logJob?.result ? (
          // With artifacts the body scrolls: log at a fixed share, figures below.
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
            {logJob.logTail ? <JobLogView text={logJob.logTail} height={320} /> : <NoLog />}
            <JobArtifacts result={logJob.result} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {logJob?.logTail ? <JobLogView text={logJob.logTail} height="100%" /> : <NoLog />}
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  )
}

function NoLog() {
  const { t } = useTranslation()
  return <p className="rounded bg-muted/60 p-3 text-xs text-muted-foreground">{t('jobs.no_log')}</p>
}

/** A job's captured log in the read-only editor. Monaco renders no SGR sequences,
 *  so ANSI is stripped rather than shown raw; 'shell' highlights the `$ …` command
 *  lines the build/install steps echo. */
function JobLogView({ text, height }: { text: string; height: string | number }) {
  const plain = useMemo(() => stripAnsi(text), [text])
  return (
    <div className={cn('overflow-hidden rounded border', height === '100%' && 'min-h-0 flex-1')}>
      <CodeViewer value={plain} language="shell" height={height} />
    </div>
  )
}

/** Figures (inline SVG) + result table collected by a 'run' job, shown under its
 *  log. Rendered from the sanitized SVG string / JSON table the batch run produced. */
function JobArtifacts({ result }: { result: NonNullable<Job['result']> }) {
  const { t } = useTranslation()
  const figures = result.figures ?? []
  const table = result.table
  const html = result.html
  if (figures.length === 0 && !table && !html) return null
  return (
    <div className="flex flex-col gap-3">
      {figures.map((fig, i) => (
        <div key={fig.id ?? i} className="rounded border bg-background p-2">
          {fig.label && <p className="mb-1 text-[11px] text-muted-foreground">{fig.label}</p>}
          {fig.type === 'svg' ? (
            <div className="overflow-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: sanitizeHtml(fig.data) }} />
          ) : (
            <img src={`data:image/png;base64,${fig.data}`} alt={fig.label ?? 'figure'} className="max-w-full" />
          )}
        </div>
      ))}
      {html && (
        // A widget (plotly/leaflet/DT) — self-contained HTML in a sandboxed iframe.
        // NO allow-same-origin: a srcDoc iframe inherits our origin, and combining it
        // with allow-scripts would let untrusted widget JS reach the parent origin
        // (cookies/session/DOM). Plotly/leaflet/DT run fine on allow-scripts alone.
        <iframe
          srcDoc={html}
          className="h-[60vh] w-full rounded border"
          sandbox="allow-scripts"
          title="widget"
        />
      )}
      {table && (
        <div className="overflow-auto rounded border">
          <table className="w-full text-xs">
            <thead className="bg-muted/60">
              <tr>
                {table.headers.map((h, i) => (
                  <th key={i} className="border-b px-2 py-1 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 200).map((row, ri) => (
                <tr key={ri} className="odd:bg-muted/20">
                  {row.map((cell, ci) => (
                    <td key={ci} className="border-b px-2 py-1">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.rows.length > 200 && (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">
              {t('jobs.table_truncated', { shown: 200, total: table.rows.length })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Short local date+time for a job row, e.g. "07/31 14:22". Falsy/bad input → ''. */
function formatJobTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function JobStatusIcon({ status }: { status: Job['status'] }) {
  if (status === 'running' || status === 'queued')
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  if (status === 'done') return <CheckCircle2 size={12} className="text-emerald-500" />
  if (status === 'cancelled') return <Ban size={12} className="text-muted-foreground" />
  return <XCircle size={12} className="text-destructive" />
}
