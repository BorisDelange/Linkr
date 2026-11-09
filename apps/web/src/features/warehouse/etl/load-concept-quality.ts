import * as duckdbEngine from '@/lib/duckdb/engine'
import { qualify, tableListHas } from '@/lib/schema-helpers'
import { runPlanLocally, type PlanResults, type QueryPlan } from '@/lib/server-runs/query-plan'
import {
  classifyDiff,
  CLINICAL_TABLES,
  expectedRowsByTarget,
  type ConceptCount,
  type QualityConceptRow,
} from './quality-diff'

/** The plan's query returning the mappings; the others are `src_<table>`, `std_<table>`. */
export const MAPPINGS_KEY = 'mappings'

/**
 * The mappings, read from the TARGET: C/CR first — since CDM 5.3
 * source_to_concept_map is no longer where mappings live, and a pipeline
 * generating C/CR leaves it empty — else source_to_concept_map, when the target
 * has one (`tables` lists its tables; null when unknown).
 */
function mappingsSql(tables: readonly string[] | null): string {
  const ccr = `SELECT c.vocabulary_id  AS source_vocabulary_id,
           c.concept_code   AS source_code,
           c.concept_name   AS source_code_description,
           c.concept_id     AS source_concept_id,
           cr.concept_id_2  AS target_concept_id,
           t.vocabulary_id  AS target_vocabulary_id
    FROM concept c
    JOIN concept_relationship cr
      ON cr.concept_id_1 = c.concept_id AND cr.relationship_id = 'Maps to'
    LEFT JOIN concept t ON t.concept_id = cr.concept_id_2
    WHERE c.concept_id >= 2000000000
      AND cr.concept_id_2 != 0`
  if (tables && !tableListHas(tables, { table: 'source_to_concept_map' })) return ccr
  return `WITH ccr AS (
    ${ccr}
  )
  SELECT * FROM ccr
  UNION ALL
  SELECT source_vocabulary_id, source_code, source_code_description,
         source_concept_id, target_concept_id, target_vocabulary_id
  FROM source_to_concept_map
  WHERE target_concept_id != 0 AND NOT EXISTS (SELECT 1 FROM ccr)`
}

/**
 * The comparison's queries: the mappings, then each clinical table's records and
 * patients per concept, on the source side (`*_source_concept_id`, what arrived)
 * and the standard side (`*_concept_id`, what was mapped). Independent of one
 * another: each reads the mappings itself, so no list of ids travels between
 * them. A table the target lacks is left out — not every pipeline fills all of
 * OMOP. Everything reads the target: a source in its own shape has no
 * comparable columns.
 */
export function conceptQualityPlan(tables: readonly string[] | null, label: string, meta: Record<string, unknown>): QueryPlan {
  const mappings = mappingsSql(tables)
  const items = [{ key: MAPPINGS_KEY, sql: mappings, what: 'The concept mappings of the target' }]
  for (const ct of CLINICAL_TABLES) {
    if (tables && !tableListHas(tables, ct)) continue
    for (const side of ['source', 'standard'] as const) {
      const col = side === 'source' ? ct.source : ct.standard
      const id = side === 'source' ? 'source_concept_id' : 'target_concept_id'
      items.push({
        key: `${side === 'source' ? 'src' : 'std'}_${ct.table}`,
        what: `Records and patients of each ${side} concept in ${ct.table}`,
        sql: `WITH m AS (
    ${mappings}
  )
  SELECT "${col}" AS cid,
         COUNT(DISTINCT person_id)::INTEGER AS patients,
         COUNT(*)::INTEGER AS rows
  FROM ${qualify(ct)}
  WHERE "${col}" IN (SELECT ${id} FROM m WHERE ${id} > 0)
  GROUP BY "${col}"`,
      })
    }
  }
  return { label, items, meta }
}

function rowsOf(results: PlanResults, key: string): Record<string, unknown>[] {
  const got = results.get(key)
  if (got instanceof Error) throw got
  return got ?? []
}

function countsOf(results: PlanResults, prefix: 'src' | 'std'): Map<number, ConceptCount> {
  const counts = new Map<number, ConceptCount>()
  for (const ct of CLINICAL_TABLES) {
    for (const r of rowsOf(results, `${prefix}_${ct.table}`)) {
      const cid = Number(r.cid)
      const prev = counts.get(cid) ?? { patients: 0, rows: 0 }
      counts.set(cid, { patients: prev.patients + Number(r.patients), rows: prev.rows + Number(r.rows) })
    }
  }
  return counts
}

/** The comparison from what the plan's queries returned; a query that failed fails it. */
export function assembleConceptQuality(results: PlanResults): QualityConceptRow[] {
  const mappings = rowsOf(results, MAPPINGS_KEY).map((r) => ({
    sourceVocabularyId: String(r.source_vocabulary_id ?? ''),
    sourceCode: String(r.source_code ?? ''),
    sourceDescription: String(r.source_code_description ?? ''),
    sourceConceptId: Number(r.source_concept_id ?? 0),
    targetConceptId: Number(r.target_concept_id ?? 0),
    targetVocabularyId: String(r.target_vocabulary_id ?? ''),
  }))
  if (mappings.length === 0) return []
  const sourceCounts = countsOf(results, 'src')
  const targetCounts = countsOf(results, 'std')
  const expected = expectedRowsByTarget(mappings, sourceCounts)

  return mappings.map((m) => {
    const sc = sourceCounts.get(m.sourceConceptId) ?? { patients: 0, rows: 0 }
    const tc = targetCounts.get(m.targetConceptId) ?? { patients: 0, rows: 0 }
    const expectedRows = expected.get(m.targetConceptId) ?? 0
    return {
      ...m,
      sourcePatients: sc.patients,
      sourceRows: sc.rows,
      targetPatients: tc.patients,
      targetRows: tc.rows,
      expectedRows,
      diff: classifyDiff(sc.rows, tc.rows, expectedRows),
    }
  })
}

/** Client-only mode: the comparison computed here. */
export async function loadConceptQuality(targetDsId: string): Promise<QualityConceptRow[]> {
  const plan = conceptQualityPlan(await duckdbEngine.sourceTables(targetDsId), 'Quality check', {})
  return assembleConceptQuality(await runPlanLocally(targetDsId, plan, 'ETL quality · concept comparison'))
}
