import * as duckdb from '@duckdb/duckdb-wasm'
import { getDuckDB, registerResetHook } from '@/lib/duckdb/engine'
import { getScoresFile } from './scores-storage'
import type { ParsedScoreRow } from './scores-parser'
import type { ScoresIndex } from '@/types'

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
  await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)
  registered.set(projectId, name)
  return name
}

export async function ensureRegistered(projectId: string): Promise<string | null> {
  return ensureRegisteredInternal(projectId)
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
  return {
    source_vocabulary_id: sourceVocabId,
    source_concept_code: sourceConceptCode,
    concept_id: conceptId,
    method,
    score,
    equivalence,
    comment,
    created_at: createdAt,
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
      `SELECT source_vocabulary_id, source_concept_code, concept_id, method, score, equivalence, comment, created_at
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

    return {
      projectId,
      rowCount,
      methods,
      sourceKeys,
      importedAt: new Date().toISOString(),
    }
  } finally {
    await conn.close()
  }
}
