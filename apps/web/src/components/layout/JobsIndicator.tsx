import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Ban, CheckCircle2, ChevronRight, Circle, XCircle, Hourglass, Square, Trash2, ExternalLink, ScrollText } from 'lucide-react'
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
import { prettySql } from '@/lib/sql-pretty'
import { sanitizeHtml } from '@/lib/sanitize'
import { useProjectRouteUid } from '@/hooks/use-project-route'
import { listJobs, listWorkspaceJobs, listRunningJobs, cancelJob, clearJobs, clearWorkspaceJobs, onJobsChanged, type InstanceJob, type Job, type JobStep } from '@/lib/api/environments'
import { useAuthStore } from '@/stores/auth-store'
import { getJob } from '@/lib/api/query-jobs'
import { openWebAppWindow, webAppFrameUrl } from '@/lib/api/web-apps'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useDataSourceStore } from '@/stores/data-source-store'
import { clearLoggedQueries, stopLoggedQuery } from '@/lib/duckdb/query-log'
import { QUERY_KIND, useLocalQueries } from './use-query-log'
import { entityOf, groupJobs, splitEntityHead, type JobEntity, type JobGroupRow, type JobNames } from './job-groups'
import type { TFunction } from 'i18next'

const ACTIVE = new Set(['queued', 'running'])
// One height whatever the count — about 13 rows, then a scroll — so the
// popover does not jump as jobs come and go.
const JOB_LIST_CLASS = 'flex h-96 max-h-[60vh] flex-col gap-1 overflow-y-auto'
const EMPTY_CLASS = 'm-auto px-1.5 text-center text-xs text-muted-foreground'

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
      j.stopping === o.stopping &&
      j.finishedAt === o.finishedAt &&
      JSON.stringify(j.steps) === JSON.stringify(o.steps)
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

  // An administrator also sees, and may stop, every user's running jobs.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin') && server
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const showAll = isAdmin && scope === 'all'
  const [instanceJobs, setInstanceJobs] = useState<InstanceJob[]>([])
  useEffect(() => {
    if (!showAll || !popoverOpen) return
    let cancelled = false
    const tick = () => {
      listRunningJobs()
        .then((all) => { if (!cancelled) setInstanceJobs(all) })
        .catch((err) => console.warn('[jobs] listing the server\'s jobs failed', err))
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [showAll, popoverOpen, reloadTick])

  // The input and the log travel only with the single job: fetched once the
  // modal opens, again while the job runs — a run's input is its query in flight.
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
        if (openActive && ACTIVE.has(j.status)) timer = setTimeout(() => void read(true), 2000)
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
  const names = useMemo<JobNames>(() => ({
    mixed: (count) => t('jobs.burst', { count }),
    queries: () => t('jobs.burst_queries'),
  }), [t])
  const rows = useMemo(() => groupJobs(listed, names), [listed, names])
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
  // Asked here, or anywhere else (a pause of the run it serves): the server says.
  const isStopping = (job: Job) => (stopping.has(job.id) || !!job.stopping) && ACTIVE.has(job.status)
  // A job seen but out of the panel's reach (a connection test) shows no Stop.
  const canStop = (job: Job) => ACTIVE.has(job.status) && job.cancellable !== false
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const logJob = listed.find((j) => j.id === logJobId) ?? null
  // A front-only query carries its SQL; a server job's is fetched once opened.
  const opened = detail && detail.jobId === logJobId ? detail : null
  const jobInput = !server ? (logJob?.input ?? null) : opened?.input ?? null
  const jobLog = !server ? (logJob?.logTail ?? '') : opened?.logTail ?? ''
  const showInput = logTab === 'input' && !!jobInput
  const inputLanguage = logJob?.kind === 'run' ? 'plaintext' : 'sql'
  const shownInput = usePrettySql(jobInput, showInput && inputLanguage === 'sql')

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

  const hasFinished = listed.some((j) => !ACTIVE.has(j.status))

  const openLog = (job: Job) => {
    setLogJobId(job.id)
    setLogTab(job.kind === QUERY_KIND ? 'input' : 'output')
    setPopoverOpen(false)
  }

  const renderJob = (job: Job) => {
    // A job of several steps unfolds into them, as a group into its jobs.
    const steps = job.steps && job.steps.length > 1 ? job.steps : null
    const stepsKey = `steps:${job.id}`
    const unfolded = !!steps && openGroups.has(stepsKey)
    return (
      <li key={job.id}>
        <div className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
          {/* Click the row to open the full log in a modal, or a job of steps to unfold them. */}
          <button
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => (steps ? toggleGroup(stepsKey) : openLog(job))}
            {...(steps ? { 'aria-expanded': unfolded } : { 'aria-label': `${job.label} — ${t('jobs.show_log')}` })}
          >
            <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
              {formatJobTime(job.createdAt)}
            </span>
            <span className="flex shrink-0"><JobStatusIcon status={job.status} /></span>
            {steps && (
              <ChevronRight size={12} className={cn('shrink-0 translate-y-px text-muted-foreground transition-transform', unfolded && 'rotate-90')} />
            )}
            {/* One line, named by what it is for; on hover, the whole label and
                what it is for, in full. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate py-px leading-normal">
                  <JobLabel entity={entityOf(job)} label={job.label} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4} className="max-w-96">
                <JobFacts entity={entityOf(job)} label={job.label} job={job} />
              </TooltipContent>
            </Tooltip>
            {job.kind === QUERY_KIND && job.status === 'done' && (
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{job.summary}</span>
            )}
            {job.status === 'running' && job.progress > 0 && (
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{job.progress}%</span>
            )}
            {isStopping(job) && <span className="shrink-0 text-[10px] text-destructive">{t('jobs.stopping')}</span>}
            <JobDuration job={job} className="ml-auto shrink-0 text-[10px] text-muted-foreground" />
          </button>
          {steps && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => openLog(job)} aria-label={t('jobs.show_log')}>
                  <ScrollText size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>{t('jobs.show_log')}</TooltipContent>
            </Tooltip>
          )}
          {job.kind === 'app' && ACTIVE.has(job.status) && webAppUrl(job) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={webAppFrameUrl(webAppUrl(job)!)}
                  target="_blank"
                  rel="noopener"
                  onClick={(e) => {
                    const appId = (job.result as { appId?: unknown } | null | undefined)?.appId
                    if (typeof appId !== 'string') return
                    e.preventDefault()
                    setCancelError(null)
                    void openWebAppWindow({ appId, url: webAppUrl(job)! }).catch((err) => {
                      setCancelError(t('web_apps.session_failed', { error: err instanceof Error ? err.message : String(err) }))
                    })
                  }}
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
        </div>
        {unfolded && (
          <ul className="ml-3 flex flex-col gap-1 border-l pl-1">
            {steps.map((step) => <JobStepRow key={step.key} step={step} jobStatus={job.status} />)}
          </ul>
        )}
      </li>
    )
  }

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
          {isAdmin ? (
            <Tabs value={scope} onValueChange={(v) => setScope(v as 'mine' | 'all')}>
              <TabsList variant="line">
                <TabsTrigger value="mine" className="text-xs">{t('jobs.recent')}</TabsTrigger>
                <TabsTrigger value="all" className="text-xs">{t('jobs.all_users')}</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : (
            <span className="font-medium">{t('jobs.recent')}</span>
          )}
          {!showAll && <div className="flex items-center gap-3">
            {listed.some(canStop) && (
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmStopAll(true)}
              >
                <Square size={11} />
                {t('jobs.stop_all')}
              </button>
            )}
            {hasFinished && (
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => void onClearAll()}
              >
                <Trash2 size={11} />
                {t('jobs.clear_all')}
              </button>
            )}
          </div>}
        </div>
        {cancelError && (
          <p role="alert" className="mb-2 px-1.5 text-[10px] text-destructive">{cancelError}</p>
        )}
        {showAll ? (
          <InstanceJobList jobs={instanceJobs} onCancel={onCancel} stopping={stopping} />
        ) : (<>
        <p className="mb-1.5 px-1.5 text-[10px] text-muted-foreground">{t(server ? 'jobs.queries_hint' : 'jobs.queries_hint_local')}</p>
        {/* A delay, so someone who knows these icons is not shown the tooltip
            at each pass; moving from one icon to the next shows it at once. */}
        <TooltipProvider delayDuration={600}>
          <ul className={JOB_LIST_CLASS}>
            {listed.length === 0 && <li className={EMPTY_CLASS}>{t('jobs.empty')}</li>}
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
                      {formatJobTime(row.group.createdAt)}
                    </span>
                    <span className="flex shrink-0"><JobStatusIcon status={row.group.status} /></span>
                    {/* A pixel down: centred on the label's lowercase, which reads lower than its box's middle. */}
                    <ChevronRight
                      size={12}
                      className={cn('shrink-0 translate-y-px text-muted-foreground transition-transform', openGroups.has(row.group.key) && 'rotate-90')}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="min-w-0 truncate py-px font-medium leading-normal">
                          <JobLabel entity={row.group.entity} label={row.group.label} />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4} className="max-w-96">
                        <JobFacts entity={row.group.entity} label={row.group.label} job={row.group} jobs={row.group.jobs.length} />
                      </TooltipContent>
                    </Tooltip>
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
                    {row.group.jobs.map((job) => renderJob(job))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </TooltipProvider>
        </>)}
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
            {logJob.status === 'running' && logJob.progress > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">{logJob.progress}%</span>
            )}
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
              <CodeViewer value={shownInput ?? jobInput} language={inputLanguage} height="100%" />
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

