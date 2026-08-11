import * as duckdbEngine from '@/lib/duckdb/engine'
import { getStorage } from '@/lib/storage'
import { quoteIdent } from '@/lib/format-helpers'
import type { DatabaseStatsCache, TableRowCount } from '@/types'

/**
 * Per-table row counts, computed once and shared.
 *
 * Two places count the same tables of the same database: the schema browser
 * ("Count all tables") and the Quality-check statistics. They were independent,
 * so counting in one left the other saying "never counted" — and the second one
 * paid for a full scan the first had just finished.
 *
 * Both now go through here: one persisted entry (`databaseStatsCache`, the same
 * row the Databases page reads), and a subscription so a view already on screen
 * refreshes when the other one recomputes.
 */

type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

/** Tell everyone watching `dataSourceId` that its counts changed. */
export function notifyTableCounts(dataSourceId: string) {
  for (const fn of listeners.get(dataSourceId) ?? []) fn()
}

/**
 * Run `onChange` whenever another view recomputes this database's counts.
 *
 * `onCleanup` runs alongside the unsubscribe, so a caller can cancel its own
 * in-flight read in the same returned teardown.
 */
export function subscribeTableCounts(
  dataSourceId: string,
  onChange: Listener,
  onCleanup?: () => void,
): () => void {
  const set = listeners.get(dataSourceId) ?? new Set<Listener>()
  listeners.set(dataSourceId, set)
  set.add(onChange)
  return () => {
    set.delete(onChange)
    if (set.size === 0) listeners.delete(dataSourceId)
    onCleanup?.()
  }
}

/** The counts already stored for this database, or an empty map. */
export async function loadTableCounts(dataSourceId: string): Promise<Map<string, number>> {
  const cache = await getStorage().databaseStatsCache.get(dataSourceId).catch(() => undefined)
  return new Map((cache?.tableCounts ?? []).map((t) => [t.tableName, t.rowCount]))
}

/** Biggest first — how both the sidebar and the statistics list read them. */
export function sortedCounts(counts: Map<string, number>): TableRowCount[] {
  return [...counts]
    .map(([tableName, rowCount]) => ({ tableName, rowCount }))
    .sort((a, b) => b.rowCount - a.rowCount)
}

/**
 * Merge fresh counts into the stored entry without touching what is not ours.
 *
 * The clinical figures (patients, visits) belong to the statistics computation,
 * so an entry created here leaves them empty rather than claiming zeros — and an
 * existing one keeps them.
 */
export function mergeTableCounts(
  dataSourceId: string,
  existing: DatabaseStatsCache | undefined,
  counts: Map<string, number>,
): DatabaseStatsCache {
  return {
    ...(existing ?? {
      dataSourceId,
      summary: { patientCount: 0, visitCount: 0, visitDetailCount: 0, tableCount: counts.size },
      genderDistribution: { male: 0, female: 0, other: 0 },
      agePyramid: [],
      admissionTimeline: [],
      descriptiveStats: {},
      tableCounts: [],
    }),
    summary: {
      ...(existing?.summary ?? { patientCount: 0, visitCount: 0, visitDetailCount: 0 }),
      tableCount: counts.size,
    },
    computedAt: new Date().toISOString(),
    tableCounts: sortedCounts(counts),
  }
}

interface CountAllOptions {
  /** Names to count. Omitted, every table of the database is discovered. */
  tables?: string[]
  /** Counts already known, kept for tables that fail or are not in `tables`. */
  seed?: Map<string, number>
  /** How many tables counted so far, for a progress readout. */
  onProgress?: (done: number, total: number) => void
  /** Called after each batch is stored, so the caller can paint as it goes. */
  onBatch?: (counts: Map<string, number>) => void
}

/**
 * COUNT(*) every table, in batches, and persist the result.
 *
 * A table that cannot be counted (dropped mid-run, unreadable) is skipped
 * rather than failing the lot: a single bad table must not cost the counts of
 * the forty good ones.
 */
export async function countAllTables(
  dataSourceId: string,
  options: CountAllOptions = {},
): Promise<Map<string, number>> {
  const tables = options.tables ?? await duckdbEngine.discoverTables(dataSourceId)
  const counts = new Map(options.seed ?? [])
  if (tables.length === 0) return counts

  const BATCH = 6
  for (let i = 0; i < tables.length; i += BATCH) {
    const batch = tables.slice(i, i + BATCH)
    const rows = await Promise.all(batch.map(async (table) => {
      try {
        const r = await duckdbEngine.queryDataSource(
          dataSourceId, `SELECT COUNT(*) as cnt FROM ${quoteIdent(table)}`,
        )
        return [table, Number(r[0]?.cnt ?? 0)] as const
      } catch {
        return null
      }
    }))
    for (const row of rows) if (row) counts.set(row[0], row[1])
    options.onBatch?.(new Map(counts))
    options.onProgress?.(Math.min(i + BATCH, tables.length), tables.length)
  }

  const existing = await getStorage().databaseStatsCache.get(dataSourceId).catch(() => undefined)
  await getStorage().databaseStatsCache
    .save(mergeTableCounts(dataSourceId, existing, counts))
    .catch(() => {})
  notifyTableCounts(dataSourceId)
  return counts
}
