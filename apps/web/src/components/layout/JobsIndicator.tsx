import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Ban, CheckCircle2, ChevronRight, XCircle, Hourglass, Square, Trash2, ExternalLink } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isServerMode } from '@/lib/api-client'
import { CodeViewer } from '@/components/editor/CodeViewer'
import { stripAnsi } from '@/lib/ansi'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format-helpers'
import { sanitizeHtml } from '@/lib/sanitize'
import { useProjectRouteUid } from '@/hooks/use-project-route'
import { listJobs, listWorkspaceJobs, cancelJob, clearJobs, clearWorkspaceJobs, onJobsChanged, type Job } from '@/lib/api/environments'
import { getJob } from '@/lib/api/query-jobs'
import { webAppFrameUrl } from '@/lib/api/web-apps'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useDataSourceStore } from '@/stores/data-source-store'
import { clearLoggedQueries, stopLoggedQuery } from '@/lib/duckdb/query-log'
import { QUERY_KIND, useLocalQueries } from './use-query-log'
import { groupJobs, type JobGroupRow } from './job-groups'

const ACTIVE = new Set(['queued', 'running'])

/** What a job's end changes elsewhere in the app, per kind. */
function jobFinished(job: Job): void {
  if (job.kind === 'derive') void useDataSourceStore.getState().derivationFinished(job)
}

/** True when the poll returned nothing this indicator would draw differently. The
 *  common case by far is "no jobs at all", where re-rendering the footer every 3s
 *  also re-rendered every dialog mounted in it (the environments manager). While a
 *  job IS running, progress/summary move and the compare correctly reports a change. */
function sameJobs(a: Job[], b: Job[]): boolean {
  if (a.length !== b.length) return false
  return a.every((j, i) => {
    const o = b[i]
    return (
      j.id === o.id &&
      j.status === o.status &&
      j.progress === o.progress &&
      j.label === o.label &&
      j.summary === o.summary &&
      j.cancellable === o.cancellable &&
      j.finishedAt === o.finishedAt
    )
  })
}

/**
 * Footer jobs indicator: shows active long jobs — environment builds and runs
 * of the open project, and the jobs of the open workspace (a database's cohort
 * derivations), and every query sent to a database — with a popover to view
 * status/log and cancel. Polls while a workspace is open. Front-only mode lists
 * the queries this browser tab ran, which it can stop alike. The jobs of one
 * action (a patient opened) fold into one row, stopped together.
 *
 * `atRightEdge`: the trigger is the footer's last item (a workspace view in server
 * mode), so the popover is nudged to sit as far from the page's right edge as
 * from the footer.
 */
