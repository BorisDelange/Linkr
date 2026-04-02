// --- Concept Mapping Enums ---

/** Mapping validation status (inspired by OHDSI Usagi). */
export type MappingStatus = 'unchecked' | 'approved' | 'rejected' | 'flagged' | 'invalid' | 'ignored'

/** SKOS mapping predicate (SSSOM standard). */
export type MappingEquivalence =
  | 'skos:exactMatch'
  | 'skos:closeMatch'
  | 'skos:broadMatch'
  | 'skos:narrowMatch'
  | 'skos:relatedMatch'

/** OMOP mapping type (relationship between source and target). */
export type MappingType = 'maps_to' | 'maps_to_value' | 'maps_to_unit' | 'maps_to_operator'

// --- Concept Set (OHDSI Concept Set Specification) ---

/** A single item in a concept set expression. */
export interface ConceptSetItem {
  concept: {
    conceptId: number
    conceptName: string
    vocabularyId: string
    domainId: string
    conceptClassId: string
    standardConcept: string | null
    conceptCode: string
  }
  isExcluded: boolean
  includeDescendants: boolean
  includeMapped: boolean
}

/** An OHDSI concept set with expression and optional resolved IDs. Workspace-scoped. */
/** Per-language translations for concept set metadata. */
export interface ConceptSetTranslation {
  name?: string
  description?: string
  longDescription?: string
  category?: string
  subcategory?: string
}

export interface ConceptSet {
  id: string
  workspaceId: string
  name: string
  description: string
  expression: { items: ConceptSetItem[] }
  /** Resolved concept IDs (after expanding descendants + mapped). Null = not resolved. */
  resolvedConceptIds: number[] | null
  /** Origin URL (GitHub, ATLAS, etc). */
  sourceUrl?: string
  /** Category from metadata (e.g. "Clinical observation"). */
  category?: string
  /** Subcategory from metadata (e.g. "Neurological assessment"). */
  subcategory?: string
  /** Provenance: name of the organization that created the concept set. */
  provenance?: string
  /** Version label (e.g. "1.0.0") from the source concept set JSON. */
  version?: string
  /** Batch ID grouping concept sets imported together from a catalog. */
  importBatchId?: string
  /** Multilingual translations keyed by ISO 639-1 code (e.g. { en: {...}, fr: {...} }). */
  translations?: Record<string, ConceptSetTranslation>
  createdAt: string
  updatedAt: string
}

// --- Mapping Project ---

export type MappingProjectSourceType = 'database' | 'file'

export interface MappingProjectStats {
  totalSourceConcepts: number
  mappedCount: number
  approvedCount: number
  flaggedCount: number
  ignoredCount: number
  unmappedCount: number
}

/** Column mapping for file-based concept sources. */
export interface FileColumnMapping {
  /** Column containing the terminology / vocabulary name. */
  terminologyColumn?: string
  /** Column containing the concept code. */
  conceptCodeColumn?: string
  /** Column containing the concept ID (numeric). */
  conceptIdColumn?: string
  /** Column containing the concept name / label. */
  conceptNameColumn?: string
  /** Column containing domain information. */
  domainColumn?: string
  /** Column containing concept class information. */
  conceptClassColumn?: string
  /** Column containing category information. */
  categoryColumn?: string
  /** Column containing subcategory information. */
  subcategoryColumn?: string
  /** Column containing a JSON blob with extra concept info (distribution, granularity…). */
  infoJsonColumn?: string
  /** Column containing record count. */
  recordCountColumn?: string
  /** Column containing patient count. */
  patientCountColumn?: string
  /** Additional columns to include in the import (available as extra data on each row). */
  extraColumns?: string[]
}

/** Imported file source data stored on the project. */
export interface FileSourceData {
  /** Original filename. */
  fileName: string
  /** All rows from the parsed file. */
  rows: Record<string, unknown>[]
  /** Column names from the file. */
  columns: string[]
  /** Column mapping (which file column maps to which concept field). */
  columnMapping: FileColumnMapping
  /** Parse options used (delimiter, encoding, etc.). */
  parseOptions?: {
    delimiter?: string
    encoding?: string
    skipRows?: number
    hasHeader?: boolean
    sheet?: string
  }
}

export type MappingProjectStatus = 'in_progress' | 'on_hold' | 'completed'

