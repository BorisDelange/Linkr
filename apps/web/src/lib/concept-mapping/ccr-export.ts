import type { ConceptMapping } from '@/types'
import { csvField } from '@/lib/csv-export'
import { assignSourceConceptIds, sourceConceptKey } from './source-concept-ids'
import { STCM_CSV_COLUMNS, SOURCE_DOMAIN_COLUMN } from './stcm-export'

/**
 * A mapping project's alignments as OMOP CONCEPT + CONCEPT_RELATIONSHIP.
 *
 * SOURCE_TO_CONCEPT_MAP was OMOP v4's way of mapping local codes to standard
 * concepts; since v5 that role belongs to `concept_relationship` with
 * `relationship_id = 'Maps to'`, and STCM stopped being an official vocabulary
 * table at v5.3. C/CR is also what the OHDSI tooling reads — a local concept is
 * invisible to ATLAS as an STCM row, visible as a 2-billion concept.
 *
 * This module is CANONICAL: STCM is derived from it (`stcmFromCcr`), never built
 * alongside it. The day STCM goes, that one function goes with it and nothing
 * else moves.
 */

/** OMOP `concept` columns, in DDL order. */
export const CONCEPT_COLUMNS = [
  'concept_id',
  'concept_name',
  'domain_id',
  'vocabulary_id',
  'concept_class_id',
  'standard_concept',
  'concept_code',
  'valid_start_date',
  'valid_end_date',
  'invalid_reason',
] as const

/** OMOP `concept_relationship` columns, in DDL order. */
export const CONCEPT_RELATIONSHIP_COLUMNS = [
  'concept_id_1',
  'concept_id_2',
  'relationship_id',
  'valid_start_date',
  'valid_end_date',
  'invalid_reason',
] as const

const VALID_START = '1970-01-01'
const VALID_END = '2099-12-31'

const DEFAULT_DOMAIN = 'Observation'

/**
 * The name to give a source concept whose dictionary leaves it unnamed.
 *
 * `concept.concept_name` is NOT NULL in the CDM, and an empty CSV field reads
 * back as NULL — so one unnamed code fails the whole vocabulary load rather than
 * its own row. Real dictionaries do carry blanks: MIMIC-IV's `d_labitems` has
 * four itemids with no label.
 *
 * Falls back to the code, the only identity such a concept actually has. A
 * constant like 'Unknown' would collide across every unnamed code and lose it.
 */
function conceptNameOf(m: ConceptMapping): string {
  return m.sourceConceptName?.trim() || m.sourceConceptCode
}

/**
 * Concept class per domain, the last resort of `conceptClassOf`.
 *
 * Deliberately an echo of the domain rather than a real vocabulary class
 * (`Ingredient`, `Lab Test`, …): those belong to SNOMED/RxNorm/LOINC and claiming
 * one for a local code asserts more than we know. Repeating the domain says
 * nothing false.
 */
const CLASS_BY_DOMAIN: Record<string, string> = {
  Drug: 'Drug',
  Measurement: 'Measurement',
  Procedure: 'Procedure',
  Condition: 'Condition',
  Device: 'Device',
  Observation: 'Observation',
}

/**
 * The class to give a source concept, best evidence first.
 *
 * 1. The source dictionary's own class, when it states one — the truthful answer.
 * 2. The target's class. Imperfect (a local code mapped to a SNOMED
 *    `Clinical Finding` is not itself a SNOMED concept), but far better than a
 *    constant: what actually matters for a local concept is `standard_concept
 *    NULL` plus the `Maps to`.
 * 3. The domain echo above.
 *
 * Previously hard-coded to 'Clinical Observation' for every source concept, which
 * is wrong for drugs, procedures and measurements alike.
 */
export function conceptClassOf(m: ConceptMapping): string {
  if (m.sourceConceptClassId) return m.sourceConceptClassId
  if (m.targetConceptClassId) return m.targetConceptClassId
  return CLASS_BY_DOMAIN[m.sourceDomainId] ?? DEFAULT_DOMAIN
}

/** True when the mapping points at a real target concept. */
function hasTarget(m: ConceptMapping): boolean {
  return m.targetConceptId != null && m.targetConceptId !== 0
}

/**
 * Marks a mapping this module synthesised for an unmapped source concept, so
 * the caller can keep its allocated id out of `idsToPersist` — the id belongs
 * to a source concept, not to any row of the mapping project.
 */
export const SYNTHETIC_MAPPING_ID = ''

/**
 * Turn the source concepts NOT covered by `mappings` into target-less mappings.
 *
 * This is how "include all source concepts" reaches the C/CR and STCM builders:
 * they already emit a concept with no `Maps to` for a target-less mapping, which
 * is exactly what an unmapped local code is in OMOP v5. Going through them —
 * rather than appending hand-built CSV lines — is what earns the unmapped
 * concepts a real 2-billion id from `assignSourceConceptIds` instead of the
 * `concept_id = 0` a download can afford but a loaded vocabulary cannot.
 */