export function JobsIndicator({ atRightEdge = false }: { atRightEdge?: boolean }) {
  const { t } = useTranslation()
  const projectUid = useProjectRouteUid()
  const { wsUid } = useResolvedParams()
  const [jobs, setJobs] = useState<Job[]>([])
  const [reloadTick, setReloadTick] = useState(0)
  const [logJobId, setLogJobId] = useState<string | null>(null)
  // Controlled so opening a job's detail modal closes the list, and closing the
  // modal reopens the list (natural back-to-list flow).
  const [popoverOpen, setPopoverOpen] = useState(false)
  const server = isServerMode()
  const enabled = server ? !!projectUid || !!wsUid : true
  // Last status seen per job: a job moving from active to finished is what
  // tells the app to re-read what it changed.
  const seen = useRef(new Map<string, Job['status']>())

  // A job just started somewhere in the app: show it now, not at the next poll.
  useEffect(() => onJobsChanged(() => setReloadTick((n) => n + 1)), [])

  useEffect(() => {
    if (!enabled || !server) return
    let cancelled = false
    const tick = () => {
      Promise.all([
        projectUid ? listJobs(projectUid) : Promise.resolve([]),
        wsUid ? listWorkspaceJobs(wsUid).catch(() => []) : Promise.resolve([]),
      ])
        .then(([own, workspace]) => {
          if (cancelled) return
          const all = [...own, ...workspace].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          for (const job of all) {
            const before = seen.current.get(job.id)
            if (before && ACTIVE.has(before) && !ACTIVE.has(job.status)) jobFinished(job)
            seen.current.set(job.id, job.status)
          }
          setJobs((prev) => (sameJobs(prev, all) ? prev : all))
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, server, projectUid, wsUid, reloadTick])

  const localQueries = useLocalQueries(!server)

  // The input and the log travel only with the single job: fetched once the
  // modal opens, the log again while the job runs.
  const [detail, setDetail] = useState<{ jobId: string; input: string | null; logTail: string } | null>(null)
  const [logTab, setLogTab] = useState<'output' | 'input'>('output')
  const openStatus = jobs.find((j) => j.id === logJobId)?.status
  const openActive = !!openStatus && ACTIVE.has(openStatus)
  useEffect(() => {
    if (!logJobId || !server) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (withInput: boolean) => getJob(logJobId, { withInput })
      .then((j) => {
        if (!live) return
        setDetail((prev) => ({
          jobId: logJobId,
          input: withInput ? j.input ?? null : prev?.jobId === logJobId ? prev.input : null,
          logTail: j.logTail,
        }))
        if (openActive && ACTIVE.has(j.status)) timer = setTimeout(() => void read(false), 2000)
      })
      .catch((err) => {
        console.warn('[jobs] reading the job failed', err)
        if (live) setDetail((prev) => prev?.jobId === logJobId ? prev : { jobId: logJobId, input: null, logTail: '' })
      })
    void read(true)
    return () => { live = false; clearTimeout(timer) }
    // Read once more when the job ends: its last lines come with its end.
  }, [logJobId, server, openActive])

  const listed = server ? jobs : localQueries
  const rows = useMemo(() => groupJobs(listed), [listed])
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set())
  const toggleGroup = (key: string) => setOpenGroups((prev) => {
    const next = new Set(prev)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const activeCount = listed.filter((j) => ACTIVE.has(j.status)).length
  // Stops asked for and not yet seen through: a cancel only lands once the
  // unit in flight is interrupted, so the button says it was heard meanwhile.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const isStopping = (job: Job) => stopping.has(job.id) && ACTIVE.has(job.status)
  // A job seen but out of the panel's reach (a connection test) shows no Stop.
  const canStop = (job: Job) => ACTIVE.has(job.status) && job.cancellable !== false
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  if (!enabled) return null

  const onCancel = async (id: string) => {
    setStopping((prev) => new Set(prev).add(id))
    setCancelError(null)
    try {
      if (server) await cancelJob(id)
      else stopLoggedQuery(id)
    } catch (err) {
      console.error('Failed to cancel job', err)
      setCancelError(t('jobs.cancel_failed', { error: err instanceof Error ? err.message : String(err) }))
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
    setReloadTick((n) => n + 1)
  }

  const onStopGroup = (group: JobGroupRow) => {
    for (const job of group.jobs) if (canStop(job) && !stopping.has(job.id)) void onCancel(job.id)
  }
  const groupStopping = (group: JobGroupRow) => group.jobs.filter(canStop).every(isStopping)

  const onStopAll = () => {
    setConfirmStopAll(false)
    for (const job of listed) if (canStop(job) && !stopping.has(job.id)) void onCancel(job.id)
  }

  const onClearAll = async () => {
    if (!server) return clearLoggedQueries()
    await Promise.all([
      projectUid ? clearJobs(projectUid) : null,
      wsUid ? clearWorkspaceJobs(wsUid) : null,
    ])
    setReloadTick((n) => n + 1)
  }

  const logJob = listed.find((j) => j.id === logJobId) ?? null
  // A front-only query carries its SQL; a server job's is fetched once opened.
  const opened = detail && detail.jobId === logJobId ? detail : null
  const jobInput = !server ? (logJob?.input ?? null) : opened?.input ?? null
  const jobLog = !server ? (logJob?.logTail ?? '') : opened?.logTail ?? ''
  const showInput = logTab === 'input' && !!jobInput
  const hasFinished = listed.some((j) => !ACTIVE.has(j.status))

  const renderJob = (job: Job) => (
    <li key={job.id} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
      {/* Click the row to open the full log in a modal. */}
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => { setLogJobId(job.id); setLogTab(job.kind === QUERY_KIND ? 'input' : 'output'); setPopoverOpen(false) }}
        aria-label={`${job.label} — ${t('jobs.show_log')}`}
      >
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
          {formatJobTime(job.createdAt, job.kind === QUERY_KIND)}
        </span>
        <span className="flex shrink-0"><JobStatusIcon status={job.status} /></span>
        {/* One line, the whole label on hover: a query's says what it read. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 truncate py-px leading-normal">{job.label}</span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="max-w-96 break-words">
            {job.label}
          </TooltipContent>
        </Tooltip>
        {job.kind === QUERY_KIND && job.status === 'done' && (
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{job.summary}</span>
        )}
        {job.status === 'running' && job.progress > 0 && (
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{job.progress}%</span>
        )}
        <JobDuration job={job} className="ml-auto shrink-0 text-[10px] text-muted-foreground" />
      </button>
      {job.kind === 'app' && ACTIVE.has(job.status) && webAppUrl(job) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={webAppFrameUrl(webAppUrl(job)!)}
              target="_blank"
              rel="noopener"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t('web_apps.open_window')}
            >
              <ExternalLink size={12} />
            </a>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {t('web_apps.open_window')}
          </TooltipContent>
        </Tooltip>
      )}
      {canStop(job) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="shrink-0 text-muted-foreground hover:text-destructive disabled:text-destructive"
              onClick={() => void onCancel(job.id)}
              disabled={isStopping(job)}
              aria-label={t(isStopping(job) ? 'jobs.stopping' : 'jobs.cancel')}
            >
              {isStopping(job) ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {t(isStopping(job) ? 'jobs.stopping' : 'jobs.cancel_tooltip')}
          </TooltipContent>
        </Tooltip>
      ) : (job.kind === QUERY_KIND && job.status === 'done') || ACTIVE.has(job.status) ? null : (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t(`jobs.status.${job.status}`)}
        </span>
      )}
    </li>
  )

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
      <PopoverContent
        align="end"
        // Footer padding puts the trigger 12px from the edge; -4 brings the popover
        // to 8px. The trigger's top sits ~2px below the footer's, hence 10 for an 8px gap.
        {...(atRightEdge && { alignOffset: -4, sideOffset: 10 })}
        className="w-[34rem] p-2 text-xs"
      >
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-medium">{t('jobs.recent')}</span>
          <div className="flex items-center gap-3">
            {listed.some(canStop) && (
              <button
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmStopAll(true)}
              >
                <Square size={11} />
                {t('jobs.stop_all')}
              </button>
            )}
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
        </div>
        {cancelError && (
          <p role="alert" className="mb-2 px-1.5 text-[10px] text-destructive">{cancelError}</p>
        )}
        <p className="mb-1.5 px-1.5 text-[10px] text-muted-foreground">{t(server ? 'jobs.queries_hint' : 'jobs.queries_hint_local')}</p>
        {listed.length === 0 && (
          <p className="px-1.5 py-3 text-center text-[10px] text-muted-foreground">{t('jobs.empty')}</p>
        )}
        {/* A delay, so someone who knows these icons is not shown the tooltip
            at each pass; moving from one icon to the next shows it at once. */}
        <TooltipProvider delayDuration={600}>
          <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {rows.map((row) => 'job' in row ? renderJob(row.job) : (
              <li key={row.group.key}>
                <div className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => toggleGroup(row.group.key)}
                    aria-expanded={openGroups.has(row.group.key)}
                    aria-label={`${row.group.label} · ${t('jobs.group_count', { count: row.group.jobs.length })}`}
                  >
                    <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
                      {formatJobTime(row.group.createdAt, true)}
                    </span>
                    <span className="flex shrink-0"><JobStatusIcon status={row.group.status} /></span>
                    <ChevronRight
                      size={12}
                      className={cn('shrink-0 text-muted-foreground transition-transform', openGroups.has(row.group.key) && 'rotate-90')}
                    />
                    <span className="min-w-0 truncate py-px font-medium leading-normal">{row.group.label}</span>
                    <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                      {t('jobs.group_count', { count: row.group.jobs.length })}
                    </span>
                    <JobDuration job={row.group} className="ml-auto shrink-0 text-[10px] text-muted-foreground" />
                  </button>
                  {row.group.jobs.some(canStop) ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className="shrink-0 text-muted-foreground hover:text-destructive disabled:text-destructive"
                          onClick={() => onStopGroup(row.group)}
                          disabled={groupStopping(row.group)}
                          aria-label={t(groupStopping(row.group) ? 'jobs.stopping' : 'jobs.cancel_group')}
                        >
                          {groupStopping(row.group) ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>
                        {t(groupStopping(row.group) ? 'jobs.stopping' : 'jobs.cancel_group')}
                      </TooltipContent>
                    </Tooltip>
                  ) : row.group.status !== 'done' && !ACTIVE.has(row.group.status) && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t(`jobs.status.${row.group.status}`)}
                    </span>
                  )}
                </div>
                {openGroups.has(row.group.key) && (
                  <ul className="ml-3 flex flex-col gap-1 border-l pl-1">
                    {row.group.jobs.map(renderJob)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </TooltipProvider>
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
        <DialogHeader className="pr-8">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {logJob && <JobStatusIcon status={logJob.status} />}
            <span className="truncate">{logJob?.label}</span>
          </DialogTitle>
        </DialogHeader>
        {logJob && (
          <div className="flex items-center gap-3">
            {canStop(logJob) && (
              <Button size="xs" variant="destructive" className="gap-1" onClick={() => void onCancel(logJob.id)} disabled={isStopping(logJob)}>
                {isStopping(logJob) ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                {t(isStopping(logJob) ? 'jobs.stopping' : 'jobs.stop')}
              </Button>
            )}
            <JobDuration job={logJob} className="text-xs text-muted-foreground" />
            {cancelError && <span role="alert" className="text-xs text-destructive">{cancelError}</span>}
            {jobInput && (
              <Tabs value={logTab} onValueChange={(v) => setLogTab(v as 'output' | 'input')} className="ml-auto">
                <TabsList variant="line">
                  <TabsTrigger value="input" className="text-xs">{t('jobs.tab_input')}</TabsTrigger>
                  <TabsTrigger value="output" className="text-xs">{t('jobs.tab_output')}</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
          </div>
        )}
        {showInput && logJob ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden rounded border">
              <CodeViewer value={jobInput} language={logJob.kind === 'run' ? 'plaintext' : 'sql'} height="100%" />
            </div>
          </div>
        ) : logJob?.result && logJob.kind !== 'app' ? (
          // With artifacts the body scrolls: log at a fixed share, figures below.
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
            {jobLog ? <JobLogView text={jobLog} height={320} /> : <NoLog />}
            <JobArtifacts result={logJob.result} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {jobLog ? <JobLogView text={jobLog} height="100%" /> : <NoLog />}
          </div>
        )}
      </DialogContent>
    </Dialog>

    <AlertDialog open={confirmStopAll} onOpenChange={setConfirmStopAll}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('jobs.stop_all_title', { count: activeCount })}</AlertDialogTitle>
          <AlertDialogDescription>{t('jobs.stop_all_description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onStopAll}>
            {t('jobs.stop_all')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}

/** A web app's public path, which its job carries. */
function webAppUrl(job: Job): string | null {
  const url = (job.result as { url?: unknown } | null | undefined)?.url
  return typeof url === 'string' ? url : null
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

/** Short local date+time for a job row, e.g. "07/31 14:22" — with the seconds
 *  for a query, a page sends several a minute. Falsy/bad input → ''. */
function formatJobTime(iso: string, seconds = false): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ''}`
}

/** How long a job ran, or has been running (ticking). Nothing while queued. */
function JobDuration({ job, className }: { job: Pick<Job, 'status' | 'startedAt' | 'finishedAt'>; className?: string }) {
  const { t } = useTranslation()
  const live = job.status === 'running' && !!job.startedAt && !job.finishedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  if (!job.startedAt) return null
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : live ? now : null
  if (end == null) return null
  const ms = Math.max(0, end - new Date(job.startedAt).getTime())
  return (
    <span className={cn('tabular-nums', className)} title={t(job.finishedAt ? 'jobs.duration_done' : 'jobs.duration_running')}>
      {formatDuration(ms)}
    </span>
  )
}

function JobStatusIcon({ status }: { status: Job['status'] }) {
  if (status === 'running' || status === 'queued')
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  if (status === 'done') return <CheckCircle2 size={12} className="text-emerald-500" />
  if (status === 'cancelled') return <Ban size={12} className="text-muted-foreground" />
  return <XCircle size={12} className="text-destructive" />
}
