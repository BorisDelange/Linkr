import type { ConceptMapping, MappingProject, ConceptSet } from '@/types'

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string | number | undefined | null): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function tsvEscape(value: string | number | undefined | null): string {
  if (value == null) return ''
  return String(value).replace(/\t/g, ' ').replace(/\n/g, ' ')
}

// ---------------------------------------------------------------------------
// USAGI CSV export
// ---------------------------------------------------------------------------

/**
 * Export mappings in USAGI-compatible CSV format.
 * Columns match OHDSI Usagi's WriteCodeMappingsToFile format.
 */
export function exportToUsagiCsv(mappings: ConceptMapping[]): string {
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
    csvEscape(m.matchScore),
    csvEscape(m.status.toUpperCase()),
    csvEscape(m.equivalence.toUpperCase()),
    csvEscape(m.mappedBy),
    csvEscape(m.mappedOn),
    csvEscape(m.targetConceptId),
    csvEscape(m.targetConceptName),
    csvEscape(m.targetDomainId),
    csvEscape(m.mappingType),
    csvEscape(m.comment),
    csvEscape(m.mappedBy),
    csvEscape(m.createdAt),
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
export function exportToSourceToConceptMap(mappings: ConceptMapping[]): string {
  const header = [
    'source_code', 'source_concept_id', 'source_vocabulary_id',
    'source_code_description', 'target_concept_id', 'target_vocabulary_id',
    'valid_start_date', 'valid_end_date', 'invalid_reason',
  ].join(',')

  const rows = mappings.map((m) => [
    csvEscape(m.sourceConceptCode),
    csvEscape(m.sourceConceptId),
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

/** Map our equivalence values to SKOS predicates. */
function equivalenceToSkosPredicate(equiv: string): string {
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
 */
export function exportToSssomTsv(mappings: ConceptMapping[], project: MappingProject): string {
  // YAML metadata header
  const metadataLines = [
    `#curie_map:`,
    `#  skos: "http://www.w3.org/2004/02/skos/core#"`,
    `#  semapv: "https://w3id.org/semapv/vocab/"`,
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

  const rows = mappings.map((m) => [
    tsvEscape(`${m.sourceVocabularyId}:${m.sourceConceptCode}`),
    tsvEscape(m.sourceConceptName),
    tsvEscape(m.sourceVocabularyId),
    tsvEscape(equivalenceToSkosPredicate(m.equivalence)),
    tsvEscape(`OHDSI:${m.targetConceptId}`),
    tsvEscape(m.targetConceptName),
    tsvEscape(m.targetVocabularyId),
    tsvEscape(statusToJustification(m.status)),
    tsvEscape(m.matchScore),
    tsvEscape(m.mappedBy),
    tsvEscape(m.comment),
  ].join('\t'))

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