export function syntheticMappingsForUnmapped(
  allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[],
  covered: ConceptMapping[],
  projectId: string,
): ConceptMapping[] {
  const coveredKeys = new Set(covered.map(sourceConceptKey))
  const out: ConceptMapping[] = []
  const seen = new Set<string>()
  for (const c of allSourceConcepts) {
    const key = sourceConceptKey({
      sourceVocabularyId: c.vocabularyId,
      sourceConceptCode: c.conceptCode,
    })
    if (coveredKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({
      id: SYNTHETIC_MAPPING_ID,
      projectId,
      sourceConceptId: 0,
      sourceConceptName: c.conceptName,
      sourceVocabularyId: c.vocabularyId,
      sourceDomainId: '',
      sourceConceptCode: c.conceptCode,
      targetConceptId: 0,
      targetConceptName: '',
      targetVocabularyId: '',
      targetDomainId: '',
      targetConceptCode: '',
      equivalence: 'skos:exactMatch',
      status: 'unchecked',
      createdAt: '',
      updatedAt: '',
    })
  }
  return out
}

export interface CcrCsvs {
  /** One row per distinct source concept, mapped or not. */
  conceptCsv: string
  /** Two rows ('Maps to' + 'Mapped from') per mapping with a target. */
  conceptRelationshipCsv: string
  conceptRowCount: number
  relationshipRowCount: number
  /** Mapping id -> source concept id to write back to the project. */
  idsToPersist: Map<string, number>
}

/**
 * Build both CSVs. `allProjectMappings` lets ids be assigned over the whole
 * project even when only a filtered subset is exported, so a mapping hidden by
 * the status filter cannot later be handed an id already in use.
 */
export function buildCcrCsvs(
  mappings: ConceptMapping[],
  allProjectMappings: ConceptMapping[] = mappings,
): CcrCsvs {
  const ids = assignSourceConceptIds(allProjectMappings)

  // One concept per source code, not per mapping: an N:1 mapping repeats the
  // source code once per target, and those rows describe a single concept.
  const conceptLines = [CONCEPT_COLUMNS.join(',')]
  const seen = new Set<string>()
  let conceptRowCount = 0
  for (const m of mappings) {
    const key = sourceConceptKey(m)
    if (seen.has(key)) continue
    seen.add(key)
    conceptLines.push([
      String(ids.byKey.get(key) ?? 0),
      csvField(conceptNameOf(m)),
      csvField(m.sourceDomainId || DEFAULT_DOMAIN),
      csvField(m.sourceVocabularyId),
      csvField(conceptClassOf(m)),
      // Empty, not "NULL": DuckDB reads an empty CSV field as NULL, whereas the
      // literal text would become the four-character string. A local concept is
      // non-standard by construction.
      '',
      csvField(m.sourceConceptCode),
      VALID_START,
      VALID_END,
      '',
    ].join(','))
    conceptRowCount++
  }

  // Unmapped codes get no relationship — correct in C/CR, and the reason
  // `stcmFromCcr` derives from the concepts rather than from these rows.
  const relLines = [CONCEPT_RELATIONSHIP_COLUMNS.join(',')]
  let relationshipRowCount = 0
  for (const m of mappings) {
    if (!hasTarget(m)) continue
    const sourceId = ids.byKey.get(sourceConceptKey(m)) ?? 0
    for (const [from, to, rel] of [
      [sourceId, m.targetConceptId, 'Maps to'],
      [m.targetConceptId, sourceId, 'Mapped from'],
    ] as const) {
      relLines.push([String(from), String(to), rel, VALID_START, VALID_END, ''].join(','))
      relationshipRowCount++
    }
  }

  return {
    // A trailing newline: some readers treat a missing one as a truncated file.
    conceptCsv: `${conceptLines.join('\n')}\n`,
    conceptRelationshipCsv: `${relLines.join('\n')}\n`,
    conceptRowCount,
    relationshipRowCount,
    idsToPersist: ids.toPersist,
  }
}

/**
 * STCM, projected from the canonical C/CR view.
 *
 * Written to reproduce `buildStcmCsv` exactly — one row per mapping, in the same
 * order, with the same columns — so the switch to a C/CR-canonical pipeline
 * changes no byte of anyone's `source_to_concept_map.csv`. A round-trip test
 * holds the two outputs identical.
 *
 * Note it walks the MAPPINGS, not the relationship rows: a code with no target
 * still owes STCM a `target_concept_id = 0` row, because the ETL's clinical
 * tables JOIN that table unconditionally. Deriving from `concept_relationship`
 * would drop every unmapped code and break those joins.
 */
export function stcmFromCcr(
  mappings: ConceptMapping[],
  allProjectMappings: ConceptMapping[] = mappings,
): { csv: string; rowCount: number; idsToPersist: Map<string, number> } {
  const ids = assignSourceConceptIds(allProjectMappings)

  const lines = [STCM_CSV_COLUMNS.join(',')]
  for (const m of mappings) {
    lines.push([
      csvField(m.sourceConceptCode),
      String(ids.byKey.get(sourceConceptKey(m)) ?? 0),
      csvField(m.sourceVocabularyId),
      csvField(m.sourceConceptName),
      String(m.targetConceptId ?? 0),
      csvField(m.targetVocabularyId),
      VALID_START,
      VALID_END,
      '',
      csvField(m.sourceDomainId || DEFAULT_DOMAIN),
    ].join(','))
  }

  return {
    csv: `${lines.join('\n')}\n`,
    rowCount: mappings.length,
    idsToPersist: ids.toPersist,
  }
}

export { SOURCE_DOMAIN_COLUMN }
