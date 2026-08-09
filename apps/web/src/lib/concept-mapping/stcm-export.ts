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

/**
 * The mapping's source domain, which OMOP's source_to_concept_map has no column
 * for. It is carried as an extra CSV column so the script can build the source
 * concepts from this file too — without it the domain would have to be inlined
 * as a CASE over the source codes, putting back the very rows the CSV removes.
 * PART 1 selects the OMOP columns by name, so the extra one is simply ignored
 * on the way into the table.
 */
export const SOURCE_DOMAIN_COLUMN = 'source_domain_id'

/** CSV columns: the OMOP ones, plus the domain the script needs. */
export const STCM_CSV_COLUMNS = [...STCM_COLUMNS, SOURCE_DOMAIN_COLUMN] as const

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
      // Empty, not "NULL": DuckDB reads an empty CSV field as NULL, whereas the
      // literal text would become the four-character string.
      '',
      csvField(m.sourceDomainId || 'Observation'),
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
 * Quote a CSV field when it needs it. Beyond the usual separator / quote /
 * newline (concept names routinely contain commas, "Sodium [Moles/volume] in
 * Serum, Plasma"), also quote a value that starts with a spreadsheet
 * formula-trigger (`= + - @`, tab, CR) or has leading/trailing whitespace:
 * quoting is lossless on the DuckDB `read_csv` round-trip, and keeps the field
 * from being interpreted as a formula if the CSV is opened in Excel.
 */
export function csvField(value: string | undefined): string {
  const s = value ?? ''
  if (!/[",\n\r]/.test(s) && !/^[=+\-@\t\r]/.test(s) && !/^\s|\s$/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}
