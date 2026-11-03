import { queryDataSource, type QueryOptions } from '@/lib/duckdb/engine'
import type { JobGroup } from '@/lib/duckdb/query-log'
import { escSql } from '@/lib/format-helpers'
import { usePatientChartStore } from '@/stores/patient-chart-store'

/**
 * What a patient's widgets read, kept for the session, and the next patients'
 * records read while the current one is on screen.
 *
 * Nothing here knows a widget: every query they send goes through
 * `patientQuery`. Its rows are kept, keyed by the exact statement, so coming
 * back to a patient already seen reads nothing. And once the screen has
 * settled, the statements the current patient was shown with are sent again
 * with each of the next patients' ids in place of the current one's — the
 * board's `readAheadPatients`, in list order, one statement after the other —
 * into the same store. A widget whose SQL is exactly a kept one gets its
 * rows; any other — another stay, another zoom — queries as before. So a
 * statement the substitution got wrong is only a wasted query, never wrong data.
 *
 * This tab's memory only, bounded: past `MAX_BYTES` the least recently used
 * statements go. A read stopped before its end — the widget moved on, or a
 * patient read ahead fell out of the patients ahead (another one opened, further
 * down or elsewhere) — is cancelled on the server and not kept. Moving to the
 * next patient keeps the reads of those still ahead going.
 *
 * In the jobs panel, opening a patient is one row: its widgets' reads and those
 * of the patients read ahead from it, stopped together from there.
 */

const IDLE_MS = 1000
/** Patients read ahead by a board that says nothing, and the most it may ask. */
export const DEFAULT_READ_AHEAD = 1
export const MAX_READ_AHEAD = 10
const MAX_RECORDED = 100
/** Roughly what the kept rows may take in memory. */
const MAX_BYTES = 64 * 1024 * 1024
/** A result larger than this is not worth evicting everything else for. */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
/** What an entry costs besides its rows, so empty results still count. */
const ENTRY_OVERHEAD_BYTES = 64

type Rows = Record<string, unknown>[]

interface Entry {
  read: Promise<Rows>
  /** Known once the rows are in. */
  bytes: number
}

interface Target {
  dataSourceId: string
  patientId: string | null
  aheadIds: readonly string[]
}

/** Each board showing patients, by its token; the latest to move leads. */
const owners = new Map<object, Target>()

const state = {
  dataSourceId: null as string | null,
  patientId: null as string | null,
  /** The patients to read ahead, nearest first. */
  aheadIds: [] as readonly string[],
  /** The latest statements the widgets sent, whichever patient or database they
   *  name: a widget's effect runs before the list's, so it queries the new
   *  patient while this module still has the previous one on screen. */
  recorded: [] as { dataSourceId: string; sql: string; origin?: string }[],
  inFlight: 0,
  idleTimer: null as ReturnType<typeof setTimeout> | null,
  /** Each patient being read ahead, and the means to stop its reads. */
  ahead: new Map<string, AbortController>(),
  /** Bumped by every walk through the patients ahead: an older one stops. */
  walk: 0,
  /** The patient and patients ahead the latest walk was for. */
  walkedFor: null as string | null,
  /** Statement → its rows, least recently used first. */
  kept: new Map<string, Entry>(),
  keptBytes: 0,
}

/** The patient opened last, and the group its reads show under. */
let opened: { patientId: string; group: JobGroup } | null = null

const literal = (patientId: string) => `'${escSql(patientId)}'`

/** The group of a widget's statement: that of the patient it names, opened anew
 *  when it is not the one opened last. A widget's effect runs before the list's,
 *  so the patient is read from the statement, not from `state`. */
