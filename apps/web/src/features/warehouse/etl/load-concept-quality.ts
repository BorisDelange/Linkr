import * as duckdbEngine from '@/lib/duckdb/engine'
import { validateIntegerIds } from '@/lib/format-helpers'
import { qualify } from '@/lib/schema-helpers'
import {
  classifyDiff,
  CLINICAL_TABLES,
  expectedRowsByTarget,
  type ConceptCount,
  type QualityConceptRow,
} from './quality-diff'

/**
 * Read the STCM from the target and count each concept's rows on both sides.
 *
 * Everything is queried from the TARGET: `*_source_concept_id` for what arrived,
 * `*_concept_id` for what was mapped. A source database in its own (non-OMOP)
 * shape has no comparable columns, so comparing against it is not possible here.
 */
export async function loadConceptQuality(targetDsId: string): Promise<QualityConceptRow[]> {
  // C/CR first: since CDM 5.3 source_to_concept_map is no longer where mappings
  // live, and a pipeline generating C/CR leaves it empty. Reading only STCM made
  // this whole tab silently show nothing — no error, just no rows.
  const ccr = await duckdbEngine.queryDataSource(targetDsId, `
    SELECT c.vocabulary_id  AS source_vocabulary_id,
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
      AND cr.concept_id_2 != 0
  `)

  // Not every target has a source_to_concept_map: its absence only means none.
  const stcm = ccr.length > 0 ? ccr : await duckdbEngine.queryDataSource(targetDsId, `
    SELECT source_vocabulary_id, source_code, source_code_description,
           source_concept_id, target_concept_id, target_vocabulary_id
    FROM source_to_concept_map
    WHERE target_concept_id != 0
  `).catch(() => [])
  if (stcm.length === 0) return []

  const mappings = stcm.map((r) => ({
    sourceVocabularyId: String(r.source_vocabulary_id ?? ''),
    sourceCode: String(r.source_code ?? ''),
    sourceDescription: String(r.source_code_description ?? ''),
    sourceConceptId: Number(r.source_concept_id ?? 0),
    targetConceptId: Number(r.target_concept_id ?? 0),
    targetVocabularyId: String(r.target_vocabulary_id ?? ''),
  }))

  const sourceIds = [...new Set(mappings.map((m) => m.sourceConceptId).filter((id) => id > 0))]
  const targetIds = [...new Set(mappings.map((m) => m.targetConceptId).filter((id) => id > 0))]

  const [sourceCounts, targetCounts] = await Promise.all([
    countConcepts(targetDsId, sourceIds, 'source'),
    countConcepts(targetDsId, targetIds, 'standard'),
  ])

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

/** Patients and rows per concept id, summed over the OMOP clinical tables. */
async function countConcepts(
  dataSourceId: string,
  conceptIds: number[],
  side: 'source' | 'standard',
): Promise<Map<number, ConceptCount>> {
  const counts = new Map<number, ConceptCount>()
  // Ids are interpolated into an IN (...), so they must be proven integers.
  if (conceptIds.length === 0 || !validateIntegerIds(conceptIds)) return counts
  const idList = conceptIds.join(',')

  for (const ct of CLINICAL_TABLES) {
    const col = side === 'source' ? ct.source : ct.standard
    try {
      const rows = await duckdbEngine.queryDataSource(dataSourceId, `
        SELECT "${col}" AS cid,
               COUNT(DISTINCT person_id)::INTEGER AS patients,
               COUNT(*)::INTEGER AS rows
        FROM ${qualify(ct)}
        WHERE "${col}" IN (${idList})
        GROUP BY "${col}"
      `)
      for (const r of rows) {
        const cid = Number(r.cid)
        const prev = counts.get(cid) ?? { patients: 0, rows: 0 }
        counts.set(cid, {
          patients: prev.patients + Number(r.patients),
          rows: prev.rows + Number(r.rows),
        })
      }
    } catch {
      // The table may not exist in this target — not every pipeline fills all of OMOP.
    }
  }
  return counts
}
