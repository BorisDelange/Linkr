import type { ConceptMapping, MappingProject, FileColumnMapping, SourceConceptIdEntry } from '@/types'
import { localized } from '@/lib/localized'
import { stripInstanceFields, attachEntityOrganization, licenseMeta, writeReadmeFiles, writeLicenseFile, writeAttachmentFiles } from '@/lib/entity-io'
import { mappingKey } from '@/lib/concept-mapping/merge'
import { compareCodePoints } from '@/lib/concept-mapping/source-concept-ids-io'
import { buildCcrCsvs } from '@/lib/concept-mapping/ccr-export'

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

/**
 * Restore `fileSourceData` on a MappingProject from a raw CSV string.
 * Parses the CSV header, stores the CSV verbatim in `rawFileBuffer`, and sets
 * `columns`, `totalRowCount`, and rebuilds `columnMapping` (handles both
 * normalized and original column names).
 *
 * The CSV is kept as-is here — deduplication of source concepts that repeat a
 * `(vocabulary_id, concept_code)` pair is NOT done at import; it happens
 * downstream when the file is mounted into DuckDB (the `source_concepts` view's
 * QUALIFY row_number() dedup, identically on client — engine.ts — and server —
 * db_connect.query_file_source), and the dropped-row count is computed from the
 * raw-vs-deduped view sizes there.
 */
