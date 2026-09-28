import { getDuckDB, registerResetHook } from '@/lib/duckdb/engine'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { deleteScoresFile, getScoresFile, saveScoresFile } from './scores-storage'
import { getStorage } from '@/lib/storage'
import type { ParsedScoreRow } from './scores-parser'
import type { ScoresIndex, SuggestionCategory } from '@/types'
import { categoryForMethod } from './syntactic-suggestions'
import {
  CSV_OPTIONAL_COLUMNS,
  CSV_REQUIRED_COLUMNS,
  csvPathForMethod,
  csvToScoresSelect,
  methodCsvCopySql,
  methodStatsSql,
  sqlLiteral,
  type ScoreMethodStat,
} from './scores-csv'

const DEFAULT_EQUIVALENCE = 'skos:exactMatch'
const CACHE_MAX = 50

const registered = new Map<string, string>()
const cache = new Map<string, ParsedScoreRow[]>()

function fileNameFor(projectId: string): string {
  return `scores_${projectId}.parquet`
}

function cacheKey(projectId: string, vocabId: string, code: string): string {
  return `${projectId}::${vocabId}::${code}`
}

function rememberInCache(key: string, rows: ParsedScoreRow[]): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, rows)
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) cache.delete(firstKey)
  }
}

function invalidateProjectCache(projectId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectId}::`)) cache.delete(key)
  }
}

async function ensureRegisteredInternal(projectId: string): Promise<string | null> {
  const existing = registered.get(projectId)
  if (existing) return existing
  const file = await getScoresFile(projectId)
  if (!file) return null
  const db = await getDuckDB()
  const name = fileNameFor(projectId)
  try { await db.dropFile(name) } catch { /* not registered yet */ }
  const { DuckDBDataProtocol } = await import('@duckdb/duckdb-wasm')
  await db.registerFileHandle(name, file, DuckDBDataProtocol.BROWSER_FILEREADER, true)
  registered.set(projectId, name)
  return name
}

export function resetEngine(): void {
  registered.clear()
  cache.clear()
}

registerResetHook(resetEngine)

export async function unregisterProject(projectId: string): Promise<void> {
  const name = registered.get(projectId)
  if (!name) return
  try {
    const db = await getDuckDB()
    await db.dropFile(name)
  } catch { /* ignore */ }
  registered.delete(projectId)
  invalidateProjectCache(projectId)
}

function rowToParsed(r: Record<string, unknown>): ParsedScoreRow | null {
  const sourceVocabId = String(r.source_vocabulary_id ?? '')
  const sourceConceptCode = String(r.source_concept_code ?? '')
  const conceptId = Number(r.concept_id ?? 0)
  const method = String(r.method ?? '')
  const score = Number(r.score ?? 0)
  if (!sourceVocabId || !sourceConceptCode || !conceptId || !method) return null
  const equivalence = r.equivalence != null && String(r.equivalence) !== ''
    ? String(r.equivalence)
    : DEFAULT_EQUIVALENCE
  const comment = r.comment != null && String(r.comment) !== '' ? String(r.comment) : null
  const createdAt = r.created_at != null && String(r.created_at) !== '' ? String(r.created_at) : null
  // Optional columns: absent in scores files produced before data-dictionary
  // support. Read defensively so legacy parquets still parse.
  const conceptSetUid = r.concept_set_uid != null && String(r.concept_set_uid) !== '' ? String(r.concept_set_uid) : null
  const conceptSetSourceRepo = r.concept_set_source_repo != null && String(r.concept_set_source_repo) !== '' ? String(r.concept_set_source_repo) : null
  return {
    source_vocabulary_id: sourceVocabId,
    source_concept_code: sourceConceptCode,
    concept_id: conceptId,
    method,
    score,
    equivalence,
    comment,
    created_at: createdAt,
    concept_set_uid: conceptSetUid,
    concept_set_source_repo: conceptSetSourceRepo,
  }
}

export async function queryScoresForSource(
  projectId: string,
  vocabId: string,
  code: string,
): Promise<ParsedScoreRow[]> {
  if (!vocabId || !code) return []
  const key = cacheKey(projectId, vocabId, code)
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const name = await ensureRegisteredInternal(projectId)
  if (!name) return []

  const db = await getDuckDB()
  const conn = await db.connect()
  try {
    const stmt = await conn.prepare(
      // SELECT * (not an explicit column list) so scores files produced before
      // the concept_set_* columns existed still load — rowToParsed fills the
      // missing fields with null.
      `SELECT *
       FROM read_parquet('${name}')
       WHERE source_vocabulary_id = ? AND source_concept_code = ?`,
    )
    try {
      const result = await stmt.query(vocabId, code)
      const rows: ParsedScoreRow[] = []
      for (const r of result.toArray()) {
        const parsed = rowToParsed(r.toJSON() as Record<string, unknown>)
        if (parsed) rows.push(parsed)
      }
      rememberInCache(key, rows)
      return rows
    } finally {
      await stmt.close()
    }
  } finally {
    await conn.close()
  }
}

export async function buildIndex(projectId: string): Promise<ScoresIndex | null> {
  const name = await ensureRegisteredInternal(projectId)
  if (!name) return null

  const db = await getDuckDB()
  const conn = await db.connect()
  try {
    const totalResult = await conn.query(`SELECT COUNT(*) AS n FROM read_parquet('${name}')`)
    const totalRow = totalResult.toArray()[0]?.toJSON() as { n: number | bigint } | undefined
    const rowCount = Number(totalRow?.n ?? 0)

    const methodsResult = await conn.query(
      `SELECT DISTINCT method FROM read_parquet('${name}') ORDER BY method`,
    )
    const methods = methodsResult.toArray()
      .map((r) => String((r.toJSON() as { method: unknown }).method ?? ''))
      .filter(Boolean)

    const keysResult = await conn.query(
      `SELECT DISTINCT source_vocabulary_id, source_concept_code FROM read_parquet('${name}')`,
    )
    const sourceKeys = new Set<string>()
    for (const r of keysResult.toArray()) {
      const j = r.toJSON() as { source_vocabulary_id: unknown; source_concept_code: unknown }
      const v = String(j.source_vocabulary_id ?? '')
      const c = String(j.source_concept_code ?? '')
      if (v && c) sourceKeys.add(`${v}::${c}`)
    }

    // Per-category source keys. Method categories (syntactic/semantic/statistical/
    // agentic) come from guaranteed columns; data_dictionary needs concept_set_uid,
    // so it runs in a separate guarded query — a legacy parquet missing that column
    // must not wipe out the method categories.
    const categorySourceKeys: Record<SuggestionCategory, Set<string>> = {
      syntactic: new Set(), semantic: new Set(), statistical: new Set(), agentic: new Set(), data_dictionary: new Set(),
    }
    const methodResult = await conn.query(
      `SELECT DISTINCT source_vocabulary_id, source_concept_code, method FROM read_parquet('${name}')`,
    )
    for (const r of methodResult.toArray()) {
      const j = r.toJSON() as { source_vocabulary_id: unknown; source_concept_code: unknown; method: unknown }
      const v = String(j.source_vocabulary_id ?? '')
      const c = String(j.source_concept_code ?? '')
      if (!v || !c) continue
      const cat = categoryForMethod(String(j.method ?? ''))
      if (cat) categorySourceKeys[cat].add(`${v}::${c}`)
    }
    try {
      const csResult = await conn.query(
        `SELECT DISTINCT source_vocabulary_id, source_concept_code
         FROM read_parquet('${name}')
         WHERE concept_set_uid IS NOT NULL AND concept_set_uid <> ''`,
      )
      for (const r of csResult.toArray()) {
        const j = r.toJSON() as { source_vocabulary_id: unknown; source_concept_code: unknown }
        const v = String(j.source_vocabulary_id ?? '')
        const c = String(j.source_concept_code ?? '')
        if (v && c) categorySourceKeys.data_dictionary.add(`${v}::${c}`)
      }
    } catch { /* concept_set_uid absent in pre-dictionary scores files */ }

    return {
      projectId,
      rowCount,
      methods,
      sourceKeys,
      categorySourceKeys,
      importedAt: new Date().toISOString(),
    }
  } finally {
    await conn.close()
  }
}

/**
 * Persist a scores parquet file for a project and (re)build its query index.
 * Shared by the Suggestions "Load scores file" flow, workspace import, and the seed loader.
 * The caller is responsible for validating the file beforehand when the source is untrusted.
 */
export async function persistScoresFile(projectId: string, file: File): Promise<ScoresIndex | null> {
  await saveScoresFile(projectId, file)
  await unregisterProject(projectId)
  const index = await buildIndex(projectId)
  if (index) await getStorage().scoresMeta.put(index)
  return index
}

// --- Per-method CSV (front-only): see scores-csv.ts ---------------------------

async function parquetColumns(conn: AsyncDuckDBConnection, source: string): Promise<Set<string>> {
  const res = await conn.query(`SELECT * FROM read_parquet(${sqlLiteral(source)}) LIMIT 0`)
  return new Set(res.schema.fields.map((f) => f.name))
}

/** Per method: row count and CSV size, for the versioning toggles. */
export async function scoreMethodStats(projectId: string): Promise<ScoreMethodStat[]> {
  const name = await ensureRegisteredInternal(projectId)
  if (!name) return []
  const db = await getDuckDB()
  const conn = await db.connect()
  try {
    const res = await conn.query(methodStatsSql(name, await parquetColumns(conn, name)))
    return res.toArray().map((r) => {
      const j = r.toJSON() as { method: string; n: number | bigint; bytes: number | bigint | null }
      return {
        method: j.method,
        rowCount: Number(j.n),
        csvBytes: Number(j.bytes ?? 0),
        versionable: csvPathForMethod(j.method) !== null,
      }
    })
  } finally {
    await conn.close()
  }
}

// The export is rebuilt on every git-status refresh of a front-only build too,
// so a method's CSV is kept for as long as the scores file does not change.
// Each entry can weigh tens of MB: a few methods at most.
const CSV_CACHE_MAX = 8
const csvCache = new Map<string, Uint8Array>()

/** The versioned CSV of one method; null when the method has no rows. */
export async function methodCsvBytes(projectId: string, method: string): Promise<Uint8Array | null> {
  if (!csvPathForMethod(method)) return null
  const file = await getScoresFile(projectId)
  if (!file) return null
  const key = `${projectId}::${file.size}::${file.lastModified}::${method}`
  const cached = csvCache.get(key)
  if (cached) {
    csvCache.delete(key)
    csvCache.set(key, cached)
    return cached
  }
  const name = await ensureRegisteredInternal(projectId)
  if (!name) return null
  const db = await getDuckDB()
  const conn = await db.connect()
  const out = `__scores_method_${crypto.randomUUID()}.csv`
  try {
    const where = `method = ${sqlLiteral(method)}`
    const cols = await parquetColumns(conn, name)
    const present: string[] = []
    for (const c of CSV_OPTIONAL_COLUMNS) {
      if (!cols.has(c)) continue
      const res = await conn.query(
        `SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(name)}) WHERE ${where} AND NULLIF(CAST(${c} AS VARCHAR), '') IS NOT NULL`,
      )
      if (Number((res.toArray()[0]?.toJSON() as { n: number | bigint }).n) > 0) present.push(c)
    }
    const countRes = await conn.query(`SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(name)}) WHERE ${where}`)
    if (Number((countRes.toArray()[0]?.toJSON() as { n: number | bigint }).n) === 0) return null
    await conn.query(methodCsvCopySql(name, method, present, out))
    const bytes = await db.copyFileToBuffer(out)
    for (const k of csvCache.keys()) if (k.startsWith(`${projectId}::`) && k.endsWith(`::${method}`)) csvCache.delete(k)
    csvCache.set(key, bytes)
    if (csvCache.size > CSV_CACHE_MAX) {
      const oldest = csvCache.keys().next().value
      if (oldest !== undefined) csvCache.delete(oldest)
    }
    return bytes
  } finally {
    await conn.close()
    try { await db.dropFile(out) } catch { /* not written */ }
  }
}

/** The parquet restricted to `methods` (the ZIP's parquet variant). */
export async function subsetScoresParquet(projectId: string, methods: string[]): Promise<Uint8Array | null> {
  const name = await ensureRegisteredInternal(projectId)
  if (!name || methods.length === 0) return null
  const db = await getDuckDB()
  const conn = await db.connect()
  const out = `__scores_subset_${crypto.randomUUID()}.parquet`
  try {
    const cond = `method IN (${methods.map(sqlLiteral).join(', ')})`
    const res = await conn.query(`SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(name)}) WHERE ${cond}`)
    if (Number((res.toArray()[0]?.toJSON() as { n: number | bigint }).n) === 0) return null
    await conn.query(`COPY (SELECT * FROM read_parquet(${sqlLiteral(name)}) WHERE ${cond}) TO ${sqlLiteral(out)} (FORMAT PARQUET)`)
    return await db.copyFileToBuffer(out)
  } finally {
    await conn.close()
    try { await db.dropFile(out) } catch { /* not written */ }
  }
}

/**
 * Replace the rows of each CSV's method with that CSV's rows, and drop the
 * `removed` methods; methods named in neither are kept. Persists the result (or
 * deletes the file when nothing remains) and returns the new index.
 */
export async function replaceScoreMethods(
  projectId: string,
  csvs: { method: string; bytes: Uint8Array }[],
  removed: string[] = [],
): Promise<ScoresIndex | null> {
  const existing = await ensureRegisteredInternal(projectId)
  const db = await getDuckDB()
  const conn = await db.connect()
  const tmpFiles: string[] = []
  const out = `__scores_merged_${crypto.randomUUID()}.parquet`
  try {
    const parts: string[] = []
    for (const { method, bytes } of csvs) {
      if (!csvPathForMethod(method)) throw new Error(`Invalid method: ${method}`)
      const name = `__scores_csv_${crypto.randomUUID()}.csv`
      await db.registerFileBuffer(name, bytes)
      tmpFiles.push(name)
      const res = await conn.query(`SELECT * FROM read_csv(${sqlLiteral(name)}, header=true, all_varchar=true) LIMIT 0`)
      const cols = new Set(res.schema.fields.map((f) => f.name))
      const missing = CSV_REQUIRED_COLUMNS.filter((c) => !cols.has(c))
      if (missing.length) throw new Error(`${method}: missing required columns: ${missing.join(', ')}`)
      parts.push(csvToScoresSelect(name, method, cols))
    }
    if (existing) {
      const dropped = [...csvs.map((c) => c.method), ...removed]
      const cond = dropped.length ? ` WHERE method NOT IN (${dropped.map(sqlLiteral).join(', ')})` : ''
      parts.unshift(`SELECT * FROM read_parquet(${sqlLiteral(existing)})${cond}`)
    }
    const union = parts.map((p) => `(${p})`).join(' UNION ALL BY NAME ')
    const total = union
      ? Number((((await conn.query(`SELECT COUNT(*) AS n FROM (${union})`)).toArray()[0]?.toJSON()) as { n: number | bigint }).n)
      : 0
    if (total === 0) {
      await unregisterProject(projectId)
      await deleteScoresFile(projectId)
      await getStorage().scoresMeta.delete(projectId)
      return null
    }
    await conn.query(`COPY (${union}) TO ${sqlLiteral(out)} (FORMAT PARQUET)`)
    const buf = await db.copyFileToBuffer(out)
    return await persistScoresFile(projectId, new File([buf as BlobPart], `${projectId}.parquet`, { type: 'application/octet-stream' }))
  } finally {
    await conn.close()
    for (const f of [...tmpFiles, out]) {
      try { await db.dropFile(f) } catch { /* not written */ }
    }
  }
}
