import type { Job } from '@/lib/api/environments'

const ACTIVE = new Set<Job['status']>(['queued', 'running'])

/** Jobs of one action, shown as one row of the panel. */
export interface JobGroupRow {
  key: string
  label: string
  /** Newest first, as listed. */
  jobs: Job[]
  status: Job['status']
  startedAt: string | null
  /** Null while one of its jobs runs. */
  finishedAt: string | null
  createdAt: string
}

export type JobRow = { job: Job } | { group: JobGroupRow }

/** A group's status: running while one runs, else its worst outcome. */
function statusOf(jobs: Job[]): Job['status'] {
  if (jobs.some((j) => j.status === 'running')) return 'running'
  if (jobs.some((j) => j.status === 'queued')) return 'queued'
  if (jobs.some((j) => j.status === 'error')) return 'error'
  if (jobs.some((j) => j.status === 'cancelled')) return 'cancelled'
  return 'done'
}

const earliest = (values: (string | null | undefined)[]) =>
  values.filter((v): v is string => !!v).sort()[0] ?? null
const latest = (values: (string | null | undefined)[]) =>
  values.filter((v): v is string => !!v).sort().at(-1) ?? null

/** The panel's rows, from jobs listed newest first: each group where its newest
 *  job is, holding all of its jobs. A group of one job is that job. */
export function groupJobs(jobs: readonly Job[]): JobRow[] {
  const members = new Map<string, Job[]>()
  for (const job of jobs) {
    if (!job.groupKey) continue
    const list = members.get(job.groupKey)
    if (list) list.push(job)
    else members.set(job.groupKey, [job])
  }
  const rows: JobRow[] = []
  const placed = new Set<string>()
  for (const job of jobs) {
    const list = job.groupKey ? members.get(job.groupKey) : undefined
    if (!list || list.length === 1) {
      rows.push({ job })
      continue
    }
    if (placed.has(job.groupKey!)) continue
    placed.add(job.groupKey!)
    const live = list.some((j) => ACTIVE.has(j.status))
    rows.push({
      group: {
        key: job.groupKey!,
        label: list.find((j) => j.groupLabel)?.groupLabel ?? job.label,
        jobs: list,
        status: statusOf(list),
        startedAt: earliest(list.map((j) => j.startedAt)),
        finishedAt: live ? null : latest(list.map((j) => j.finishedAt)),
        createdAt: earliest(list.map((j) => j.createdAt)) ?? job.createdAt,
      },
    })
  }
  return rows
}
