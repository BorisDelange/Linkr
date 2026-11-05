/**
 * Where a query comes from, and — front-only mode — the queries this tab sent.
 *
 * In server mode every query is a job of its database's workspace, kept a day
 * once finished (`query_log_hours`); the server writes it, labelled with the
 * `origin` the app sends. Front-only mode has no server: the queries DuckDB-WASM
 * ran are kept here, in this tab's memory, a day alike, for the jobs panel to
 * list and stop.
 */

/** The app section a path is in, as a query's default origin. */
const SECTIONS: [RegExp, string][] = [
  [/\/warehouse\/cohorts/, 'Cohorts'],
  [/\/warehouse\/patient-data/, 'Patient data'],
  [/\/warehouse\/concepts/, 'Concepts'],
  [/\/warehouse\/data-quality/, 'Data quality'],
  [/\/warehouse\/databases/, 'Databases'],
  [/\/warehouse\/schemas/, 'Schemas'],
  [/\/warehouse\/concept-mapping/, 'Concept mapping'],
  [/\/lab\/datasets/, 'Datasets'],
  [/\/lab\/dashboards/, 'Dashboards'],
  [/\/lab\/reports/, 'Reports'],
  [/\/ide/, 'IDE'],
  [/\/pipeline/, 'Pipeline'],
  [/\/summary/, 'Summary'],
]

/** A query's origin when its caller names none: the page it was sent from. */
export function pageOrigin(path: string = typeof location === 'undefined' ? '' : location.pathname): string {
  return SECTIONS.find(([re]) => re.test(path))?.[1] ?? 'SQL query'
}

/** `Cohort “Sepsis” · members and count`: what a query does for a cohort. */
export function cohortOrigin(name: string, section = 'Cohort'): (what: string) => string {
  const label = name.trim() ? `${section} “${name.trim()}”` : section
  return (what) => `${label} · ${what}`
}

/** "Cohort · Sepsis": a section and what in it sent the query. */
export function originOf(section: string, name?: string | null): string {
  const what = name?.trim()
  return what ? `${section} · ${what}` : section
}

/** The action a query is one of ("Patient 123", opened): the jobs panel shows
 *  the queries of a group under one row. */
export interface JobGroup {
  key: string
  label: string
}

// --- Front-only log ---------------------------------------------------------

export interface LoggedQuery {
  id: string
  dataSourceId: string
  origin: string
  sql: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'error' | 'cancelled'
  rows: number | null
  error: string | null
  group: JobGroup | null
}

/** The SQL of a query is kept whole: past this many queries, in this tab's
 *  memory, the oldest go. */
const MAX_ENTRIES = 2000
/** A finished query is kept this long, as the server keeps its own. */
const KEEP_MS = 24 * 60 * 60 * 1000

let entries: LoggedQuery[] = []
/** How to stop each query still running. */
const stops = new Map<string, () => void>()
const listeners = new Set<() => void>()

function changed() {
  for (const fn of listeners) fn()
}

function prune(now: number) {
  const from = now - KEEP_MS
  if (entries.some((e) => e.status !== 'running' && e.startedAt < from)) {
    entries = entries.filter((e) => e.status === 'running' || e.startedAt >= from)
  }
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
}

/** Record a query starting, and how to `stop` it; the returned function records
 *  how it ended. */
export function logQuery(
  dataSourceId: string, sql: string, origin: string, stop?: () => void, group?: JobGroup,
): (end: { rows?: number; error?: unknown; cancelled?: boolean }) => void {
  const now = Date.now()
  prune(now)
  const entry: LoggedQuery = {
    id: crypto.randomUUID(),
    dataSourceId,
    origin,
    sql,
    startedAt: now,
    finishedAt: null,
    status: 'running',
    rows: null,
    error: null,
    group: group ?? null,
  }
  entries = [...entries, entry]
  if (stop) stops.set(entry.id, stop)
  changed()
  return ({ rows, error, cancelled }) => {
    stops.delete(entry.id)
    const done: LoggedQuery = {
      ...entry,
      finishedAt: Date.now(),
      status: cancelled ? 'cancelled' : error !== undefined ? 'error' : 'done',
      rows: rows ?? null,
      error: error !== undefined && !cancelled ? String(error instanceof Error ? error.message : error) : null,
    }
    entries = entries.map((e) => (e.id === entry.id ? done : e))
    changed()
  }
}

/** This tab's queries, newest first. */
export function loggedQueries(): LoggedQuery[] {
  prune(Date.now())
  return [...entries].reverse()
}

/** Stop a query still running, as its own caller could. */
export function stopLoggedQuery(id: string): void {
  stops.get(id)?.()
}

/** Forget the finished queries. */
export function clearLoggedQueries(): void {
  entries = entries.filter((e) => e.status === 'running')
  changed()
}

export function onQueryLogged(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