/** A workspace-level mapping project linked to a database or file. */
export interface MappingProject {
  id: string
  workspaceId: string
  name: string
  description: string
  /** Project status: tracks whether the mapping work is ongoing or done. */
  status?: MappingProjectStatus
  /** Badges for grouping/tagging (e.g. hospital center name). */
  badges?: import('./index').ProjectBadge[]
  /** Source type: database or imported file. */
  sourceType: MappingProjectSourceType
  /** Database to map source concepts from (clinical data). Only used when sourceType = 'database'. */
  dataSourceId: string
  /** Optional vocabulary reference database (ATHENA import). When set, target concept
   *  searches and concept set resolution use this DB instead of the source DB. */
  vocabularyDataSourceId?: string
  /** File source data. Only used when sourceType = 'file'. */
  fileSourceData?: FileSourceData
  /** Concept sets used in this project (workspace-scoped IDs). */
  conceptSetIds: string[]
  /** Cached progress stats. */
  stats?: MappingProjectStats
  /** History of bulk catalog imports. */
  importBatches?: ConceptSetImportBatch[]
  createdAt: string
  updatedAt: string
}

// --- Import Batch ---

/** Record of a bulk catalog import (stored on MappingProject). */
export interface ConceptSetImportBatch {
  id: string
  sourceName: string
  sourceUrl?: string
  count: number
  importedAt: string
}

// --- Resolved Concept ---

/** A fully resolved concept (from concept_sets_resolved). */
export interface ResolvedConcept {
  conceptId: number
  conceptName: string
  vocabularyId: string
  domainId: string
  conceptClassId: string
  conceptCode: string
  standardConcept: string | null
}

// --- Mapping Comment ---

/** A single comment on a concept mapping (mapping or review phase). */
export interface MappingComment {
  id: string
  authorId: string
  text: string
  createdAt: string
}

// --- Mapping Review ---

/** A single reviewer's opinion on a concept mapping. */
export interface MappingReview {
  id: string
  reviewerId: string
  status: MappingStatus
  comment?: string
  createdAt: string
}

// --- Concept Mapping ---

/** A single source → target concept mapping. */
export interface ConceptMapping {
  id: string
  projectId: string
  // Source
  sourceConceptId: number
  sourceConceptName: string
  sourceVocabularyId: string
  sourceDomainId: string
  sourceConceptCode: string
  sourceFrequency?: number
  /** Source concept category (from categoryColumn in concept dictionary). */
  sourceCategoryId?: string
  /** Source concept subcategory (from subcategoryColumn in concept dictionary). */
  sourceSubcategoryId?: string
  /** Source concept class (from extraColumns.concept_class_id, OMOP-specific). */
  sourceConceptClassId?: string
  // Target
  targetConceptId: number
  targetConceptName: string
  targetVocabularyId: string
  targetDomainId: string
  targetConceptCode: string
  /** Target concept class (e.g. concept_class_id in OMOP vocabulary). */
  targetConceptClassId?: string
  // Mapping metadata
  conceptSetId?: string
  /** @deprecated Not used in UI or exports. Kept for data compatibility. */
  mappingType?: MappingType
  equivalence: MappingEquivalence
  status: MappingStatus
  matchScore?: number
  comment?: string
  /** Threaded comments (mapping + review). */
  comments?: MappingComment[]
  /** Multi-reviewer opinions on this mapping. */
  reviews?: MappingReview[]
  // Provenance
  mappedBy?: string
  mappedOn?: string
  // Review
  assignedReviewer?: string
  reviewedBy?: string
  reviewedOn?: string
  reviewComment?: string
  // Timestamps
  createdAt: string
  updatedAt: string
}

// --- Source Concept ID Registry (OMOP custom IDs > 2,000,000,000) ---

/**
 * Range configuration for one badge label in the source concept ID registry.
 * IDs are assigned deterministically by (vocabularyId, conceptCode) within the range.
 */
export interface SourceConceptIdRange {
  /** Workspace this range belongs to. */
  workspaceId: string
  /** Badge label this range is for (e.g. "Rennes", "Nantes"). */
  badgeLabel: string
  /** Inclusive start of the range (must be > 2,000,000,000). */
  rangeStart: number
  /** Inclusive end of the range. */
  rangeEnd: number
  /** Next available ID to assign within this range. */
  nextId: number
  /** Total source concepts covered by projects with this badge (updated on each assignIds run). */
  totalConcepts?: number
  createdAt: string
  updatedAt: string
}

/**
 * A single entry in the source concept ID registry.
 * Maps a (workspaceId, badgeLabel, vocabularyId, conceptCode) tuple to a stable custom source_concept_id.
 * Key: `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`
 */
export interface SourceConceptIdEntry {
  /** Composite key: `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}` */
  id: string
  workspaceId: string
  badgeLabel: string
  vocabularyId: string
  conceptCode: string
  sourceConceptId: number
  createdAt: string
}
