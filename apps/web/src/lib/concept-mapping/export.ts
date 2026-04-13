import type { ConceptMapping, MappingProject, FileColumnMapping, SourceConceptIdEntry } from '@/types'

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
export function exportToSourceToConceptMap(
  mappings: ConceptMapping[],
  project?: MappingProject | MappingProject[],
  /** Optional registry entries — if provided, used to resolve source_concept_id for file projects without a conceptIdColumn */
  registryEntries?: SourceConceptIdEntry[],
): string {
  // Build a per-project lookup when multiple projects are passed (global summary export)
  const projectMap = Array.isArray(project)
    ? new Map(project.map((p) => [p.id, p]))
    : null

  // Build registry lookup: (vocabularyId, conceptCode) → sourceConceptId
  const registryMap = registryEntries
    ? new Map(registryEntries.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e.sourceConceptId]))
    : null

  const header = [
    'source_code', 'source_concept_id', 'source_vocabulary_id',
    'source_code_description', 'target_concept_id', 'target_vocabulary_id',
    'valid_start_date', 'valid_end_date', 'invalid_reason',
  ].join(',')

  const rows = mappings.map((m) => {
    // Resolve the project for this mapping
    const resolvedProject = projectMap ? projectMap.get(m.projectId) : project as MappingProject | undefined
    // File project without conceptIdColumn: artificial index — try registry, fallback to 0
    // Artificial ID = file project without conceptIdColumn, OR database project (non-OMOP source)
    // In both cases, use registry if available, fallback to 0
    const isArtificialId = resolvedProject?.sourceType === 'database'
      || (resolvedProject?.sourceType === 'file' && !resolvedProject.fileSourceData?.columnMapping?.conceptIdColumn)
    let sourceConceptId: number
    if (!isArtificialId) {
      sourceConceptId = m.sourceConceptId
    } else if (registryMap && m.sourceVocabularyId && m.sourceConceptCode) {
      sourceConceptId = registryMap.get(`${m.sourceVocabularyId}__${m.sourceConceptCode}`) ?? 0
    } else {
      sourceConceptId = 0
    }
    return [
      csvEscape(m.sourceConceptCode),
      csvEscape(sourceConceptId),
      csvEscape(m.sourceVocabularyId),
      csvEscape(m.sourceConceptName),
      csvEscape(m.targetConceptId),
      csvEscape(m.targetVocabularyId),
      csvEscape('1970-01-01'),
      csvEscape('2099-12-31'),
      csvEscape(''),
    ].join(',')
  })

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
import { slugify } from '@/lib/entity-io'

interface BuildMappingProjectFolderOptions {
  /** DuckDB query function — needed for DB-based source concepts export. */
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

  // Core data files (concept sets and import history excluded — reimportable from ATHENA)
  // rawFileBuffer excluded — binary data, not JSON-serializable, exported separately as source-concepts.csv
  const { conceptSetIds: _, importBatches: _ib, fileSourceData, ...projectClean } = project
  const projectJson = {
    ...projectClean,
    ...(fileSourceData ? {
      fileSourceData: {
        ...fileSourceData,
        rawFileBuffer: undefined,
        rows: [],  // Don't serialize rows either (legacy)
      },
    } : {}),
  }
  zip.file(`${prefix}project.json`, JSON.stringify(projectJson, null, 2))
  zip.file(`${prefix}mappings.json`, JSON.stringify(mappings, null, 2))

  // Formatted export files
  zip.file(`${prefix}sssom.tsv`, exportToSssomTsv(mappings, project))
  zip.file(`${prefix}source-to-concept-map.csv`, exportToSourceToConceptMap(mappings, project))
  zip.file(`${prefix}usagi.csv`, exportToUsagiCsv(mappings))

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
