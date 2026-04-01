import type { ConceptMapping, MappingProject, ConceptSet, FileColumnMapping } from '@/types'

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

export function csvEscape(value: string | number | undefined | null): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Preferred column order for source concept CSV exports. */
const SOURCE_CONCEPT_PREFERRED_COLUMNS = ['vocabulary_id', 'terminology_name', 'category', 'subcategory', 'concept_id', 'concept_code', 'concept_name']

/**
 * Build a CSV string from DuckDB rows with preferred column ordering.
 * Preferred columns appear first, then remaining columns in original order.
 */
export function buildSourceConceptsCsvFromRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const rawColumns = Object.keys(rows[0])
  const columns = [
    ...SOURCE_CONCEPT_PREFERRED_COLUMNS.filter((c) => rawColumns.includes(c)),
    ...rawColumns.filter((c) => !SOURCE_CONCEPT_PREFERRED_COLUMNS.includes(c)),
  ]
  const header = columns.map((c) => csvEscape(c)).join(',')
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c] as string | number | null | undefined)).join(','))
  return [header, ...lines].join('\n')
}

function tsvEscape(value: string | number | undefined | null): string {
  if (value == null) return ''
  return String(value).replace(/\t/g, ' ').replace(/\n/g, ' ')
}

// ---------------------------------------------------------------------------
// USAGI CSV export
// ---------------------------------------------------------------------------

/** Convert our SKOS equivalence to Usagi's equivalence enum. */
function equivalenceToUsagi(equiv: string): string {
  switch (equiv) {
    case 'skos:exactMatch': return 'EQUAL'
    case 'skos:closeMatch': return 'EQUIVALENT'
    case 'skos:broadMatch': return 'WIDER'
    case 'skos:narrowMatch': return 'NARROWER'
    case 'skos:relatedMatch': return 'INEXACT'
    // Legacy values (pre-SKOS)
    case 'equal': return 'EQUAL'
    case 'equivalent': return 'EQUIVALENT'
    case 'wider': return 'WIDER'
    case 'narrower': return 'NARROWER'
    case 'inexact': return 'INEXACT'
    default: return 'UNREVIEWED'
  }
}

/** Convert our status to Usagi's MappingStatus enum. */
function statusToUsagi(status: string): string {
  switch (status) {
    case 'approved': return 'APPROVED'
    case 'unchecked': return 'UNCHECKED'
    case 'flagged': return 'FLAGGED'
    case 'ignored': return 'IGNORED'
    case 'invalid': return 'INVALID_TARGET'
    case 'rejected': return 'FLAGGED' // Usagi has no REJECTED — closest is FLAGGED
    default: return 'UNCHECKED'
  }
}

/** Convert ISO date string to epoch milliseconds (Usagi format). */
function isoToEpochMs(iso: string | undefined | null): string {
  if (!iso) return '0'
  const ms = new Date(iso).getTime()
  return isNaN(ms) ? '0' : String(ms)
}

/**
 * Export mappings in USAGI-compatible CSV format.
 * Columns match OHDSI Usagi's WriteCodeMappingsToFile format.
 * Ignored mappings (status='ignored', targetConceptId=0) are exported with IGNORED status.
 */
