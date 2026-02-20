// --- Catalog Status ---

export type CatalogStatus = 'draft' | 'computing' | 'ready' | 'success' | 'error'

// --- Demographic Dimensions ---

export type DimensionType = 'age_group' | 'sex' | 'admission_date' | 'care_site'

export interface AgeGroupConfig {
  /**
   * Age bracket boundaries (sorted ascending).
   * E.g. [0, 18, 25, 35, 50, 65, 80] → "0–17", "18–24", "25–34", …, "80+"
   * The last bracket is open-ended (80+).
   */
  brackets: number[]
}

/** Common age bracket presets. */
export const AGE_BRACKET_PRESETS: Record<string, number[]> = {
  '5y': [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95],
  '10y': [10, 20, 30, 40, 50, 60, 70, 80, 90],
  '20y': [20, 40, 60, 80],
  'pediatric': [1, 2, 6, 12, 18, 25, 35, 50, 65, 80],
  'clinical': [2, 18, 25, 35, 45, 55, 65, 75, 85],
}

export interface AdmissionDateConfig {
  step: 'day' | 'month' | 'year'
}

export interface CareSiteConfig {
  /** Reference to a ServiceMapping entity for renaming/grouping. */
  serviceMappingId?: string
  /** Whether to use visit_occurrence (hospital) or visit_detail (unit). */
  level: 'visit' | 'visit_detail'
}

export interface DimensionConfig {
  id: string
  type: DimensionType
  label: string
  enabled: boolean
  ageGroup?: AgeGroupConfig
  admissionDate?: AdmissionDateConfig
  careSite?: CareSiteConfig
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

// --- Period Configuration ---

export interface PeriodConfig {
  /** Time granularity for the period table. Minimum is 'month' (no 'day'). */
  granularity: 'month' | 'quarter' | 'year'
  /** Whether to use visit_occurrence.typeColumn or visitDetailTable.unitColumn as service. */
  serviceLevel: 'visit' | 'visit_detail'
  /**
   * Subset of service labels to include. If undefined or empty, all services are included.
   */
  serviceLabels?: string[]
  /**
   * Values of categoryColumn to include as columns in the period table.
   * E.g. ['Measurement', 'Condition', 'Drug'] for OMOP domain_id.
   * Empty or undefined = no concept category columns.
   */
  conceptCategories?: string[]
}

// --- Period Result Row ---

/**
 * One row of the period table.
 * null values = masked (patient count below anonymization threshold).
 */
export interface CatalogPeriodRow {
  period_granularity: 'month' | 'quarter' | 'year' | 'all'
  /** ISO date '2025-01-01' (first day of the period), or '' for ALL. */
  period_start: string
  /** Human-readable label: 'Jan 2025', 'Q1 2025', '2025', or 'ALL'. */
  period_label: string

  n_patients: number | null
  n_sejours: number | null

  sex_m: number | null
  sex_f: number | null
  sex_other: number | null

  /** Age bucket counts keyed by bracket label, e.g. '[0;18[' → 45 or null. */
  age_buckets: Record<string, number | null>

  /** Per-service counts keyed by service label. */
  services: Record<string, { n_patients: number | null; n_sejours: number | null }>

  /** Per-concept-category counts keyed by category value. */
  concept_categories: Record<string, { n_patients: number | null; n_rows: number | null }>
}

// --- Data Catalog ---

export interface DataCatalog {
  id: string
  workspaceId: string
  name: string
  description: string
  dataSourceId: string
  dimensions: DimensionConfig[]
  anonymization: AnonymizationConfig
  /**
   * Key from ConceptDictionary.extraColumns to use as the concept category column.
   * E.g. 'domain_id' for OMOP, 'category' for MIMIC.
   */
  categoryColumn?: string
  /**
   * Key from ConceptDictionary.extraColumns to use as the concept subcategory column.
   * E.g. 'concept_class_id' for OMOP.
   */
  subcategoryColumn?: string
  /** Optional period table configuration. */
  periodConfig?: PeriodConfig
  status: CatalogStatus
  lastError?: string
  lastComputedAt?: string
  lastComputeDurationMs?: number
  /** Health-DCAT-AP metadata stored as a JSON-LD object. */
  dcatApMetadata?: Record<string, unknown>
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
  visitCount: number
}

/** Per-dimension-value row: exact COUNT(DISTINCT) per dimension bucket (no concepts). */
export interface CatalogDimensionRow {
  dimensionId: string
  dimensionType: DimensionType
  value: string | number
  patientCount: number
  recordCount: number
  visitCount: number
}

/** Grand total from GROUPING SETS. */
export interface CatalogGrandTotal {
  totalPatients: number
  totalVisits: number
  totalRecords: number
}

export interface CatalogResultCache {
  catalogId: string
  computedAt: string
  durationMs: number
  /** Concept table: one row per concept with exact counts. */
  concepts: CatalogConceptRow[]
  /** Dimension table: one row per (dimension, value) with exact counts. */
  dimensions: CatalogDimensionRow[]
  /** Grand total. */
  grandTotal: CatalogGrandTotal
  totalConcepts: number
  totalPatients: number
  totalVisits: number
  /**
   * Period table: one row per time period (+ one ALL row).
   * Only present when catalog.periodConfig is set.
   */
  periods?: CatalogPeriodRow[]
  /**
   * Period reliability score: fraction of n_patients cells that are masked (null).
   * 0 = no masking, 1 = all masked. Only present when periods is set.
   */
  periodReliabilityScore?: number
}

// --- Default dimension presets ---

export function getDefaultDimensions(): DimensionConfig[] {
  return [
    {
      id: 'age_group',
      type: 'age_group',
      label: 'Age group',
      enabled: true,
      ageGroup: { brackets: [10, 20, 30, 40, 50, 60, 70, 80, 90] },
    },
    {
      id: 'sex',
      type: 'sex',
      label: 'Sex',
      enabled: true,
    },
    {
      id: 'admission_date',
      type: 'admission_date',
      label: 'Admission date',
      enabled: false,
      admissionDate: { step: 'month' },
    },
    {
      id: 'care_site',
      type: 'care_site',
      label: 'Care site',
      enabled: false,
      careSite: { level: 'visit_detail' },
    },
  ]
}