/** Every user's queued and running jobs, for an administrator to stop. */
function InstanceJobList({ jobs, onCancel, stopping }: {
  jobs: InstanceJob[]
  onCancel: (id: string) => Promise<void>
  stopping: ReadonlySet<string>
}) {
  const { t } = useTranslation()
  return (
    <>
      <p className="mb-1.5 px-1.5 text-[10px] text-muted-foreground">{t('jobs.all_users_hint')}</p>
      <ul className={JOB_LIST_CLASS}>
        {jobs.length === 0 && <li className={EMPTY_CLASS}>{t('jobs.all_users_empty')}</li>}
        {jobs.map((job) => (
          <li key={job.id} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted/50">
            <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
              {formatJobTime(job.createdAt)}
            </span>
            <span className="flex shrink-0"><JobStatusIcon status={job.status} /></span>
            <span className="min-w-0 flex-1 truncate py-px leading-normal" title={job.label}><JobLabel entity={entityOf(job)} label={job.label} /></span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{job.username ?? '—'}</span>
            <JobDuration job={job} className="shrink-0 text-[10px] text-muted-foreground" />
            {job.cancellable !== false && (
              <button
                className="shrink-0 text-muted-foreground hover:text-destructive disabled:text-destructive"
                onClick={() => void onCancel(job.id)}
                disabled={stopping.has(job.id)}
                aria-label={t(stopping.has(job.id) ? 'jobs.stopping' : 'jobs.cancel_tooltip')}
                title={t(stopping.has(job.id) ? 'jobs.stopping' : 'jobs.cancel_tooltip')}
              >
                {stopping.has(job.id) ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

/** "Database “test”": what a job is for, as the panel names it. */
function entityLabel(t: TFunction, entity: JobEntity): string {
  const type = t(`jobs.entity_types.${entity.type}`, { defaultValue: entity.type })
  return entity.name ? t('jobs.entity_label', { type, name: entity.name }) : type
}

/** A job's label, always `Type “name” · what it does`, what it is for in grey:
 *  the entity the label starts by naming, else the job's entity. */
function JobLabel({ entity, label }: { entity: JobEntity | null; label: string }) {
  const { t } = useTranslation()
  const { head, action } = splitEntityHead(label, entity)
  const prefix = entity && !/[“«]/.test(head) ? `${entityLabel(t, entity)} · ` : head
  return (
    <>
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      {action}
    </>
  )
}

/** A row on hover: what it is for, what it does, how it stands, since when. */
function JobFacts({ entity, label, job, jobs }: {
  entity: JobEntity | null
  label: string
  job: Pick<Job, 'status' | 'createdAt' | 'startedAt' | 'finishedAt'>
  jobs?: number
}) {
  const { t, i18n } = useTranslation()
  const at = (iso: string) => new Date(iso).toLocaleString(i18n.language)
  const { action } = splitEntityHead(label, entity)
  const facts: [string, string][] = [
    ...(entity ? [[t('jobs.fact_type'), t(`jobs.entity_types.${entity.type}`, { defaultValue: entity.type })] as [string, string]] : []),
    ...(entity?.name ? [[t('jobs.fact_name'), entity.name] as [string, string]] : []),
    [t('jobs.fact_action'), action],
    ...(jobs ? [[t('jobs.fact_jobs'), String(jobs)] as [string, string]] : []),
    [t('jobs.fact_status'), t(`jobs.status.${job.status}`)],
    [t('jobs.fact_started'), at(job.createdAt)],
    ...(job.finishedAt ? [[t('jobs.fact_ended'), at(job.finishedAt)] as [string, string]] : []),
    ...(job.finishedAt && job.startedAt
      ? [[t('jobs.fact_duration'), formatDuration(Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)))] as [string, string]]
      : []),
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {facts.map(([term, value]) => (
        <Fragment key={term}>
          <dt className="opacity-70">{term}</dt>
          <dd className="break-words">{value}</dd>
        </Fragment>
      ))}
    </dl>
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
      <CodeViewer value={plain} language="shell" height={height} followEnd />
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

/** Short local date+time for a job row, e.g. "07/31 14:22:05" — the seconds
 *  because a page sends several queries a minute. Falsy/bad input → ''. */
function formatJobTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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

/** A step of a job: how far it is, or that it waits for the ones before it. */
function JobStepRow({ step, jobStatus }: { step: JobStep; jobStatus: Job['status'] }) {
  const { t } = useTranslation()
  // A step the job left mid-way (stopped, failed) reads as the job ended.
  const icon = step.status === 'done' ? <JobStatusIcon status="done" />
    : step.status === 'active' ? <JobStatusIcon status={ACTIVE.has(jobStatus) ? 'running' : jobStatus} />
      : <Circle size={12} className="text-muted-foreground/50" />
  return (
    <li className="flex items-center gap-1.5 rounded px-1.5 py-1">
      <span className="flex shrink-0">{icon}</span>
      <span className={cn('min-w-0 truncate', step.status === 'pending' && 'text-muted-foreground')}>{step.label}</span>
      <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">
        {step.status === 'pending'
          ? t('jobs.step_pending')
          : step.status === 'active'
            ? `${step.total > 0 ? `${step.done}/${step.total} · ` : ''}${Math.floor(step.share * 100)}%`
            : null}
      </span>
    </li>
  )
}

function JobStatusIcon({ status }: { status: Job['status'] }) {
  if (status === 'running' || status === 'queued')
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  if (status === 'done') return <CheckCircle2 size={12} className="text-emerald-500" />
  if (status === 'cancelled') return <Ban size={12} className="text-muted-foreground" />
  return <XCircle size={12} className="text-destructive" />
}

// Past this, the layout would cost more than it helps: shown as it came.
const PRETTY_MAX = 100_000

/** `sql` laid out for reading once `on`; the text as it came meanwhile. */
function usePrettySql(sql: string | null, on: boolean): string | null {
  const [pretty, setPretty] = useState<{ from: string; text: string } | null>(null)
  useEffect(() => {
    if (!on || !sql || sql.length > PRETTY_MAX) return
    let live = true
    void prettySql(sql).then((text) => { if (live) setPretty({ from: sql, text }) })
    return () => { live = false }
  }, [sql, on])
  return sql && pretty?.from === sql ? pretty.text : sql
}
