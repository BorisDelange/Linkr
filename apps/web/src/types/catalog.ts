// --- Catalog Status ---

export type CatalogStatus = 'draft' | 'computing' | 'ready' | 'error'

// --- Demographic Dimensions ---

export type DimensionType = 'age_group' | 'sex' | 'admission_date' | 'care_site'

export interface AgeGroupConfig {
  step: 1 | 5 | 10
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

export interface AnonymizationConfig {
  /** Minimum patient count per row. Rows below this are suppressed on export. */
  threshold: number
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
  status: CatalogStatus
  lastComputedAt?: string
  lastComputeDurationMs?: number
  /** Health-DCAT-AP metadata stored as a JSON-LD object. */
  dcatApMetadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

// --- Computed result row (cached in IDB) ---

export interface CatalogResultRow {
  conceptId: number | string
  conceptName: string
  dictionaryKey?: string
  category?: string | null
  subcategory?: string | null
  patientCount: number
  recordCount: number
  /** Dynamic dimension columns: key = dimension id, value = dimension value. */
  dimensions: Record<string, string | number | null>
}

export interface CatalogResultCache {
  catalogId: string
  computedAt: string
  durationMs: number
  rows: CatalogResultRow[]
  totalConcepts: number
  totalPatients: number
}

// --- Default dimension presets ---

export function getDefaultDimensions(): DimensionConfig[] {
  return [
    {
      id: 'age_group',
      type: 'age_group',
      label: 'Age group',
      enabled: true,
      ageGroup: { step: 10 },
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