export function restoreFileSourceDataFromCsv(project: MappingProject, csvText: string): void {
  if (!project.fileSourceData || project.sourceType !== 'file') return
  // An unresolved Git LFS pointer (server clone couldn't smudge it, e.g. private
  // LFS endpoint auth failed) is a 3-line stub, not the CSV. Importing it would
  // silently yield zero source concepts — better to skip so the file stays absent
  // and the failure is visible, rather than materializing a bogus tiny source.
  if (csvText.startsWith('version https://git-lfs')) return
  project.fileSourceData.rawFileBuffer = new TextEncoder().encode(csvText)
  const headerLine = csvText.split('\n')[0]?.trim()
  if (!headerLine) return
  // Strip surrounding quotes from each column name (CSV may quote headers)
  const csvColumns = headerLine.split(',').map(c => c.replace(/^"|"$/g, '').trim())
  project.fileSourceData.columns = csvColumns
  project.fileSourceData.totalRowCount = csvText.split('\n').length - 1
  // Rebuild columnMapping: try normalized names first, fall back to project's existing mapping
  const colSet = new Set(csvColumns)
  const existing = project.fileSourceData.columnMapping ?? {} as FileColumnMapping

  // Re-importing the SAME project (e.g. cloning a git-linked one) already carries a
  // valid mapping — every mapped column still present in the CSV. Reassigning it
  // below would re-emit the keys in the code's canonical order, producing a
  // no-op-but-noisy git diff on the next export. Keep the existing mapping verbatim.
  const existingTargets = Object.entries(existing)
    .filter(([k, v]) => k !== 'extraColumns' && typeof v === 'string' && v)
    .map(([, v]) => v as string)
  if (existingTargets.length > 0 && existingTargets.every(c => colSet.has(c))) {
    return
  }
  const pick = (normalized: string, existingVal?: string) =>
    colSet.has(normalized) ? normalized : (existingVal && colSet.has(existingVal) ? existingVal : undefined)
  const mapping: Record<string, string | undefined> = {
    terminologyColumn: pick('terminology', existing.terminologyColumn),
    conceptCodeColumn: pick('concept_code', existing.conceptCodeColumn),
    conceptIdColumn: pick('concept_id', existing.conceptIdColumn),
    conceptNameColumn: pick('concept_name', existing.conceptNameColumn),
    domainColumn: pick('domain', existing.domainColumn),
    conceptClassColumn: pick('concept_class', existing.conceptClassColumn),
    recordCountColumn: pick('record_count', existing.recordCountColumn),
    patientCountColumn: pick('patient_count', existing.patientCountColumn),
    infoJsonColumn: pick('info_json', existing.infoJsonColumn),
    categoryColumn: pick('category', existing.categoryColumn),
    subcategoryColumn: pick('subcategory', existing.subcategoryColumn),
  }
  const mappedCols = new Set(Object.values(mapping).filter(Boolean))
  const extras = csvColumns.filter(c => !mappedCols.has(c))
  if (extras.length > 0) mapping.extraColumns = extras as unknown as string | undefined
  project.fileSourceData.columnMapping = mapping as FileColumnMapping
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
 *
 * Per Usagi modern convention (https://ohdsi.github.io/Usagi/):
 * - "Ignored" / "no mapping needed" = `mappingStatus=APPROVED, equivalence=UNMATCHED, conceptId=0`
 *   (Usagi's IGNORED status is kept only for backwards compatibility in their codebase.)
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

  const rows = mappings.map((m) => {
    const noTarget = m.status === 'ignored' || m.targetConceptId === 0
    const usagiStatus = m.status === 'ignored' ? 'APPROVED' : statusToUsagi(m.status)
    const usagiEquivalence = noTarget ? 'UNMATCHED' : equivalenceToUsagi(m.equivalence)
    return [
      csvEscape(m.sourceConceptCode),
      csvEscape(m.sourceConceptName),
      csvEscape(m.sourceFrequency),
      csvEscape(m.sourceConceptId),
      csvEscape(m.matchScore ?? 0),
      csvEscape(usagiStatus),
      csvEscape(usagiEquivalence),
      csvEscape(m.mappedBy),
      csvEscape(isoToEpochMs(m.mappedOn)),
      csvEscape(m.targetConceptId),
      csvEscape(m.targetConceptName),
      csvEscape(m.targetDomainId),
      csvEscape(m.mappingType?.toUpperCase()),
      csvEscape(m.comments?.map((c) => c.text).join(' | ') ?? ''),
      csvEscape(m.mappedBy),
      csvEscape(isoToEpochMs(m.createdAt)),
      csvEscape(m.assignedReviewer),
    ].join(',')
  })

  return [header, ...rows].join('\n')
}

/**
 * Append source-only rows (no target) to a USAGI CSV.
 * Source concepts with no review yet → `mappingStatus=UNCHECKED, equivalence=UNREVIEWED`.
 */
export function exportUnmappedToUsagi(
  allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[],
  excludeKeys: Set<string>,
): string {
  const rows = allSourceConcepts
    .filter((c) => !excludeKeys.has(`${c.vocabularyId}__${c.conceptCode}`))
    .map((c) => [
      csvEscape(c.conceptCode),
      csvEscape(c.conceptName),
      csvEscape(0),
      csvEscape(0),
      csvEscape(0),
      csvEscape('UNCHECKED'),
      csvEscape('UNREVIEWED'),
      csvEscape(''),
      csvEscape(''),
      csvEscape(0),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
    ].join(','))
  return rows.join('\n')
}

// ---------------------------------------------------------------------------
// SOURCE_TO_CONCEPT_MAP export (OMOP CDM table format)
// ---------------------------------------------------------------------------

/**
 * Export approved mappings as OMOP source_to_concept_map CSV.
 * Ready for ETL import into an OMOP CDM target database.
 */
export function exportToSourceToConceptMap(
  mappings: ConceptMapping[],
  project?: MappingProject | MappingProject[],
  /** Optional registry entries — if provided, used to resolve source_concept_id for file projects without a conceptIdColumn */
  registryEntries?: SourceConceptIdEntry[],
): string {
  const header = [
    'source_code', 'source_concept_id', 'source_vocabulary_id',
    'source_code_description', 'target_concept_id', 'target_vocabulary_id',
    'valid_start_date', 'valid_end_date', 'invalid_reason',
  ].join(',')

  // Ids resolved once, by the same rule the C/CR export uses — the two formats
  // describe the same concepts and must never disagree on their ids.
  const rows = withRegistryIds(mappings, project, registryEntries).map((m) => [
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
// CONCEPT / CONCEPT_RELATIONSHIP export (the OMOP v5 way)
// ---------------------------------------------------------------------------

/**
 * Export the alignments as OMOP CONCEPT + CONCEPT_RELATIONSHIP.
 *
 * The download counterpart of `buildCcrCsvs`: same canonical builder, but the
 * source concept ids come from the workspace registry when the project has no
 * usable id of its own (database projects and file projects without a
 * conceptIdColumn), exactly as `exportToSourceToConceptMap` resolves them.
 *
 * Returns both files — the Export tab zips them, since C/CR is two tables.
 */
export function exportToConceptAndRelationship(
  mappings: ConceptMapping[],
  project?: MappingProject | MappingProject[],
  registryEntries?: SourceConceptIdEntry[],
): { conceptCsv: string; conceptRelationshipCsv: string } {
  const resolved = withRegistryIds(mappings, project, registryEntries)
  const { conceptCsv, conceptRelationshipCsv } = buildCcrCsvs(resolved)
  return { conceptCsv, conceptRelationshipCsv }
}

/**
 * Append the source concepts that have no mapping at all, as bare concepts.
 *
 * They carry no relationship — an unmapped code IS a concept with no `Maps to`.
 * This is what lets a C/CR export still describe the whole dictionary, and what
 * the derived STCM turns back into `target_concept_id = 0` rows.
 */
export function exportUnmappedToConcept(
  allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[],
  excludeKeys: Set<string>,
  registryEntries?: SourceConceptIdEntry[],
): string {
  const registryMap = registryEntries
    ? new Map(registryEntries.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e.sourceConceptId]))
    : null

  return allSourceConcepts
    .filter((c) => !excludeKeys.has(`${c.vocabularyId}__${c.conceptCode}`))
    .map((c) => [
      csvEscape(registryMap?.get(`${c.vocabularyId}__${c.conceptCode}`) ?? 0),
      csvEscape(c.conceptName),
      csvEscape('Observation'),
      csvEscape(c.vocabularyId),
      csvEscape('Observation'),
      csvEscape(''),
      csvEscape(c.conceptCode),
      csvEscape('1970-01-01'),
      csvEscape('2099-12-31'),
      csvEscape(''),
    ].join(','))
    .join('\n')
}

/**
 * Overlay the registry-resolved source concept id onto each mapping.
 *
 * A "artificial" id — a database project, or a file project with no
 * conceptIdColumn — carries no meaningful `sourceConceptId`, so the workspace
 * registry is the authority. Doing it here keeps the id policy in ONE place for
 * both the STCM and the C/CR download paths.
 */
function withRegistryIds(
  mappings: ConceptMapping[],
  project?: MappingProject | MappingProject[],
  registryEntries?: SourceConceptIdEntry[],
): ConceptMapping[] {
  const projectMap = Array.isArray(project) ? new Map(project.map((p) => [p.id, p])) : null
  const registryMap = registryEntries
    ? new Map(registryEntries.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e.sourceConceptId]))
    : null

  return mappings.map((m) => {
    const resolvedProject = projectMap ? projectMap.get(m.projectId) : project as MappingProject | undefined
    const isArtificialId = resolvedProject?.sourceType === 'database'
      || (resolvedProject?.sourceType === 'file' && !resolvedProject.fileSourceData?.columnMapping?.conceptIdColumn)
    if (!isArtificialId) return m
    const fromRegistry = registryMap?.get(`${m.sourceVocabularyId}__${m.sourceConceptCode}`)
    return { ...m, sourceConceptId: fromRegistry ?? 0 }
  })
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
 *
 * Per SSSOM spec (https://mapping-commons.github.io/sssom/spec-model/):
 * - When no target concept exists (status='ignored' or targetConceptId=0),
 *   `sssom:NoTermFound` is placed in `object_id` (NOT in `predicate_id`).
 * - The original `predicate_id` is preserved (typically `skos:exactMatch`).
 * - `object_source` MUST still indicate where the term was searched.
 * - Cardinality is `1:0` for these rows.
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
    `#mapping_set_title: "${localized(project.name, 'en')}"`,
    `#mapping_date: "${new Date().toISOString().split('T')[0]}"`,
    `#license: "https://creativecommons.org/publicdomain/zero/1.0/"`,
  ]

  const header = [
    'subject_id', 'subject_label', 'subject_source',
    'predicate_id',
    'object_id', 'object_label', 'object_source',
    'mapping_cardinality',
    'mapping_justification', 'confidence',
    'author_id', 'comment',
  ].join('\t')

  const rows = mappings.map((m) => {
    const noTarget = m.status === 'ignored' || m.targetConceptId === 0
    // Default object_source to "OHDSI" so SSSOM consumers know where the search happened.
    const targetSource = m.targetVocabularyId || 'OHDSI'
    return [
      tsvEscape(`${m.sourceVocabularyId}:${m.sourceConceptCode}`),
      tsvEscape(m.sourceConceptName),
      tsvEscape(m.sourceVocabularyId),
      tsvEscape(equivalenceToSkosPredicate(m.equivalence)),
      tsvEscape(noTarget ? 'sssom:NoTermFound' : `OHDSI:${m.targetConceptId}`),
      tsvEscape(noTarget ? '' : m.targetConceptName),
      tsvEscape(noTarget ? targetSource : m.targetVocabularyId),
      tsvEscape(noTarget ? '1:0' : ''),
      tsvEscape(m.status === 'ignored' ? 'semapv:ManualMappingCuration' : statusToJustification(m.status)),
      tsvEscape(m.matchScore),
      tsvEscape(m.mappedBy),
      tsvEscape(m.comments?.map((c) => c.text).join(' | ') ?? ''),
    ].join('\t')
  })

  return [...metadataLines, header, ...rows].join('\n')
}

/**
 * Append source-only rows (no target) to an SSSOM TSV.
 * Per SSSOM spec, `sssom:NoTermFound` goes in `object_id` (cardinality 1:0),
 * and `predicate_id` defaults to `skos:exactMatch` since no other relation was determined.
 */
export function exportUnmappedToSssom(
  allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[],
  excludeKeys: Set<string>,
): string {
  const rows = allSourceConcepts
    .filter((c) => !excludeKeys.has(`${c.vocabularyId}__${c.conceptCode}`))
    .map((c) => [
      tsvEscape(`${c.vocabularyId}:${c.conceptCode}`),
      tsvEscape(c.conceptName),
      tsvEscape(c.vocabularyId),
      tsvEscape('skos:exactMatch'),
      tsvEscape('sssom:NoTermFound'),
      tsvEscape(''),
      tsvEscape('OHDSI'),
      tsvEscape('1:0'),
      tsvEscape('semapv:UnspecifiedMatching'),
      tsvEscape(''),
      tsvEscape(''),
      tsvEscape(''),
    ].join('\t'))
  return rows.join('\n')
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
): string {
  return JSON.stringify(
    {
      exportFormat: 'linkr-concept-mapping',
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: localized(project.name, 'en'),
        description: localized(project.description, 'en'),
        dataSourceId: project.dataSourceId,
        vocabularyDataSourceId: project.vocabularyDataSourceId,
      },
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
// Source-to-concept-map rows for unmapped source concepts (target_concept_id = 0)
// ---------------------------------------------------------------------------

/**
 * Generate STCM rows with target_concept_id = 0 for source concepts that have
 * no approved mapping. Per OMOP ETL convention, these allow clinical tables to
 * always JOIN source_to_concept_map.
 *
 * @param allSourceConcepts - All source concepts for the project(s)
 * @param mappedSourceKeys - Set of "vocabularyId__conceptCode" strings already in the mapped export
 * @param registryEntries - Optional registry for source_concept_id resolution
 */
export function exportUnmappedToStcm(
  allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[],
  mappedSourceKeys: Set<string>,
  registryEntries?: SourceConceptIdEntry[],
): string {
  const registryMap = registryEntries
    ? new Map(registryEntries.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e.sourceConceptId]))
    : null

  const rows = allSourceConcepts
    .filter((c) => !mappedSourceKeys.has(`${c.vocabularyId}__${c.conceptCode}`))
    .map((c) => {
      const sourceConceptId = registryMap?.get(`${c.vocabularyId}__${c.conceptCode}`) ?? 0
      return [
        csvEscape(c.conceptCode),
        csvEscape(sourceConceptId),
        csvEscape(c.vocabularyId),
        csvEscape(c.conceptName),
        csvEscape(0), // target_concept_id = 0
        csvEscape(''),
        csvEscape('1970-01-01'),
        csvEscape('2099-12-31'),
        csvEscape(''),
      ].join(',')
    })

  if (rows.length === 0) return ''

  const header = [
    'source_code', 'source_concept_id', 'source_vocabulary_id',
    'source_code_description', 'target_concept_id', 'target_vocabulary_id',
    'valid_start_date', 'valid_end_date', 'invalid_reason',
  ].join(',')

  return [header, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// Build mapping project ZIP folder
// ---------------------------------------------------------------------------

import type JSZip from 'jszip'
import type { Storage } from '@/lib/storage'

interface BuildMappingProjectFolderOptions {
  /** DuckDB query function — needed for DB-based source concepts export.
   *  Pass a paging query (queryDataSourceAll): in server mode a single response
   *  is capped at MAX_QUERY_ROWS (~10k), which would silently truncate a large
   *  source concept set. */
  queryDataSource?: (dsId: string, sql: string) => Promise<Record<string, unknown>[]>
  /** Ensure data source is mounted before querying. */
  ensureMounted?: (dsId: string) => Promise<void>
  /** Data sources list — needed to resolve the source DB schema. */
  dataSources?: import('@/types').DataSource[]
  /**
   * Skip adding source-concepts.csv to the ZIP.
   * Use when the caller will download it separately (e.g. large file-based sources).
   */
  skipSourceConcepts?: boolean
  /**
   * Include the precomputed similarity scores (similarity-scores.parquet) in the ZIP.
   * Opt-in — the file can be ~100 MB, so it is excluded by default (and from workspace export).
   */
  includeScores?: boolean
}

/**
 * Serialize the project's mappings for `mappings.json`. Instance-local, volatile
 * fields are dropped so the committed file tracks mapping *content*, not the DB's
 * bookkeeping: `id`/`projectId` are per-instance uuids (regenerated on pull/import
 * — see pull.ts), and `createdAt`/`updatedAt` are instance timestamps that churn on
 * every edit (or wholesale on reimport). These are exactly the fields the 3-way
 * merge already ignores (merge.ts COMPARED_FIELDS), so removing them can't hide a
 * real change. `mappedOn`/`reviewedOn` are kept — human-meaningful provenance.
 * Nested comments/reviews are left intact (their content, incl. their own ids, IS
 * compared by the merge, so stripping them there would fabricate conflicts). Rows
 * are sorted by a stable key so DB ordering never shows up as a spurious diff.
 */
function serializeMappingsForVersioning(mappings: ConceptMapping[]): string {
  const cleaned = mappings.map((m) => {
    const { id: _id, projectId: _p, createdAt: _c, updatedAt: _u, ...rest } = m
    return rest
  })
  // Sort by sourceConceptCode first (readable diffs), then break EVERY tie down to
  // the full merge identity: a source concept can map to several targets, so
  // sourceCode+sourceId alone leaves those rows tied → their order would follow DB
  // iteration and drift across instances, producing spurious diffs. mappingKey is
  // the merge's own row identity, so this is a total order.
  cleaned.sort((a, b) => {
    const byCode = compareCodePoints(a.sourceConceptCode, b.sourceConceptCode)
    if (byCode !== 0) return byCode
    return compareCodePoints(mappingKey(a as ConceptMapping), mappingKey(b as ConceptMapping))
  })
  return JSON.stringify(cleaned, null, 2)
}

/**
 * The portable project.json content for a mapping project, identical across the
 * standalone export and the workspace export's mapping-projects/ subfolders.
 *
 * Instance-specific fields (ownerId, timestamps, gitRemoteConfig, …) are stripped
 * so the file is portable and doesn't churn the git diff; conceptSetIds /
 * importBatches are re-derivable and dropped; rawFileBuffer/rows aren't
 * JSON-serialized (the source lives in source-concepts.csv). dataSourceId and
 * vocabularyDataSourceId are local data-source UUIDs meaningless elsewhere, so
 * dataSourceId is reset to '' (required by the type) and vocabularyDataSourceId
 * removed. A git-linked workspace entity re-adds its gitRemoteConfig pointer on
 * top of this (the one field the caller keeps).
 */
export function cleanMappingProjectMeta(project: MappingProject): Record<string, unknown> {
  const { conceptSetIds: _, importBatches: _ib, fileSourceData, vocabularyDataSourceId: _vds, readme: _readme, license, ...projectRest } = project
  return {
    ...stripInstanceFields(projectRest),
    // The readme and the licence text travel as README.md / LICENSE.md; only the
    // licence's identity stays here.
    ...(licenseMeta(license) ? { license: licenseMeta(license) } : {}),
    dataSourceId: '',
    ...(fileSourceData ? {
      fileSourceData: {
        ...fileSourceData,
        rawFileBuffer: undefined,
        rows: [],
      },
    } : {}),
  }
}

/**
 * Add all mapping project files to a JSZip folder.
 * Reused by both individual project export and workspace export.
 * Files: project.json, mappings.json, SSSOM, STCM, Usagi, source-concepts.
 */
export async function buildMappingProjectFolder(
  zip: JSZip,
  prefix: string,
  project: MappingProject,
  storage: Storage,
  options: BuildMappingProjectFolderOptions = {},
): Promise<void> {
  const mappings = await storage.conceptMappings.getByProject(project.id)

  const projectJson = cleanMappingProjectMeta(project)
  zip.file(`${prefix}project.json`, JSON.stringify(projectJson, null, 2))
  writeReadmeFiles(zip, prefix, project.readme)
  writeLicenseFile(zip, prefix, project.license)
  await writeAttachmentFiles(zip, prefix, storage, 'mapping-project', project.id)
  zip.file(`${prefix}mappings.json`, serializeMappingsForVersioning(mappings))

  // SSSOM / Usagi / source-to-concept-map are derivable from mappings.json — they
  // were dropped from the project ZIP to keep it lean. Use the dedicated buttons in
  // the Export tab when the user actually wants those formatted files.

  // Source concepts (file-based or DB-based)
  if (!options.skipSourceConcepts && project.sourceType === 'file' && project.fileSourceData) {
    if (project.fileSourceData.rawFileBuffer && project.fileSourceData.rawFileBuffer.byteLength > 0) {
      // Pass the raw buffer directly without compression (avoids memory overflow on large files)
      const buf = project.fileSourceData.rawFileBuffer instanceof Uint8Array
        ? project.fileSourceData.rawFileBuffer
        : new Uint8Array(project.fileSourceData.rawFileBuffer)
      zip.file(`${prefix}source-concepts.csv`, buf, { compression: 'STORE' })
    } else if (project.fileSourceData.rows.length > 0) {
      // Legacy format: export from parsed rows
      zip.file(
        `${prefix}source-concepts.csv`,
        exportSourceConceptsCsv(
          project.fileSourceData.rows,
          project.fileSourceData.columns,
          project.fileSourceData.columnMapping,
        ),
      )
    } else {
      // Server mode: the raw bytes never came to the browser (no rawFileBuffer,
      // rows empty). Fetch the source file from the blob store so the export
      // actually contains it — otherwise re-import has no source concepts.
      try {
        const { isServerMode } = await import('@/lib/api-client')
        if (isServerMode()) {
          const { fetchRawFileFromServer } = await import('@/lib/api/mapping-projects')
          const buf = await fetchRawFileFromServer(project.id)
          if (buf && buf.byteLength > 0) {
            zip.file(`${prefix}source-concepts.csv`, buf, { compression: 'STORE' })
          }
        }
      } catch {
        // Source file fetch failed — continue without it
      }
    }
  }
  if (!options.skipSourceConcepts && project.sourceType !== 'file' && project.dataSourceId && options.queryDataSource) {
    const ds = options.dataSources?.find(d => d.id === project.dataSourceId)
    if (ds?.schemaMapping) {
      try {
        if (options.ensureMounted) await options.ensureMounted(ds.id)
        const { buildSourceConceptsAllQuery } = await import('@/lib/concept-mapping/mapping-queries')
        const sql = buildSourceConceptsAllQuery(ds.schemaMapping, {})
        if (sql) {
          const rows = await options.queryDataSource(ds.id, sql)
          if (rows.length > 0) {
            zip.file(`${prefix}source-concepts.csv`, buildSourceConceptsCsvFromRows(rows))
          }
        }
      } catch {
        // Source concepts export failed — continue without it
      }
    }
  }

  // Precomputed similarity scores (opt-in — large parquet, stored in OPFS/IDB
  // front-only, or the blob store server-side; never in JSON)
  if (options.includeScores) {
    try {
      const { isServerMode } = await import('@/lib/api-client')
      if (isServerMode()) {
        const { fetchScoresFileFromServer } = await import('@/lib/api/scores')
        const buf = await fetchScoresFileFromServer(project.id)
        if (buf && buf.byteLength > 0) {
          zip.file(`${prefix}similarity-scores.parquet`, buf, { compression: 'STORE' })
        }
      } else {
        const { getScoresFile } = await import('@/lib/concept-mapping/scores-storage')
        const scoresFile = await getScoresFile(project.id)
        if (scoresFile) {
          zip.file(`${prefix}similarity-scores.parquet`, await scoresFile.arrayBuffer(), { compression: 'STORE' })
        }
      }
    } catch {
      // Scores export failed — continue without them
    }
  }

  // Assigned source-concept-ids (workspace registry, scoped to this project's
  // badges) — otherwise a project export silently loses them.
  try {
    const { buildProjectSourceConceptIds } = await import('@/lib/concept-mapping/source-concept-ids-io')
    await buildProjectSourceConceptIds(zip, prefix, project, storage)
  } catch {
    // Source-id export failed — continue without it
  }
}

/**
 * Build a standalone mapping-project export ZIP (metadata + mappings + concept
 * sets + source ids), for git versioning. Mirrors buildProjectZip's shape:
 * takes an id + storage and returns a blob. DB-sourced concept extraction
 * (queryDataSource/ensureMounted) is intentionally omitted — versioning tracks
 * the mapping definition, not a re-derivable DB dump.
 *
 * Parquet payloads (the precomputed similarity-scores.parquet and any other) are
 * never versioned — they can be ~100 MB and are fully re-derivable, their latest
 * version living in the app's OPFS/IDB / server blob store, not in git. The
 * `.gitignore` also excludes review/ and state.json, foreign files another tool
 * (the concept-mapping agent) writes into the repo that Linkr doesn't own. LFS is
 * never applied automatically — a file is tracked via LFS only through the user's
 * per-file toggle (lfsOverrides).
 */
export async function buildMappingProjectZip(
  projectId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; projectName: string } | null> {
  const project = await storage.mappingProjects.getById(projectId)
  if (!project) return null
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  await buildMappingProjectFolder(zip, '', project, storage, { includeScores: false })
  await attachEntityOrganization(zip, 'project.json', project, storage)

  zip.file('.gitignore', '*.parquet\nreview/\nstate.json\n')

  // LFS is opt-in only (see git-lfs.ts) — nothing is tracked automatically, so
  // .gitattributes exists only when the user forced a file into LFS by hand.
  const { resolveLfsPaths, buildGitAttributes } = await import('@/lib/git-lfs')
  const entries = await Promise.all(
    Object.values(zip.files)
      .filter((f) => !f.dir)
      .map(async (f) => ({ path: f.name, size: (await f.async('uint8array')).byteLength })),
  )
  const lfsPaths = resolveLfsPaths(entries, options.lfsOverrides ?? new Map())
  const attrs = buildGitAttributes(lfsPaths)
  if (attrs) zip.file('.gitattributes', attrs)

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, projectName: localized(project.name, 'en') || project.id }
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
