import { queryDataSource, type QueryOptions } from '@/lib/duckdb/engine'
import { escSql } from '@/lib/format-helpers'

/**
 * What a patient's widgets read, kept for the session, and the next patient's
 * record read while the current one is on screen.
 *
 * Nothing here knows a widget: every query they send goes through
 * `patientQuery`. Its rows are kept, keyed by the exact statement, so coming
 * back to a patient already seen reads nothing. And once the screen has
 * settled, the statements the current patient was shown with are sent again
 * with the next patient's id in place of the current one's, one after the
 * other, into the same store. A widget whose SQL is exactly a kept one gets its
 * rows; any other — another stay, another zoom — queries as before. So a
 * statement the substitution got wrong is only a wasted query, never wrong data.
 *
 * This tab's memory only, bounded: past `MAX_BYTES` the least recently used
 * statements go. A read stopped before its end — the widget moved on, or the
 * patient read ahead was not the one opened — is cancelled on the server and
 * not kept.
 */

const IDLE_MS = 1000
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
  nextPatientId: string | null
}

/** Each board showing patients, by its token; the latest to move leads. */
const owners = new Map<object, Target>()

const state = {
  dataSourceId: null as string | null,
  patientId: null as string | null,
  nextPatientId: null as string | null,
  /** The latest statements the widgets sent, whichever patient or database they
   *  name: a widget's effect runs before the list's, so it queries the new
   *  patient while this module still has the previous one on screen. */
  recorded: [] as { dataSourceId: string; sql: string }[],
  inFlight: 0,
  idleTimer: null as ReturnType<typeof setTimeout> | null,
  /** The patient being read ahead, and the means to stop its reads. */
  ahead: null as { patientId: string; controller: AbortController } | null,
  /** Statement → its rows, least recently used first. */
  kept: new Map<string, Entry>(),
  keptBytes: 0,
}

const literal = (patientId: string) => `'${escSql(patientId)}'`
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

function scheduleIfIdle() {
  clearIdle()
  if (state.inFlight > 0 || !state.nextPatientId || state.ahead?.patientId === state.nextPatientId) return
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
  const { dataSourceId, patientId, nextPatientId } = state
  if (!dataSourceId || !patientId || !nextPatientId) return
  state.ahead?.controller.abort()
  const ahead = { patientId: nextPatientId, controller: new AbortController() }
  state.ahead = ahead
  const { signal } = ahead.controller
  const ours = state.recorded.filter((r) => r.dataSourceId === dataSourceId).map((r) => r.sql)
  // One at a time: the reads are a bet, and must not slow the patient on screen.
  for (const sql of statementsFor(ours, patientId, nextPatientId)) {
    if (signal.aborted) return
    const key = keyOf(dataSourceId, sql)
    if (state.kept.has(key)) continue
    await keep(key, queryDataSource(dataSourceId, sql, { signal })).catch(() => {})
  }
}

function apply(dataSourceId: string | null, patientId: string | null, nextPatientId: string | null) {
  if (dataSourceId !== state.dataSourceId || patientId !== state.patientId) {
    clearIdle()
    const arrived = dataSourceId === state.dataSourceId && patientId != null && state.ahead?.patientId === patientId
    if (!arrived) state.ahead?.controller.abort()
    state.ahead = null
  }
  // The board is gone: nothing it sent is worth replaying, nor waiting for.
  if (dataSourceId === null) {
    state.recorded = []
    state.inFlight = 0
  }
  state.dataSourceId = dataSourceId
  state.patientId = patientId
  state.nextPatientId = nextPatientId === patientId ? null : nextPatientId
  scheduleIfIdle()
}

/**
 * The patient `owner` (a board's token) has on screen and the one after it in
 * its list. Called on every change: reaching the patient read ahead lets its
 * reads finish, anything else stops them. Without a database the owner is
 * released, as by `releasePrefetch`.
 */
export function setPrefetchPatients(owner: object, dataSourceId: string | null, patientId: string | null, nextPatientId: string | null): void {
  if (dataSourceId === null) return releasePrefetch(owner)
  owners.delete(owner)
  owners.set(owner, { dataSourceId, patientId, nextPatientId })
  apply(dataSourceId, patientId, nextPatientId)
}

/** The board is gone: the read ahead follows another one still shown, if any. */
export function releasePrefetch(owner: object): void {
  if (!owners.delete(owner)) return
  const rest = [...owners.values()]
  const lead = rest[rest.length - 1]
  if (lead) apply(lead.dataSourceId, lead.patientId, lead.nextPatientId)
  else apply(null, null, null)
}

/** Forget the kept rows of a database (all of them without one): its data changed. */
export function clearPatientQueries(dataSourceId?: string): void {
  for (const [key, entry] of state.kept) {
    if (dataSourceId && !key.startsWith(`${dataSourceId}\n`)) continue
    state.kept.delete(key)
    state.keptBytes -= entry.bytes
  }
}

function record(dataSourceId: string, sql: string) {
  const at = state.recorded.findIndex((r) => r.dataSourceId === dataSourceId && r.sql === sql)
  if (at >= 0) state.recorded.splice(at, 1)
  state.recorded.push({ dataSourceId, sql })
  if (state.recorded.length > MAX_RECORDED) state.recorded.shift()
}

/** What a patient widget reads: kept rows when the statement was read before. */
export async function patientQuery(dataSourceId: string, sql: string, options: QueryOptions = {}): Promise<Rows> {
  record(dataSourceId, sql)
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
    return await keep(key, queryDataSource(dataSourceId, sql, options))
  } finally {
    state.inFlight = Math.max(0, state.inFlight - 1)
    scheduleIfIdle()
  }
}
