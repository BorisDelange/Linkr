import type { Seedable, LocalizedString } from './index'
import type { AuthorDetails, Authored } from './author'

// --- Concept Mapping Enums ---

/** Mapping validation status (inspired by OHDSI Usagi). */
export type MappingStatus = 'unchecked' | 'approved' | 'rejected' | 'flagged' | 'invalid' | 'ignored' | 'suggested'

/** Display-only status. `disputed` is computed from contradicting reviews and is never stored. */
export type EffectiveMappingStatus = MappingStatus | 'disputed'

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
  /** Stable cross-install identifier from the source JSON (`metadata.uniqueId`).
   *  Unlike `id` (a random UUID minted per import), this is set by the authoring
   *  tool and is identical across installs — AI suggestion rows reference it to
   *  link back to the concept set that was used for the mapping. */
  uniqueId?: string
  /** Data-dictionary repo this concept set came from (`metadata.sourceRepo`).
   *  Lets the UI offer "import this dictionary" when a referenced set is absent. */
  sourceRepo?: string
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
  /**
   * All rows from the parsed file.
   * @deprecated Kept for backward compatibility with existing projects.
   * New projects store a raw file buffer instead and load via DuckDB.
   */
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
  /**
   * Raw file content stored as Uint8Array (IDB-cloneable).
   * When present, DuckDB loads directly from this via read_csv_auto instead
   * of from the parsed `rows` array — much faster and uses less memory.
   */
  rawFileBuffer?: Uint8Array
  /** Total row count (known without parsing all rows when rawFileBuffer is used). */
  totalRowCount?: number
  /**
   * Blob sha of a file already uploaded during the create flow (server mode
   * Parquet, whose columns are previewed server-side before the project exists).
   * When set, the create/update path attaches this sha instead of re-uploading.
   * Client-only; never persisted to the browser DB or sent as project metadata.
   */
  preUploadedSha?: string
}

export type MappingProjectStatus = 'in_progress' | 'on_hold' | 'completed'

/** A workspace-level mapping project linked to a database or file. */
export interface MappingProject extends Seedable, Authored {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId?: string
  workspaceId: string
  name: LocalizedString
  description: LocalizedString
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
  /** Git repository this mapping project is linked to. When set, workspace export emits metadata + this pointer only. */
  gitRemoteConfig?: import('./index').GitRemoteConfig
  /** Frozen provenance snapshot of the origin organization (inlined on standalone export). Not a live link. */
  organization?: import('./index').OrganizationInfo
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
  /** Structured author identity (affiliation, profession, ORCID) captured at write time. */
  authorDetails?: AuthorDetails
  text: string
  createdAt: string
}

// --- Mapping Review ---

/** A single reviewer's opinion on a concept mapping. */
export interface MappingReview {
  id: string
  reviewerId: string
  /** Structured reviewer identity captured at write time. */
  reviewerDetails?: AuthorDetails
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
  /** Target standard concept flag ('S' = Standard, 'C' = Classification). */
  targetStandardConcept?: string
  // Mapping metadata
  conceptSetId?: string
  /** @deprecated Not used in UI or exports. Kept for data compatibility. */
  mappingType?: MappingType
  equivalence: MappingEquivalence
  status: MappingStatus
  matchScore?: number
  /** Threaded comments (mapping + review). */
  comments?: MappingComment[]
  /** Multi-reviewer opinions on this mapping. */
  reviews?: MappingReview[]
  // Provenance
  mappedBy?: string
  /** Structured author identity of the mapper (affiliation, profession, ORCID). */
  mappedByDetails?: AuthorDetails
  mappedOn?: string
  // Review
  assignedReviewer?: string
  reviewedBy?: string
  /** Structured author identity of the reviewer. */
  reviewedByDetails?: AuthorDetails
  reviewedOn?: string
  reviewComment?: string
  // Timestamps
  createdAt: string
  updatedAt: string
}

// --- Suggestion Scores (imported from precomputed scores file) ---

/**
 * A single precomputed similarity score row, scoped to a mapping project.
 * Key: `${projectId}__${sourceVocabularyId}__${sourceConceptCode}__${conceptId}__${method}`
 */
export interface SuggestionScore {
  id: string
  projectId: string
  sourceVocabularyId: string
  sourceConceptCode: string
  conceptId: number
  method: string
  score: number
  /** SKOS equivalence predicate. Always `skos:exactMatch` for syntactic/semantic rows; AI rows may nuance. */
  equivalence: string
  /** Free-text justification. Populated by AI rows only. */
  comment: string | null
  /** ISO 8601 UTC timestamp from the producing script. */
  createdAt: string | null
  /** uniqueId of the data-dictionary concept set an AI row aligned against; null otherwise. */
  conceptSetUid?: string | null
  /** sourceRepo of that dictionary; null whenever conceptSetUid is null. */
  conceptSetSourceRepo?: string | null
  importedAt: string
}

/**
 * Project-level scores metadata, built once at import time.
 * Lets the UI answer "does this source concept have suggestions?" in O(1)
 * without scanning the parquet, and surfaces totals to the management dialog.
 */
export interface ScoresIndex {
  projectId: string
  rowCount: number
  methods: string[]
  /** Set of `${sourceVocabularyId}::${sourceConceptCode}` keys. */
  sourceKeys: Set<string>
  /** Per suggestion-category subsets of `sourceKeys`: which source concepts have at
   *  least one suggestion of that category. `data_dictionary` = a row aligned to a
   *  data-dictionary concept set (non-null `concept_set_uid`); the others map from the
   *  `method` prefix. Used to filter the source table. Empty for legacy scores files. */
  categorySourceKeys: Record<SuggestionCategory, Set<string>>
  importedAt: string
}

/** Filterable suggestion categories, derived from the scores `method` (+ concept-set link). */
export type SuggestionCategory = 'syntactic' | 'semantic' | 'statistical' | 'agentic' | 'data_dictionary'

export const SUGGESTION_CATEGORIES: SuggestionCategory[] = ['syntactic', 'semantic', 'statistical', 'agentic', 'data_dictionary']

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
