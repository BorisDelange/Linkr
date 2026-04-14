/**
 * DuckDB-backed queries for the GlobalSummaryView table tab.
 *
 * Data from IndexedDB (mappings) and DuckDB (source concepts) is
 * inserted into temporary DuckDB tables so the Table tab can paginate
 * via SQL LIMIT/OFFSET instead of keeping everything in JS memory.
 */
import { getDuckDB } from '@/lib/duckdb/engine'
import type { ConceptMapping, MappingProject } from '@/types'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Minimal source concept row for building the tables. */
export interface SourceConceptRaw {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
}

export interface GlobalTableFilters {
  statusFilter?: Set<string>
  groupLabels?: Set<string>
  sourceVocabularyId?: string | null
  sourceConceptId?: string
  sourceConceptCode?: string
  sourceConceptName?: string
  targetVocabularyId?: string | null
  targetConceptId?: string
  targetConceptName?: string
  equivalence?: string | null
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/'/g, "''")
}

let _populated: 'flat' | 'dedup' | null = null

async function exec(sql: string): Promise<Record<string, unknown>[]> {
  const db = await getDuckDB()
  const conn = await db.connect()
  try {
    const result = await conn.query(sql)
    return result.toArray() as Record<string, unknown>[]
  } finally {
    await conn.close()
  }
}

/* ------------------------------------------------------------------ */
/*  Build temp tables                                                  */
/* ------------------------------------------------------------------ */

/**
 * Populate the `global_flat` temp table with one row per mapping (+ unmapped).
 * Called once when data finishes loading or when groupMode switches to 'project'.
 */
export async function populateFlatTable(
  allMappings: ConceptMapping[],
  allSourceConceptsByProject: Map<string, SourceConceptRaw[]>,
  projects: MappingProject[],
  registryMap: Map<string, number>,
): Promise<void> {
  if (_populated === 'flat') return
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  await exec('DROP TABLE IF EXISTS global_flat')
  await exec(`CREATE TABLE global_flat (
    id VARCHAR,
    project_id VARCHAR,
    project_name VARCHAR,
    is_unmapped BOOLEAN,
    source_vocabulary_id VARCHAR,
    source_concept_id INTEGER,
    resolved_source_concept_id INTEGER,
    source_concept_code VARCHAR,
    source_concept_name VARCHAR,
    equivalence VARCHAR,
    target_vocabulary_id VARCHAR,
    target_concept_id INTEGER,
    target_concept_name VARCHAR,
    status VARCHAR,
    mapped_by VARCHAR,
    created_at VARCHAR,
    updated_at VARCHAR,
    votes_approved INTEGER,
    votes_flagged INTEGER,
    votes_rejected INTEGER,
    reviews_json VARCHAR
  )`)

  // Build mapped keys per project (for unmapped detection)
  const mappedKeys = new Map<string, Set<string>>()
  for (const m of allMappings) {
    if (!mappedKeys.has(m.projectId)) mappedKeys.set(m.projectId, new Set())
    mappedKeys.get(m.projectId)!.add(`${m.sourceVocabularyId}__${m.sourceConceptCode}`)
  }

  // Insert in batches of 500
  const BATCH = 500
  let values: string[] = []

  const flush = async () => {
    if (values.length === 0) return
    await exec(`INSERT INTO global_flat VALUES ${values.join(',')}`)
    values = []
  }

  // Mapped rows
  for (const m of allMappings) {
    const proj = projectMap.get(m.projectId)
    const isArtificialId = proj?.sourceType === 'database'
      || (proj?.sourceType === 'file' && !proj.fileSourceData?.columnMapping?.conceptIdColumn)
    const resolvedId = isArtificialId
      ? (registryMap.get(`${m.sourceVocabularyId}__${m.sourceConceptCode}`) ?? null)
      : m.sourceConceptId
    const reviews = m.reviews ?? []
    const va = reviews.filter((r) => r.status === 'approved').length
    const vf = reviews.filter((r) => r.status === 'flagged').length
    const vr = reviews.filter((r) => r.status === 'rejected').length
    values.push(`('${esc(m.id)}','${esc(m.projectId)}','${esc(proj?.name ?? m.projectId)}',false,'${esc(m.sourceVocabularyId ?? '')}',${m.sourceConceptId ?? 0},${resolvedId ?? 'NULL'},'${esc(m.sourceConceptCode ?? '')}','${esc(m.sourceConceptName ?? '')}','${esc(m.equivalence ?? '')}','${esc(m.targetVocabularyId ?? '')}',${m.targetConceptId ?? 0},'${esc(m.targetConceptName ?? '')}','${esc(m.status ?? '')}','${esc(m.mappedBy ?? '')}','${esc(m.createdAt ?? '')}','${esc(m.updatedAt ?? '')}',${va},${vf},${vr},'${esc(JSON.stringify(reviews))}')`)
    if (values.length >= BATCH) await flush()
  }

  // Unmapped rows
  for (const [projectId, sourceConcepts] of allSourceConceptsByProject) {
    const proj = projectMap.get(projectId)
    if (!proj) continue
    const mapped = mappedKeys.get(projectId) ?? new Set()
    const isArtificialId = proj.sourceType === 'database'
      || (proj.sourceType === 'file' && !proj.fileSourceData?.columnMapping?.conceptIdColumn)
    for (const sc of sourceConcepts) {
      const key = `${sc.vocabulary_id}__${sc.concept_code}`
      if (mapped.has(key)) continue
      const resolvedId = isArtificialId
        ? (registryMap.get(key) ?? null)
        : (sc.concept_id || null)
      values.push(`('unmapped__${esc(projectId)}__${esc(key)}','${esc(projectId)}','${esc(proj.name)}',true,'${esc(sc.vocabulary_id)}',${sc.concept_id ?? 0},${resolvedId ?? 'NULL'},'${esc(sc.concept_code)}','${esc(sc.concept_name)}','','',0,'','unchecked','','','',0,0,0,'[]')`)
      if (values.length >= BATCH) await flush()
    }
  }

  await flush()
  _populated = 'flat'
}

