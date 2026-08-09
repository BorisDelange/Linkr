import type { ConceptMapping } from '@/types'
import { assignSourceConceptIds, sourceConceptKey } from './source-concept-ids'

/**
 * The mapping project's source_to_concept_map, as CSV.
 *
 * The vocabulary script used to carry these rows as literal `VALUES`, which put
 * the source codes of a private dictionary into a git-versioned file. They are
 * written beside the pipeline instead, gitignored, and the script reads them with
 * `read_csv('mapping.source_to_concept_map')`.
 */

/** OMOP source_to_concept_map columns, in DDL order. */
export const STCM_COLUMNS = [
  'source_code',
  'source_concept_id',
  'source_vocabulary_id',
  'source_code_description',
  'target_concept_id',
  'target_vocabulary_id',
  'valid_start_date',
  'valid_end_date',
  'invalid_reason',
] as const

const VALID_START = '1970-01-01'
const VALID_END = '2099-12-31'

/**
 * Build the CSV. `allProjectMappings` lets ids be assigned over the whole project
 * even when only a filtered subset is exported, so a mapping hidden by the status
 * filter cannot later be handed an id already in use.
 */
export function buildStcmCsv(
  mappings: ConceptMapping[],
  allProjectMappings: ConceptMapping[] = mappings,
): { csv: string; rowCount: number; idsToPersist: Map<string, number> } {
  const ids = assignSourceConceptIds(allProjectMappings)

  const lines = [STCM_COLUMNS.join(',')]
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
      // Empty, not "NULL": DuckDB reads an empty CSV field as NULL, whereas the
      // literal text would become the four-character string.
      '',
    ].join(','))
  }

  return {
    // A trailing newline: some readers treat a missing one as a truncated file.
    csv: `${lines.join('\n')}\n`,
    rowCount: mappings.length,
    idsToPersist: ids.toPersist,
  }
}

/**
 * Quote a CSV field when it contains a separator, a quote or a newline. Concept
 * names routinely contain commas ("Sodium [Moles/volume] in Serum, Plasma").
 */
export function csvField(value: string | undefined): string {
  const s = value ?? ''
  if (!/[",\n\r]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}
