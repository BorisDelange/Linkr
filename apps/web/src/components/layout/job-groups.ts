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
  /** The entity all its jobs are for; null when they differ or say none. */
  entity: JobEntity | null
}

export interface JobEntity {
  type: string
  id: string | null
  name: string
}

/** How the panel words what a row is for. */
export interface JobNames {
  /** A burst of jobs of no entity and several sections: "3 jobs sent together". */
  mixed: (count: number) => string
  /** A burst of one entity's jobs of several sections: "Queries". */
  queries: () => string
}

const PLAIN_NAMES: JobNames = {
  mixed: (count) => `${count} jobs`,
  queries: () => 'Queries',
}

/** The entity a job is for, if it says. */
export function entityOf(job: Job): JobEntity | null {
  return job.entityType ? { type: job.entityType, id: job.entityId ?? null, name: job.entityName ?? '' } : null
}

const entityKey = (job: Job) => (job.entityType ? `${job.entityType}:${job.entityId ?? ''}` : '')

/** The part of what a job does before ` · ` ("Concepts" of "Concepts · count records"). */
const sectionOf = (job: Job) => {
  const { action } = splitEntityHead(job.label, entityOf(job))
  return action.includes(' · ') ? action.split(' · ')[0] : null
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

/** Jobs sent this close together, none in a group of its own, are one action
 *  (a page opening, a concept clicked): one row. */
const BURST_MS = 2000

/** What a burst does: the section its jobs share ("Concepts" — the panel names
 *  the entity before it, as for every row), else `queries`; without an entity,
 *  that section, else `mixed`. */
function burstLabel(jobs: Job[], names: JobNames): string {
  const sections = new Set(jobs.map(sectionOf))
  const section = sections.size === 1 ? [...sections][0] : null
  if (section) return section
  return entityOf(jobs[0]) ? names.queries() : names.mixed(jobs.length)
}

/** Each job's group: its own, else the burst it was sent in. */
function groupsOf(jobs: readonly Job[], names: JobNames): Map<string, { key: string; label: string | null }> {
  const of = new Map<string, { key: string; label: string | null }>()
  let burst: Job[] = []
  const flush = () => {
    if (burst.length > 1) {
      // Keyed by its first job: one sent after joins it without reopening it closed.
      const group = { key: `burst:${burst.at(-1)!.id}`, label: burstLabel(burst, names) }
      for (const job of burst) of.set(job.id, group)
    }
    burst = []
  }
  for (const job of jobs) {
    if (job.groupKey) {
      flush()
      of.set(job.id, { key: job.groupKey, label: job.groupLabel ?? null })
      continue
    }
    // One burst is one entity's: a page sending queries to two databases at
    // once shows two rows.
    const last = burst.at(-1)
    if (last && (Date.parse(last.createdAt) - Date.parse(job.createdAt) > BURST_MS || entityKey(last) !== entityKey(job))) flush()
    burst.push(job)
  }
  flush()
  return of
}

/** The panel's rows, from jobs listed newest first: each group where its newest
 *  job is, holding all of its jobs. A group of one job is that job. */
export function groupJobs(jobs: readonly Job[], names: JobNames = PLAIN_NAMES): JobRow[] {
  const groups = groupsOf(jobs, names)
  const members = new Map<string, Job[]>()
  for (const job of jobs) {
    const group = groups.get(job.id)
    if (!group) continue
    const list = members.get(group.key)
    if (list) list.push(job)
    else members.set(group.key, [job])
  }
  const rows: JobRow[] = []
  const placed = new Set<string>()
  for (const job of jobs) {
    const group = groups.get(job.id)
    const list = group ? members.get(group.key) : undefined
    if (!group || !list || list.length === 1) {
      rows.push({ job })
      continue
    }
    if (placed.has(group.key)) continue
    placed.add(group.key)
    const live = list.some((j) => ACTIVE.has(j.status))
    rows.push({
      group: {
        key: group.key,
        label: list.map((j) => groups.get(j.id)?.label).find(Boolean) ?? job.label,
        jobs: list,
        status: statusOf(list),
        startedAt: earliest(list.map((j) => j.startedAt)),
        finishedAt: live ? null : latest(list.map((j) => j.finishedAt)),
        createdAt: earliest(list.map((j) => j.createdAt)) ?? job.createdAt,
        entity: new Set(list.map(entityKey)).size === 1 ? entityOf(job) : null,
      },
    })
  }
  return rows
}

const capitalized = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1)

/**
 * A label's "what it is for" and what the job does: the entity the label starts
 * by naming — `Database “test” · ` of `Database “test” · Patient list`, French
 * quotes alike —, else the bare name of the job's entity it starts with (`test · `,
 * as the server labels a database's queries). No head when it names neither.
 * The action after a head starts with a capital, whoever wrote the label.
 */
export function splitEntityHead(label: string, entity: JobEntity | null = null): { head: string; action: string } {
  const named = /^([^·“«]*[“«][^”»]*[”»]) · /.exec(label)
  if (named) return { head: named[0], action: capitalized(label.slice(named[0].length)) }
  const bare = entity?.name ? `${entity.name} · ` : null
  if (bare && label.startsWith(bare)) return { head: bare, action: capitalized(label.slice(bare.length)) }
  return { head: '', action: label }
}