/**
 * Populate the `global_dedup` temp table (badge mode deduplication).
 * One row per (source_concept_code, target_concept_id, badge_set) combo.
 */
export async function populateDedupTable(
  allMappings: ConceptMapping[],
  allSourceConceptsByProject: Map<string, SourceConceptRaw[]>,
  projects: MappingProject[],
  registryMap: Map<string, number>,
): Promise<void> {
  if (_populated === 'dedup') return
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  await exec('DROP TABLE IF EXISTS global_dedup')
  await exec(`CREATE TABLE global_dedup (
    key VARCHAR,
    is_unmapped BOOLEAN,
    resolved_source_concept_id INTEGER,
    source_vocabulary_id VARCHAR,
    source_concept_name VARCHAR,
    source_concept_code VARCHAR,
    equivalence VARCHAR,
    target_vocabulary_id VARCHAR,
    target_concept_id INTEGER,
    target_concept_name VARCHAR,
    votes_approved INTEGER,
    votes_flagged INTEGER,
    votes_rejected INTEGER,
    project_count INTEGER,
    badge_labels VARCHAR
  )`)

  // In-memory dedup (same logic as existing useMemo, but INSERT into DuckDB)
  const map = new Map<string, {
    key: string; isUnmapped: boolean; resolvedId: number | null
    srcVocab: string; srcName: string; srcCode: string
    equiv: string; tgtVocab: string; tgtId: number; tgtName: string
    va: number; vf: number; vr: number; cnt: number; badges: string[]
  }>()
  const mappedSourceKeys = new Set<string>()

  for (const m of allMappings) {
    const p = projectMap.get(m.projectId)
    const allBadges = (p?.badges ?? []).map((b) => b.label).filter(Boolean)
    if (allBadges.length === 0) continue
    const badgeKey = [...allBadges].sort().join('|')
    const sourceKey = `${badgeKey}__${m.sourceVocabularyId}__${m.sourceConceptCode ?? m.sourceConceptId}`
    mappedSourceKeys.add(sourceKey)
    const key = `${m.sourceConceptCode ?? m.sourceConceptId}__${m.targetConceptId}__${badgeKey}`
    const isArtificialId = p?.sourceType === 'database'
      || (p?.sourceType === 'file' && !p.fileSourceData?.columnMapping?.conceptIdColumn)
    const resolvedId = isArtificialId
      ? (registryMap.get(`${m.sourceVocabularyId}__${m.sourceConceptCode}`) ?? null)
      : m.sourceConceptId
    if (!map.has(key)) {
      map.set(key, {
        key, isUnmapped: false, resolvedId: resolvedId ?? null,
        srcVocab: m.sourceVocabularyId ?? '', srcName: m.sourceConceptName,
        srcCode: m.sourceConceptCode ?? String(m.sourceConceptId),
        equiv: m.equivalence ?? '', tgtVocab: m.targetVocabularyId ?? '',
        tgtId: m.targetConceptId, tgtName: m.targetConceptName ?? '',
        va: 0, vf: 0, vr: 0, cnt: 0, badges: allBadges,
      })
    }
    const row = map.get(key)!
    const reviews = m.reviews ?? []
    row.va += reviews.filter((r) => r.status === 'approved').length
    row.vf += reviews.filter((r) => r.status === 'flagged').length
    row.vr += reviews.filter((r) => r.status === 'rejected').length
    row.cnt++
  }

  // Unmapped
  for (const [projectId, sourceConcepts] of allSourceConceptsByProject) {
    const p = projectMap.get(projectId)
    if (!p) continue
    const allBadges = (p.badges ?? []).map((b) => b.label).filter(Boolean)
    if (allBadges.length === 0) continue
    const badgeKey = [...allBadges].sort().join('|')
    const isArtificialId = p.sourceType === 'database'
      || (p.sourceType === 'file' && !p.fileSourceData?.columnMapping?.conceptIdColumn)
    for (const sc of sourceConcepts) {
      const sourceKey = `${badgeKey}__${sc.vocabulary_id}__${sc.concept_code}`
      if (mappedSourceKeys.has(sourceKey)) continue
      mappedSourceKeys.add(sourceKey)
      const resolvedId = isArtificialId
        ? (registryMap.get(`${sc.vocabulary_id}__${sc.concept_code}`) ?? null)
        : (sc.concept_id || null)
      const key = `unmapped__${sourceKey}`
      map.set(key, {
        key, isUnmapped: true, resolvedId: resolvedId ?? null,
        srcVocab: sc.vocabulary_id, srcName: sc.concept_name,
        srcCode: sc.concept_code, equiv: '', tgtVocab: '',
        tgtId: 0, tgtName: '', va: 0, vf: 0, vr: 0, cnt: 0,
        badges: allBadges,
      })
    }
  }

  // Batch insert
  const BATCH = 500
  let values: string[] = []
  const flush = async () => {
    if (values.length === 0) return
    await exec(`INSERT INTO global_dedup VALUES ${values.join(',')}`)
    values = []
  }

  for (const r of map.values()) {
    values.push(`('${esc(r.key)}',${r.isUnmapped},${r.resolvedId ?? 'NULL'},'${esc(r.srcVocab)}','${esc(r.srcName)}','${esc(r.srcCode)}','${esc(r.equiv)}','${esc(r.tgtVocab)}',${r.tgtId},'${esc(r.tgtName)}',${r.va},${r.vf},${r.vr},${r.cnt},'${esc(r.badges.join(','))}')`)
    if (values.length >= BATCH) await flush()
  }
  await flush()
  _populated = 'dedup'
}