function groupOf(sql: string): JobGroup | undefined {
  if (opened && sql.includes(literal(opened.patientId))) return opened.group
  const shown = Object.values(usePatientChartStore.getState().selectedPatientId)
  const patientId = shown.find((id): id is string => !!id && sql.includes(literal(id)))
  if (!patientId) return undefined
  opened = { patientId, group: { key: `patient:${crypto.randomUUID()}`, label: `Patient ${patientId}` } }
  return opened.group
}
const keyOf = (dataSourceId: string, sql: string) => `${dataSourceId}\n${sql}`
const entryBytes = (key: string, rows: Rows) => ENTRY_OVERHEAD_BYTES + key.length * 2 + estimateBytes(rows)

/** About what the rows take in memory: their text, and a few bytes a value. */
export function estimateBytes(rows: Rows): number {
  let bytes = 0
  for (const row of rows) {
    for (const key in row) {
      const v = row[key]
      bytes += 16 + (typeof v === 'string' ? v.length * 2 : 0)
    }
  }
  return bytes
}

function evict() {
  for (const [key, entry] of state.kept) {
    if (state.keptBytes <= MAX_BYTES) return
    state.kept.delete(key)
    state.keptBytes -= entry.bytes
  }
}

/** Keep the rows `read` will give under `key`; a read that fails is forgotten. */
function keep(key: string, read: Promise<Rows>): Promise<Rows> {
  const entry: Entry = { read, bytes: 0 }
  state.kept.set(key, entry)
  read.then((rows) => {
    if (state.kept.get(key) !== entry) return
    const bytes = entryBytes(key, rows)
    if (bytes > MAX_ENTRY_BYTES) {
      state.kept.delete(key)
      return
    }
    entry.bytes = bytes
    state.keptBytes += bytes
    evict()
  }, () => {
    if (state.kept.get(key) === entry) state.kept.delete(key)
  })
  return read
}

/** The kept read of exactly this statement, marked as just used. */
function takeKept(key: string): Promise<Rows> | undefined {
  const entry = state.kept.get(key)
  if (!entry) return undefined
  state.kept.delete(key)
  state.kept.set(key, entry)
  return entry.read
}

function clearIdle() {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = null
}

const windowKey = () => `${state.patientId}\n${state.aheadIds.join('\n')}`

function scheduleIfIdle() {
  clearIdle()
  if (state.inFlight > 0 || state.aheadIds.length === 0 || state.walkedFor === windowKey()) return
  state.idleTimer = setTimeout(() => void readAhead(), IDLE_MS)
}

/** The current patient's statements, rewritten for `to`; those naming the
 *  current patient nowhere are left out. */
export function statementsFor(recorded: readonly string[], from: string, to: string): string[] {
  const fromLit = literal(from)
  const toLit = literal(to)
  return [...new Set(recorded.filter((sql) => sql.includes(fromLit)).map((sql) => sql.split(fromLit).join(toLit)))]
}

async function readAhead() {
  const { dataSourceId, patientId, aheadIds } = state
  if (!dataSourceId || !patientId || aheadIds.length === 0) return
  const walk = ++state.walk
  state.walkedFor = windowKey()
  const group = opened?.patientId === patientId ? opened.group : undefined
  const recorded = state.recorded.filter((r) => r.dataSourceId === dataSourceId)
  const ours = recorded.map((r) => r.sql)
  // One patient after the other, one statement at a time: the reads are a bet,
  // and must not slow the patient on screen. A read an earlier walk left going
  // is waited for, not sent twice.
  for (const aheadId of aheadIds) {
    let controller = state.ahead.get(aheadId)
    if (!controller) {
      controller = new AbortController()
      state.ahead.set(aheadId, controller)
    }
    // What each statement is for, said again of the patient it is read for.
    const purpose = new Map(recorded.flatMap((r) => statementsFor([r.sql], patientId, aheadId).map((sql) => [sql, r.origin] as const)))
    for (const sql of statementsFor(ours, patientId, aheadId)) {
      if (walk !== state.walk || controller.signal.aborted) return
      const key = keyOf(dataSourceId, sql)
      const kept = state.kept.get(key)
      if (kept) await kept.read.catch(() => {})
      else await keep(key, queryDataSource(dataSourceId, sql, {
        signal: controller.signal,
        origin: `Read ahead, patient ${aheadId} · ${purpose.get(sql) ?? 'patient board'}`,
        group,
      })).catch(() => {})
    }
  }
}

