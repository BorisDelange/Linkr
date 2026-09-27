import type { Seedable, LocalizedString, GitRemoteConfig, OrganizationInfo, EntityLicense } from './index'
import type { Authored, Lineaged } from './author'
import type { DataSourceRef } from './concept-mapping'

// --- Catalog Status ---

export type CatalogStatus = 'draft' | 'computing' | 'ready' | 'success' | 'error'

// --- Variables ---

/**
 * What a catalog can be broken down by. Every crossing is a list of these in
 * CATALOG_VARIABLE_ORDER — the order is the canonical one AND the display one:
 * the first variable of a pivot is its rows, so the variables that tend to have
 * the most values come first.
 */
export type CatalogVariableId = 'concept' | 'period' | 'service' | 'age' | 'sex'

export const CATALOG_VARIABLE_ORDER: readonly CatalogVariableId[] = ['concept', 'period', 'service', 'age', 'sex']

export type PeriodGranularity = 'month' | 'quarter' | 'year'

export interface PeriodVariableConfig {
  enabled: boolean
  granularity: PeriodGranularity
  /** Granularity units per period: 2 with 'year' counts every two years. Absent = 1. */
  step?: number
}

export interface AgeVariableConfig {
  enabled: boolean
  /**
   * Age bracket boundaries (sorted ascending).
   * E.g. [18, 65] → "[0;18[", "[18;65[", "[65;+∞[". The last bracket is open-ended.
   */
  brackets: number[]
}

export interface SexVariableConfig {
  enabled: boolean
}

export type ServiceGroupingMode = 'all' | 'top' | 'manual'

export interface ServiceVariableConfig {
  enabled: boolean
  /** visit_occurrence type (hospital) or visit_detail unit (unit stay). */
  level: 'visit' | 'visit_detail'
  /** All services as they are, the N largest + "Other", or named groups. */
  grouping: ServiceGroupingMode
  topN: number
  /** Manual grouping: raw service name → group name. */
  groups: Record<string, string>
  /** Manual grouping: whether a service left out of every group joins "Other" or keeps its name. */
  unassigned: 'other' | 'keep'
}

export interface ConceptVariableConfig {
  enabled: boolean
  /** Count each concept, or its category / subcategory from the concept dictionary. */
  level: 'concept' | 'category' | 'subcategory'
  /**
   * Key from ConceptDictionary (categoryColumn / subcategoryColumn / extraColumns)
   * used as the concept's category, e.g. 'domain_id' for OMOP. Also classifies
   * the concept list.
   */
  categoryColumn?: string
  subcategoryColumn?: string
  /** Every concept, or only the N concepts with the most patients. */
  scope: 'all' | 'top'
  topN: number
}

/**
 * What a cell counts beside its distinct patients, always counted. Stays are
 * hospital stays (visit_occurrence), unit stays the stays in a care unit
 * (visit_detail); each costs a distinct count per cell. Absent = stays only.
 */
export interface CatalogCounts {
  visits: boolean
  unitStays: boolean
}

export const DEFAULT_CATALOG_COUNTS: CatalogCounts = { visits: true, unitStays: false }

export interface CatalogVariables {
  concept?: ConceptVariableConfig
  period?: PeriodVariableConfig
  service?: ServiceVariableConfig
  age?: AgeVariableConfig
  sex?: SexVariableConfig
}

/** Common age bracket presets. */
export const AGE_BRACKET_PRESETS: Record<string, number[]> = {
  '5y': [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95],
  '10y': [10, 20, 30, 40, 50, 60, 70, 80, 90],
  '20y': [20, 40, 60, 80],
  'pediatric': [1, 2, 6, 12, 18, 25, 35, 50, 65, 80],
  'clinical': [2, 18, 25, 35, 45, 55, 65, 75, 85],
}

// --- Anonymization ---

export type AnonymizationMode = 'suppress' | 'replace'

export interface AnonymizationConfig {
  /** Minimum patient count per row. */
  threshold: number
  /** How to handle rows below threshold. 'suppress' removes them, 'replace' caps counts to threshold. Default 'replace'. */
  mode: AnonymizationMode
}

// --- Service Mapping (reusable per-workspace entity) ---

export interface ServiceMappingRule {
  /** Raw value(s) from the care_site/unit column. */
  rawValues: string[]
  /** Display label (e.g., "Cardiologie"). */
  groupLabel: string
}

export interface ServiceMapping {
  id: string
  workspaceId: string
  name: string
  description: string
  rules: ServiceMappingRule[]
  createdAt: string
  updatedAt: string
}

// --- Data Catalog ---

export interface CatalogPagesDeployment {
  provider: 'gitlab' | 'github'
  updatedAt?: string
}

