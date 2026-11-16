import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Ban, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format-helpers'
import type { Job, JobStep } from '@/lib/api/environments'
import { ACTIVE_JOB_STATUSES, splitEntityHead, type JobEntity } from './job-groups'

/** "Database “test”": what a job is for, as the panel names it. */
function entityLabel(t: TFunction, entity: JobEntity): string {
  const type = t(`jobs.entity_types.${entity.type}`, { defaultValue: entity.type })
  return entity.name ? t('jobs.entity_label', { type, name: entity.name }) : type
}

/** A job's label, always `Type “name” · what it does`, what it is for in grey:
 *  the entity the label starts by naming, else the job's entity. */
export function JobLabel({ entity, label }: { entity: JobEntity | null; label: string }) {
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
export function JobFacts({ entity, label, job, jobs }: {
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

/** How long a job ran, or has been running (ticking). Nothing while queued. */
export function JobDuration({ job, className }: { job: Pick<Job, 'status' | 'startedAt' | 'finishedAt'>; className?: string }) {
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
export function JobStepRow({ step, jobStatus }: { step: JobStep; jobStatus: Job['status'] }) {
  const { t } = useTranslation()
  // A step the job left mid-way (stopped, failed) reads as the job ended.
  const icon = step.status === 'done' ? <JobStatusIcon status="done" />
    : step.status === 'active' ? <JobStatusIcon status={ACTIVE_JOB_STATUSES.has(jobStatus) ? 'running' : jobStatus} />
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

export function JobStatusIcon({ status }: { status: Job['status'] }) {
  if (status === 'running' || status === 'queued')
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  if (status === 'done') return <CheckCircle2 size={12} className="text-emerald-500" />
  if (status === 'cancelled') return <Ban size={12} className="text-muted-foreground" />
  return <XCircle size={12} className="text-destructive" />
}