function apply(dataSourceId: string | null, patientId: string | null, aheadIds: readonly string[]) {
  const ahead = aheadIds.filter((id) => id !== patientId)
  // Reads for a patient still ahead go on, and so do the reached one's; the
  // others are a bet lost.
  const sameSource = dataSourceId === state.dataSourceId
  for (const [id, controller] of state.ahead) {
    if (sameSource && (id === patientId || ahead.includes(id))) {
      if (id === patientId) state.ahead.delete(id)
      continue
    }
    controller.abort()
    state.ahead.delete(id)
  }
  if (!sameSource || patientId !== state.patientId || ahead.join('\n') !== state.aheadIds.join('\n')) {
    clearIdle()
    state.walk++
    state.walkedFor = null
  }
  // The board is gone: nothing it sent is worth replaying, nor waiting for.
  if (dataSourceId === null) {
    state.recorded = []
    state.inFlight = 0
  }
  state.dataSourceId = dataSourceId
  state.patientId = patientId
  state.aheadIds = ahead
  scheduleIfIdle()
}

/**
 * The patient `owner` (a board's token) has on screen and the ones after it in
 * its list to read ahead, nearest first (none: nothing is read ahead). Called on
 * every change: reaching a patient read ahead lets its reads finish, those of
 * the patients still ahead go on, the others stop. Without a database the owner
 * is released, as by `releasePrefetch`.
 */
export function setPrefetchPatients(owner: object, dataSourceId: string | null, patientId: string | null, aheadIds: readonly string[]): void {
  if (dataSourceId === null) return releasePrefetch(owner)
  owners.delete(owner)
  owners.set(owner, { dataSourceId, patientId, aheadIds })
  apply(dataSourceId, patientId, aheadIds)
}

/** The board is gone: the read ahead follows another one still shown, if any. */
export function releasePrefetch(owner: object): void {
  if (!owners.delete(owner)) return
  const rest = [...owners.values()]
  const lead = rest[rest.length - 1]
  if (lead) apply(lead.dataSourceId, lead.patientId, lead.aheadIds)
  else apply(null, null, [])
}

/** Forget the kept rows of a database (all of them without one): its data changed. */
export function clearPatientQueries(dataSourceId?: string): void {
  for (const [key, entry] of state.kept) {
    if (dataSourceId && !key.startsWith(`${dataSourceId}\n`)) continue
    state.kept.delete(key)
    state.keptBytes -= entry.bytes
  }
}

function record(dataSourceId: string, sql: string, origin?: string) {
  const at = state.recorded.findIndex((r) => r.dataSourceId === dataSourceId && r.sql === sql)
  if (at >= 0) state.recorded.splice(at, 1)
  state.recorded.push({ dataSourceId, sql, origin })
  if (state.recorded.length > MAX_RECORDED) state.recorded.shift()
}

/** What a patient widget reads: kept rows when the statement was read before. */
export async function patientQuery(dataSourceId: string, sql: string, options: QueryOptions = {}): Promise<Rows> {
  record(dataSourceId, sql, options.origin)
  const key = keyOf(dataSourceId, sql)
  const kept = takeKept(key)
  if (kept) {
    try {
      return await kept
    } catch {
      // Stopped or failed: read it now, as if never kept.
    }
  }
  state.inFlight++
  clearIdle()
  try {
    return await keep(key, queryDataSource(dataSourceId, sql, { origin: 'Patient board', group: groupOf(sql), ...options }))
  } finally {
    state.inFlight = Math.max(0, state.inFlight - 1)
    scheduleIfIdle()
  }
}