/** Invalidate temp tables (call when data changes). */
export function invalidateGlobalTables(): void {
  _populated = null
}

/* ------------------------------------------------------------------ */
/*  Query builders                                                     */
/* ------------------------------------------------------------------ */

function buildFlatWhere(f: GlobalTableFilters): string {
  const clauses: string[] = []
  if (f.statusFilter?.size) {
    const parts: string[] = []
    if (f.statusFilter.has('unmapped')) parts.push('is_unmapped = true')
    if (f.statusFilter.has('mapped')) parts.push('is_unmapped = false')
    if (parts.length && parts.length < 2) clauses.push(`(${parts.join(' OR ')})`)
  }
  if (f.groupLabels?.size) {
    const vals = [...f.groupLabels].map((v) => `'${esc(v)}'`).join(',')
    clauses.push(`project_name IN (${vals})`)
  }
  if (f.sourceVocabularyId) clauses.push(`source_vocabulary_id = '${esc(f.sourceVocabularyId)}'`)
  if (f.sourceConceptId) clauses.push(`CAST(COALESCE(resolved_source_concept_id, 0) AS VARCHAR) LIKE '%${esc(f.sourceConceptId)}%'`)
  if (f.sourceConceptCode) clauses.push(`LOWER(source_concept_code) LIKE LOWER('%${esc(f.sourceConceptCode)}%')`)
  if (f.sourceConceptName) clauses.push(`LOWER(source_concept_name) LIKE LOWER('%${esc(f.sourceConceptName)}%')`)
  if (f.equivalence) clauses.push(`equivalence = '${esc(f.equivalence)}'`)
  if (f.targetVocabularyId) clauses.push(`target_vocabulary_id = '${esc(f.targetVocabularyId)}'`)
  if (f.targetConceptId) clauses.push(`CAST(target_concept_id AS VARCHAR) LIKE '%${esc(f.targetConceptId)}%'`)
  if (f.targetConceptName) clauses.push(`LOWER(target_concept_name) LIKE LOWER('%${esc(f.targetConceptName)}%')`)
  return clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
}