export function exportToUsagiCsv(
  mappings: ConceptMapping[],
): string {
  const header = [
    'sourceCode', 'sourceName', 'sourceFrequency', 'sourceAutoAssignedConceptIds',
    'matchScore', 'mappingStatus', 'equivalence', 'statusSetBy', 'statusSetOn',
    'conceptId', 'conceptName', 'domainId', 'mappingType',
    'comment', 'createdBy', 'createdOn', 'assignedReviewer',
  ].join(',')

  const rows = mappings.map((m) => [
    csvEscape(m.sourceConceptCode),
    csvEscape(m.sourceConceptName),
    csvEscape(m.sourceFrequency),
    csvEscape(m.sourceConceptId),
    csvEscape(m.matchScore ?? 0),
    csvEscape(statusToUsagi(m.status)),
    csvEscape(m.status === 'ignored' ? 'UNREVIEWED' : equivalenceToUsagi(m.equivalence)),
    csvEscape(m.mappedBy),
    csvEscape(isoToEpochMs(m.mappedOn)),
    csvEscape(m.targetConceptId),
    csvEscape(m.targetConceptName),
    csvEscape(m.targetDomainId),
    csvEscape(m.mappingType?.toUpperCase()),
    csvEscape(m.comment),
    csvEscape(m.mappedBy),
    csvEscape(isoToEpochMs(m.createdAt)),
    csvEscape(m.assignedReviewer),
  ].join(','))

  return [header, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// SOURCE_TO_CONCEPT_MAP export (OMOP CDM table format)
// ---------------------------------------------------------------------------

/**
 * Export approved mappings as OMOP source_to_concept_map CSV.
 * Ready for ETL import into an OMOP CDM target database.
 */
export function exportToSourceToConceptMap(mappings: ConceptMapping[], project?: MappingProject): string {
  // For file-based projects without a conceptIdColumn, sourceConceptId is an artificial index — export 0 per OMOP convention
  const useRealSourceConceptId = !(
    project?.sourceType === 'file' && !project.fileSourceData?.columnMapping?.conceptIdColumn
  )

  const header = [
    'source_code', 'source_concept_id', 'source_vocabulary_id',
    'source_code_description', 'target_concept_id', 'target_vocabulary_id',
    'valid_start_date', 'valid_end_date', 'invalid_reason',
  ].join(',')

  const rows = mappings.map((m) => [
    csvEscape(m.sourceConceptCode),
    csvEscape(useRealSourceConceptId ? m.sourceConceptId : 0),
    csvEscape(m.sourceVocabularyId),
    csvEscape(m.sourceConceptName),
    csvEscape(m.targetConceptId),
    csvEscape(m.targetVocabularyId),
    csvEscape('1970-01-01'),
    csvEscape('2099-12-31'),
    csvEscape(''),
  ].join(','))

  return [header, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// SSSOM TSV export
// ---------------------------------------------------------------------------

/** Normalize equivalence to SKOS predicate (supports both legacy and new values). */
function equivalenceToSkosPredicate(equiv: string): string {
  // New SKOS values: pass through
  if (equiv.startsWith('skos:')) return equiv
  // Legacy values: convert
  switch (equiv) {
    case 'equal': return 'skos:exactMatch'
    case 'equivalent': return 'skos:closeMatch'
    case 'wider': return 'skos:broadMatch'
    case 'narrower': return 'skos:narrowMatch'
    case 'inexact': return 'skos:relatedMatch'
    default: return 'skos:relatedMatch'
  }
}

/** Map our status to SSSOM mapping_justification. */
function statusToJustification(status: string): string {
  switch (status) {
    case 'approved': return 'semapv:ManualMappingCuration'
    case 'flagged': return 'semapv:ManualMappingCuration'
    case 'rejected': return 'semapv:ManualMappingCuration'
    default: return 'semapv:UnspecifiedMatching'
  }
}

/**
 * Export mappings in SSSOM TSV format.
 * Includes YAML metadata header as per SSSOM spec.
 * Ignored mappings use sssom:NoTermFound predicate per SSSOM spec.
 */
export function exportToSssomTsv(
  mappings: ConceptMapping[],
  project: MappingProject,
): string {
  // YAML metadata header
  const metadataLines = [
    `#curie_map:`,
    `#  skos: "http://www.w3.org/2004/02/skos/core#"`,
    `#  semapv: "https://w3id.org/semapv/vocab/"`,
    `#  sssom: "https://w3id.org/sssom/"`,
    `#  OHDSI: "http://ohdsi.org/concept/"`,
    `#mapping_set_id: "${project.id}"`,
    `#mapping_set_title: "${project.name}"`,
    `#mapping_date: "${new Date().toISOString().split('T')[0]}"`,
    `#license: "https://creativecommons.org/publicdomain/zero/1.0/"`,
  ]

  const header = [
    'subject_id', 'subject_label', 'subject_source',
    'predicate_id',
    'object_id', 'object_label', 'object_source',
    'mapping_justification', 'confidence',
    'author_id', 'comment',
  ].join('\t')

  const rows = mappings.map((m) => {
    const isIgnored = m.status === 'ignored'
    return [
      tsvEscape(`${m.sourceVocabularyId}:${m.sourceConceptCode}`),
      tsvEscape(m.sourceConceptName),
      tsvEscape(m.sourceVocabularyId),
      tsvEscape(isIgnored ? 'sssom:NoTermFound' : equivalenceToSkosPredicate(m.equivalence)),
      tsvEscape(isIgnored ? '' : `OHDSI:${m.targetConceptId}`),
      tsvEscape(isIgnored ? '' : m.targetConceptName),
      tsvEscape(isIgnored ? '' : m.targetVocabularyId),
      tsvEscape(isIgnored ? 'semapv:ManualMappingCuration' : statusToJustification(m.status)),
      tsvEscape(m.matchScore),
      tsvEscape(m.mappedBy),
      tsvEscape(m.comment),
    ].join('\t')
  })

  return [...metadataLines, header, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// Full JSON export
// ---------------------------------------------------------------------------

/**
 * Export all mappings with full metadata as JSON.
 * Preserves all information for backup, sharing, and re-import.
 */
export function exportToJson(
  mappings: ConceptMapping[],
  project: MappingProject,
  conceptSets?: ConceptSet[],
): string {
  return JSON.stringify(
    {
      exportFormat: 'linkr-concept-mapping',
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        dataSourceId: project.dataSourceId,
        vocabularyDataSourceId: project.vocabularyDataSourceId,
      },
      conceptSets: conceptSets ?? [],
      mappings,
    },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// Source concepts CSV export (file-based projects)
// ---------------------------------------------------------------------------

/**
 * Export the imported source concepts as a clean CSV.
 * Only includes the columns that were mapped during import + extra columns.
 * This is NOT the original file — it's the normalized version with mapped fields only.
 */
export function exportSourceConceptsCsv(
  rows: Record<string, unknown>[],
  columns: string[],
  columnMapping: FileColumnMapping,
): string {
  // Collect mapped columns in a meaningful order
  const mappedCols: { header: string; fileCol: string }[] = []

  const roleOrder: { role: keyof FileColumnMapping; header: string }[] = [
    { role: 'terminologyColumn', header: 'terminology' },
    { role: 'conceptCodeColumn', header: 'concept_code' },
    { role: 'conceptIdColumn', header: 'concept_id' },
    { role: 'conceptNameColumn', header: 'concept_name' },
    { role: 'domainColumn', header: 'domain' },
    { role: 'conceptClassColumn', header: 'concept_class' },
    { role: 'recordCountColumn', header: 'record_count' },
    { role: 'patientCountColumn', header: 'patient_count' },
    { role: 'infoJsonColumn', header: 'info_json' },
  ]

  for (const { role, header } of roleOrder) {
    const fileCol = columnMapping[role] as string | undefined
    if (fileCol) mappedCols.push({ header, fileCol })
  }

  // Add extra columns
  if (columnMapping.extraColumns) {
    for (const col of columnMapping.extraColumns) {
      mappedCols.push({ header: col, fileCol: col })
    }
  }

  // If no columns were mapped, export all original columns
  if (mappedCols.length === 0) {
    for (const col of columns) {
      mappedCols.push({ header: col, fileCol: col })
    }
  }

  const headerLine = mappedCols.map((c) => csvEscape(c.header)).join(',')
  const dataLines = rows.map((row) =>
    mappedCols.map((c) => csvEscape(row[c.fileCol] as string | number | undefined)).join(','),
  )

  return [headerLine, ...dataLines].join('\n')
}

// ---------------------------------------------------------------------------
// Browser download helper
// ---------------------------------------------------------------------------

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