export interface DataCatalog extends Seedable, Authored, Lineaged {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId?: string
  workspaceId: string
  name: LocalizedString
  description: LocalizedString
  /** Badges for grouping/tagging (e.g. hospital center name). */
  badges?: import('./index').ProjectBadge[]
  dataSourceId: string
  /**
   * Portable identity of the database above, for export/import.
   *
   * `dataSourceId` is this instance's local UUID and addresses nothing anywhere
   * else, so a reimported catalog would point at a row that does not exist. This
   * pointer is what survives: it is stamped when the database is picked (not
   * derived at export time, so the server-side export carries it too) and
   * resolved back to a local id on import. Same rule as a mapping project's.
   */
  dataSourceRef?: DataSourceRef
  /** What the catalog can be broken down by, each with its own parameters. */
  variables: CatalogVariables
  /**
   * The crossings to compute: 1 to 3 variable ids each, in CATALOG_VARIABLE_ORDER.
   * Every enabled variable's 1-way marginal is computed whether listed or not.
   */
  crossings: CatalogVariableId[][]
  /** Absent = DEFAULT_CATALOG_COUNTS. */
  counts?: CatalogCounts
  anonymization: AnonymizationConfig
  status: CatalogStatus
  lastError?: string
  lastComputedAt?: string
  lastComputeDurationMs?: number
  /**
   * Work units written so far by a paused run, so a resume picks up there.
   *
   * Absent means "no run in flight": either nothing has been computed, or the
   * last one finished. An index into the run's unit plan (one unit per crossing,
   * or per concept chunk of a concept-level crossing).
   */
  computedSteps?: number
  /** Health-DCAT-AP metadata stored as a JSON-LD object. */
  dcatApMetadata?: Record<string, unknown>
  readme?: LocalizedString
  license?: EntityLicense
  /**
   * Git repository this catalog is linked to. When set, workspace export emits only a
   * metadata marker (`catalogs/<folder>/_catalog.json`) plus a git-links.json pointer;
   * the full catalog lives in the linked repo (`catalog.json`) and is restored on clone.
   */
  gitRemoteConfig?: GitRemoteConfig
  /**
   * Automatic deployment of the published page from the linked repo. When set,
   * the repo tree carries `site/` and the provider's CI file (see
   * lib/dcat-ap/pages-deployment). `updatedAt` is when the site files were last
   * regenerated, to flag a site older than the last computation.
   */
  pagesDeployment?: CatalogPagesDeployment | null
  /** Frozen provenance snapshot of the origin organization (inlined on standalone export). Not a live link. */
  organization?: OrganizationInfo
  /** User-facing semver (default '0.1.0'). Portable across export/import. */
  version?: string
  createdAt: string
  updatedAt: string
}

// --- Computed result types (cached in IDB) ---

/** Per-concept row: exact COUNT(DISTINCT) per concept (no dimensions). */
export interface CatalogConceptRow {
  conceptId: number | string
  conceptName: string
  dictionaryKey?: string
  category?: string | null
  subcategory?: string | null
  patientCount: number
  recordCount: number
  /** Absent when the catalog does not count stays. */
  visitCount?: number
}

/** Grand total from GROUPING SETS. */
export interface CatalogGrandTotal {
  totalPatients: number
  totalVisits: number
  totalRecords: number
  /** Absent when the catalog does not count unit stays. */
  totalUnitStays?: number
}

/**
 * One cell of a crossing: the modality of each of its variables (in the
 * crossing's order) and the raw counts. Only non-empty cells are stored.
 *
 * Raw, never masked: masking depends on the threshold, which the Anonymization
 * tab previews without recomputing, so it is applied where the cells are shown
 * (`lib/data-catalog/suppression.ts`).
 */
export interface CatalogCrossingRow {
  values: string[]
  patients: number
  /** Distinct visits — crossings without the concept variable, when counted. */
  stays?: number
  /** Distinct unit stays of those visits, when counted. */
  unitStays?: number
  /** Event rows — crossings with the concept variable. */
  records?: number
}

export interface CatalogCrossingResult {
  /** Variable ids joined by '-', e.g. 'period-age'. */
  id: string
  variables: CatalogVariableId[]
  rows: CatalogCrossingRow[]
}

/**
 * What the anonymisation settings mask, worked out once — on Run in the
 * Anonymization tab, or at the end of a computation — and kept with the
 * results rather than redone on every visit.
 */
export interface AnonymizationImpact {
  threshold: number
  mode: AnonymizationMode
  computedAt: string
  /** Concepts in the list, and those below the threshold. */
  concepts: { total: number; masked: number }
  crossings: {
    id: string
    variables: CatalogVariableId[]
    cells: number
    primary: number
    secondary: number
    patientMass: number
    publishedMass: number
  }[]
}

export interface CatalogResultCache {
  catalogId: string
  computedAt: string
  durationMs: number
  /** Concept table: one row per concept with exact counts. */
  concepts: CatalogConceptRow[]
  /** Grand total. */
  grandTotal: CatalogGrandTotal
  totalConcepts: number
  totalPatients: number
  totalVisits: number
  /** One long-format table per crossing, the 1-way marginals included. */
  crossings: CatalogCrossingResult[]
  /**
   * Display order of each variable's modalities: age brackets youngest first,
   * every period between the first and the last (gaps included), services by
   * patients with "Other" last.
   */
  modalities: Partial<Record<CatalogVariableId, string[]>>
  /** Display labels of modalities that are ids (concept ids → concept names). */
  labels?: Partial<Record<CatalogVariableId, Record<string, string>>>
  /** The masks of the anonymisation settings, absent until worked out. */
  anonymizationImpact?: AnonymizationImpact
  /** Units of the run's plan already added into this cache, for a resume. */
  completedSteps?: number
  /**
   * What a run in progress needs to carry on: the patient slices it counts in,
   * and the rankings the crossings are planned from (summed over the slices
   * done so far), as [modality, patients(, records)].
   */
  work?: {
    slices: { lo?: string | number; hi?: string | number }[]
    services: [string, number][]
    concepts: [string, number, number][]
  }
}
