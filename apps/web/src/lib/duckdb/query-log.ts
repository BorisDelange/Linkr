/**
 * Where a query comes from, and — front-only mode — the queries this tab sent.
 *
 * In server mode every query is a job of its database's workspace, kept a day
 * (`query_log_hours`); the server writes it, labelled with the `origin` the app
 * sends. Front-only mode has no server: the queries DuckDB-WASM ran are kept
 * here, in this tab's memory, for the jobs panel to list alike.
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
}

const KEEP_MS = 24 * 60 * 60 * 1000
/** The SQL of a query is kept whole; past this many queries the oldest go. */
const MAX_ENTRIES = 2000

let entries: LoggedQuery[] = []
const listeners = new Set<() => void>()

function changed() {
  for (const fn of listeners) fn()
}

function prune(now: number) {
  const from = now - KEEP_MS
  if (entries.length > MAX_ENTRIES || (entries[0] && entries[0].startedAt < from)) {
    entries = entries.filter((e) => e.startedAt >= from).slice(-MAX_ENTRIES)
  }
}

/** Record a query starting; the returned function records how it ended. */
export function logQuery(dataSourceId: string, sql: string, origin: string): (end: { rows?: number; error?: unknown; cancelled?: boolean }) => void {
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
  }
  entries = [...entries, entry]
  changed()
  return ({ rows, error, cancelled }) => {
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

/** This tab's queries over the last day, newest first. */
export function loggedQueries(): LoggedQuery[] {
  prune(Date.now())
  return [...entries].reverse()
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