function buildDedupWhere(f: GlobalTableFilters): string {
  const clauses: string[] = []
  if (f.statusFilter?.size) {
    const parts: string[] = []
    if (f.statusFilter.has('unmapped')) parts.push('is_unmapped = true')
    if (f.statusFilter.has('mapped')) parts.push('is_unmapped = false')
    if (parts.length && parts.length < 2) clauses.push(`(${parts.join(' OR ')})`)
  }
  if (f.sourceVocabularyId) clauses.push(`source_vocabulary_id = '${esc(f.sourceVocabularyId)}'`)
  if (f.sourceConceptCode) clauses.push(`LOWER(source_concept_code) LIKE LOWER('%${esc(f.sourceConceptCode)}%')`)
  if (f.sourceConceptName) clauses.push(`LOWER(source_concept_name) LIKE LOWER('%${esc(f.sourceConceptName)}%')`)
  if (f.equivalence) clauses.push(`equivalence = '${esc(f.equivalence)}'`)
  if (f.targetVocabularyId) clauses.push(`target_vocabulary_id = '${esc(f.targetVocabularyId)}'`)
  if (f.targetConceptId) clauses.push(`CAST(target_concept_id AS VARCHAR) LIKE '%${esc(f.targetConceptId)}%'`)
  if (f.targetConceptName) clauses.push(`LOWER(target_concept_name) LIKE LOWER('%${esc(f.targetConceptName)}%')`)
  return clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
}

function buildOrderBy(sorting: { columnId: string; desc: boolean } | null, mode: 'flat' | 'dedup'): string {
  if (!sorting) return ' ORDER BY source_concept_name ASC'
  const colMap: Record<string, string> = {
    status: 'is_unmapped',
    groupLabel: 'project_name',
    badgeLabels: 'badge_labels',
    projectCount: 'project_count',
    sourceVocabularyId: 'source_vocabulary_id',
    sourceConceptId: 'resolved_source_concept_id',
    sourceConceptCode: 'source_concept_code',
    sourceConceptName: 'source_concept_name',
    equivalence: 'equivalence',
    targetVocabularyId: 'target_vocabulary_id',
    targetConceptId: 'target_concept_id',
    targetConceptName: 'target_concept_name',
    votesApproved: 'votes_approved',
    votesFlagged: 'votes_flagged',
    votesRejected: 'votes_rejected',
  }
  const col = colMap[sorting.columnId] ?? 'source_concept_name'
  return ` ORDER BY ${col} ${sorting.desc ? 'DESC' : 'ASC'} NULLS LAST`
}

/* ------------------------------------------------------------------ */
/*  Public query functions                                             */
/* ------------------------------------------------------------------ */

export async function queryFlatCount(filters: GlobalTableFilters): Promise<number> {
  const where = buildFlatWhere(filters)
  const rows = await exec(`SELECT COUNT(*) AS total FROM global_flat${where}`)
  return Number(rows[0]?.total ?? 0)
}

export async function queryFlatPage(
  filters: GlobalTableFilters,
  sorting: { columnId: string; desc: boolean } | null,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  const where = buildFlatWhere(filters)
  const order = buildOrderBy(sorting, 'flat')
  return exec(`SELECT * FROM global_flat${where}${order} LIMIT ${limit} OFFSET ${offset}`)
}

export async function queryDedupCount(filters: GlobalTableFilters): Promise<number> {
  const where = buildDedupWhere(filters)
  const rows = await exec(`SELECT COUNT(*) AS total FROM global_dedup${where}`)
  return Number(rows[0]?.total ?? 0)
}

export async function queryDedupPage(
  filters: GlobalTableFilters,
  sorting: { columnId: string; desc: boolean } | null,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  const where = buildDedupWhere(filters)
  const order = buildOrderBy(sorting, 'dedup')
  return exec(`SELECT * FROM global_dedup${where}${order} LIMIT ${limit} OFFSET ${offset}`)
}

/** Get distinct values for filter dropdowns. */
export async function queryFlatDistinct(column: string): Promise<string[]> {
  const rows = await exec(`SELECT DISTINCT ${column} AS val FROM global_flat WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY val`)
  return rows.map((r) => String(r.val))
}

export async function queryDedupDistinct(column: string): Promise<string[]> {
  const rows = await exec(`SELECT DISTINCT ${column} AS val FROM global_dedup WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY val`)
  return rows.map((r) => String(r.val))
}
