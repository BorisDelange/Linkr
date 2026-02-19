/**
 * Health-DCAT-AP field schema.
 *
 * Based on Health-DCAT-AP Release 6 (EHDS Regulation EU 2025/327).
 * Spec: https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-6/
 *
 * Defines mandatory, recommended, and optional fields for:
 * - Catalog (dcat:Catalog)
 * - Dataset (dcat:Dataset)
 * - Distribution (dcat:Distribution)
 * - Agent / Publisher (foaf:Agent)
 *
 * Health-specific properties follow the EHDS framework (Art. 51 categories).
 */

/** Release version this schema is based on. */
export const HEALTHDCATAP_RELEASE = '6'

/** Spec URL. */
export const HEALTHDCATAP_SPEC_URL =
  'https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-6/'

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export type DcatFieldType = 'text' | 'uri' | 'date' | 'number' | 'select' | 'multiselect' | 'localized'

export type DcatObligation = 'mandatory' | 'recommended' | 'optional'

export type DcatClass = 'catalog' | 'dataset' | 'distribution' | 'agent'

export interface DcatFieldDef {
  /** Unique key for this field (used as JSON path in metadata). */
  key: string
  /** RDF property URI. */
  uri: string
  /** DCAT-AP class this field belongs to. */
  dcatClass: DcatClass
  /** i18n key for the label. */
  labelKey: string
  /** i18n key for the description/help text. */
  descriptionKey: string
  /** Field input type. */
  type: DcatFieldType
  /** Obligation level. */
  obligation: DcatObligation
  /** For 'select'/'multiselect': key into DCAT_VOCABULARIES. */
  vocabularyKey?: string
  /** Whether this field can be auto-filled from computed catalog data. */
  autoFillable?: boolean
}

// ---------------------------------------------------------------------------
// Controlled vocabularies
// ---------------------------------------------------------------------------

export interface VocabularyOption {
  value: string
  labelKey: string
}

/** Access rights (EU vocabulary). */
const ACCESS_RIGHTS: VocabularyOption[] = [
  { value: 'http://publications.europa.eu/resource/authority/access-right/PUBLIC', labelKey: 'dcat.access_public' },
  { value: 'http://publications.europa.eu/resource/authority/access-right/RESTRICTED', labelKey: 'dcat.access_restricted' },
  { value: 'http://publications.europa.eu/resource/authority/access-right/NON_PUBLIC', labelKey: 'dcat.access_non_public' },
]

/** EHDS Art. 51 — categories of electronic health data for secondary use. */
const HEALTH_CATEGORIES: VocabularyOption[] = [
  { value: 'EHR', labelKey: 'dcat.hcat_ehr' },
  { value: 'CLAIMS', labelKey: 'dcat.hcat_claims' },
  { value: 'PHDR', labelKey: 'dcat.hcat_registry' },
  { value: 'GENOMIC', labelKey: 'dcat.hcat_genomic' },
  { value: 'COHORT', labelKey: 'dcat.hcat_cohort' },
  { value: 'CLINICAL_TRIAL', labelKey: 'dcat.hcat_clinical_trial' },
  { value: 'MEDICAL_DEVICE', labelKey: 'dcat.hcat_medical_device' },
  { value: 'SURVEY', labelKey: 'dcat.hcat_survey' },
  { value: 'BIOBANK', labelKey: 'dcat.hcat_biobank' },
  { value: 'IMAGING', labelKey: 'dcat.hcat_imaging' },
  { value: 'ADMINISTRATIVE', labelKey: 'dcat.hcat_administrative' },
]

/** Common health data coding systems. */
const CODING_SYSTEMS: VocabularyOption[] = [
  { value: 'http://snomed.info/sct', labelKey: 'dcat.cs_snomed' },
  { value: 'http://loinc.org', labelKey: 'dcat.cs_loinc' },
  { value: 'http://hl7.org/fhir/sid/icd-10', labelKey: 'dcat.cs_icd10' },
  { value: 'http://hl7.org/fhir/sid/icd-11', labelKey: 'dcat.cs_icd11' },
  { value: 'http://www.nlm.nih.gov/research/umls/rxnorm', labelKey: 'dcat.cs_rxnorm' },
  { value: 'http://www.whocc.no/atc', labelKey: 'dcat.cs_atc' },
  { value: 'https://ohdsi.org/omop', labelKey: 'dcat.cs_omop' },
]

/** All 24 EU official languages + Other. EU Publications Office Named Authority List. */
const LANGUAGES: VocabularyOption[] = [
  { value: 'http://publications.europa.eu/resource/authority/language/BUL', labelKey: 'dcat.lang_bg' },
  { value: 'http://publications.europa.eu/resource/authority/language/HRV', labelKey: 'dcat.lang_hr' },
  { value: 'http://publications.europa.eu/resource/authority/language/CES', labelKey: 'dcat.lang_cs' },
  { value: 'http://publications.europa.eu/resource/authority/language/DAN', labelKey: 'dcat.lang_da' },
  { value: 'http://publications.europa.eu/resource/authority/language/NLD', labelKey: 'dcat.lang_nl' },
  { value: 'http://publications.europa.eu/resource/authority/language/ENG', labelKey: 'dcat.lang_en' },
  { value: 'http://publications.europa.eu/resource/authority/language/EST', labelKey: 'dcat.lang_et' },
  { value: 'http://publications.europa.eu/resource/authority/language/FIN', labelKey: 'dcat.lang_fi' },
  { value: 'http://publications.europa.eu/resource/authority/language/FRA', labelKey: 'dcat.lang_fr' },
  { value: 'http://publications.europa.eu/resource/authority/language/DEU', labelKey: 'dcat.lang_de' },
  { value: 'http://publications.europa.eu/resource/authority/language/ELL', labelKey: 'dcat.lang_el' },
  { value: 'http://publications.europa.eu/resource/authority/language/HUN', labelKey: 'dcat.lang_hu' },
  { value: 'http://publications.europa.eu/resource/authority/language/GLE', labelKey: 'dcat.lang_ga' },
  { value: 'http://publications.europa.eu/resource/authority/language/ITA', labelKey: 'dcat.lang_it' },
  { value: 'http://publications.europa.eu/resource/authority/language/LAV', labelKey: 'dcat.lang_lv' },
  { value: 'http://publications.europa.eu/resource/authority/language/LIT', labelKey: 'dcat.lang_lt' },
  { value: 'http://publications.europa.eu/resource/authority/language/MLT', labelKey: 'dcat.lang_mt' },
  { value: 'http://publications.europa.eu/resource/authority/language/POL', labelKey: 'dcat.lang_pl' },
  { value: 'http://publications.europa.eu/resource/authority/language/POR', labelKey: 'dcat.lang_pt' },
  { value: 'http://publications.europa.eu/resource/authority/language/RON', labelKey: 'dcat.lang_ro' },
  { value: 'http://publications.europa.eu/resource/authority/language/SLK', labelKey: 'dcat.lang_sk' },
  { value: 'http://publications.europa.eu/resource/authority/language/SLV', labelKey: 'dcat.lang_sl' },
  { value: 'http://publications.europa.eu/resource/authority/language/SPA', labelKey: 'dcat.lang_es' },
  { value: 'http://publications.europa.eu/resource/authority/language/SWE', labelKey: 'dcat.lang_sv' },
]

/** Distribution format. */
const FORMATS: VocabularyOption[] = [
  { value: 'http://publications.europa.eu/resource/authority/file-type/CSV', labelKey: 'dcat.fmt_csv' },
  { value: 'http://publications.europa.eu/resource/authority/file-type/JSON', labelKey: 'dcat.fmt_json' },
  { value: 'http://publications.europa.eu/resource/authority/file-type/JSONLD', labelKey: 'dcat.fmt_jsonld' },
  { value: 'http://publications.europa.eu/resource/authority/file-type/HTML', labelKey: 'dcat.fmt_html' },
  { value: 'http://publications.europa.eu/resource/authority/file-type/PARQUET', labelKey: 'dcat.fmt_parquet' },
  { value: 'http://publications.europa.eu/resource/authority/file-type/RDF_TURTLE', labelKey: 'dcat.fmt_turtle' },
]

/** Frequency (EU vocabulary — subset). */
const FREQUENCIES: VocabularyOption[] = [
  { value: 'http://publications.europa.eu/resource/authority/frequency/NEVER', labelKey: 'dcat.freq_never' },
  { value: 'http://publications.europa.eu/resource/authority/frequency/ANNUAL', labelKey: 'dcat.freq_annual' },
  { value: 'http://publications.europa.eu/resource/authority/frequency/QUARTERLY', labelKey: 'dcat.freq_quarterly' },
  { value: 'http://publications.europa.eu/resource/authority/frequency/MONTHLY', labelKey: 'dcat.freq_monthly' },
  { value: 'http://publications.europa.eu/resource/authority/frequency/DAILY', labelKey: 'dcat.freq_daily' },
  { value: 'http://publications.europa.eu/resource/authority/frequency/CONT', labelKey: 'dcat.freq_continuous' },
]

export const DCAT_VOCABULARIES: Record<string, VocabularyOption[]> = {
  accessRights: ACCESS_RIGHTS,
  healthCategory: HEALTH_CATEGORIES,
  codingSystem: CODING_SYSTEMS,
  language: LANGUAGES,
  format: FORMATS,
  frequency: FREQUENCIES,
}

// ---------------------------------------------------------------------------
// Field definitions — aligned with Health-DCAT-AP Release 6
// ---------------------------------------------------------------------------

export const DCAT_FIELDS: DcatFieldDef[] = [
  // ── Catalog ──
  {
    key: 'catalog.title',
    uri: 'dct:title',
    dcatClass: 'catalog',
    labelKey: 'dcat.catalog_title',
    descriptionKey: 'dcat.catalog_title_desc',
    type: 'text',
    obligation: 'mandatory',
  },
  {
    key: 'catalog.description',
    uri: 'dct:description',
    dcatClass: 'catalog',
    labelKey: 'dcat.catalog_description',
    descriptionKey: 'dcat.catalog_description_desc',
    type: 'text',
    obligation: 'mandatory',
  },
  {
    key: 'catalog.publisher',
    uri: 'dct:publisher',
    dcatClass: 'catalog',
    labelKey: 'dcat.catalog_publisher',
    descriptionKey: 'dcat.catalog_publisher_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'catalog.language',
    uri: 'dct:language',
    dcatClass: 'catalog',
    labelKey: 'dcat.catalog_language',
    descriptionKey: 'dcat.catalog_language_desc',
    type: 'multiselect',
    obligation: 'optional',
    vocabularyKey: 'language',
  },
  {
    key: 'catalog.homepage',
    uri: 'foaf:homepage',
    dcatClass: 'catalog',
    labelKey: 'dcat.catalog_homepage',
    descriptionKey: 'dcat.catalog_homepage_desc',
    type: 'uri',
    obligation: 'optional',
  },
  {
    key: 'catalog.issued',
    uri: 'dct:issued',
    dcatClass: 'catalog',
    labelKey: 'dcat.catalog_issued',
    descriptionKey: 'dcat.catalog_issued_desc',
    type: 'date',
    obligation: 'optional',
  },

  // ── Dataset ──
  {
    key: 'dataset.title',
    uri: 'dct:title',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_title',
    descriptionKey: 'dcat.dataset_title_desc',
    type: 'text',
    obligation: 'mandatory',
  },
  {
    key: 'dataset.description',
    uri: 'dct:description',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_description',
    descriptionKey: 'dcat.dataset_description_desc',
    type: 'text',
    obligation: 'mandatory',
  },
  {
    key: 'dataset.identifier',
    uri: 'dct:identifier',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_identifier',
    descriptionKey: 'dcat.dataset_identifier_desc',
    type: 'text',
    obligation: 'mandatory',
  },
  {
    key: 'dataset.accessRights',
    uri: 'dct:accessRights',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_access_rights',
    descriptionKey: 'dcat.dataset_access_rights_desc',
    type: 'select',
    obligation: 'mandatory',
    vocabularyKey: 'accessRights',
  },
  {
    key: 'dataset.healthCategory',
    uri: 'healthdcatap:healthCategory',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_health_category',
    descriptionKey: 'dcat.dataset_health_category_desc',
    type: 'multiselect',
    obligation: 'mandatory',
    vocabularyKey: 'healthCategory',
  },
  {
    key: 'dataset.publisher',
    uri: 'dct:publisher',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_publisher',
    descriptionKey: 'dcat.dataset_publisher_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.hdab',
    uri: 'healthdcatap:hdab',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_hdab',
    descriptionKey: 'dcat.dataset_hdab_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.custodian',
    uri: 'geodcatap:custodian',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_custodian',
    descriptionKey: 'dcat.dataset_custodian_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.theme',
    uri: 'dcat:theme',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_theme',
    descriptionKey: 'dcat.dataset_theme_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.keyword',
    uri: 'dcat:keyword',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_keyword',
    descriptionKey: 'dcat.dataset_keyword_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.language',
    uri: 'dct:language',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_language',
    descriptionKey: 'dcat.dataset_language_desc',
    type: 'multiselect',
    obligation: 'optional',
    vocabularyKey: 'language',
  },
  {
    key: 'dataset.temporal',
    uri: 'dct:temporal',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_temporal',
    descriptionKey: 'dcat.dataset_temporal_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.spatial',
    uri: 'dct:spatial',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_spatial',
    descriptionKey: 'dcat.dataset_spatial_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.accrualPeriodicity',
    uri: 'dct:accrualPeriodicity',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_frequency',
    descriptionKey: 'dcat.dataset_frequency_desc',
    type: 'select',
    obligation: 'optional',
    vocabularyKey: 'frequency',
  },
  // Health-specific fields
  {
    key: 'dataset.codingSystem',
    uri: 'dct:conformsTo',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_coding_system',
    descriptionKey: 'dcat.dataset_coding_system_desc',
    type: 'multiselect',
    obligation: 'optional',
    vocabularyKey: 'codingSystem',
  },
  {
    key: 'dataset.numberOfRecords',
    uri: 'healthdcatap:numberOfRecords',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_num_records',
    descriptionKey: 'dcat.dataset_num_records_desc',
    type: 'number',
    obligation: 'optional',
    autoFillable: true,
  },
  {
    key: 'dataset.numberOfUniqueIndividuals',
    uri: 'healthdcatap:numberOfUniqueIndividuals',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_num_individuals',
    descriptionKey: 'dcat.dataset_num_individuals_desc',
    type: 'number',
    obligation: 'optional',
    autoFillable: true,
  },
  {
    key: 'dataset.minTypicalAge',
    uri: 'healthdcatap:minTypicalAge',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_min_age',
    descriptionKey: 'dcat.dataset_min_age_desc',
    type: 'number',
    obligation: 'optional',
    autoFillable: true,
  },
  {
    key: 'dataset.maxTypicalAge',
    uri: 'healthdcatap:maxTypicalAge',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_max_age',
    descriptionKey: 'dcat.dataset_max_age_desc',
    type: 'number',
    obligation: 'optional',
    autoFillable: true,
  },
  {
    key: 'dataset.populationCoverage',
    uri: 'healthdcatap:populationCoverage',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_population',
    descriptionKey: 'dcat.dataset_population_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.personalData',
    uri: 'healthdcatap:hasPersonalData',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_personal_data',
    descriptionKey: 'dcat.dataset_personal_data_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'dataset.retentionPeriod',
    uri: 'dct:temporal',
    dcatClass: 'dataset',
    labelKey: 'dcat.dataset_retention',
    descriptionKey: 'dcat.dataset_retention_desc',
    type: 'text',
    obligation: 'optional',
  },

  // ── Distribution ──
  {
    key: 'distribution.accessURL',
    uri: 'dcat:accessURL',
    dcatClass: 'distribution',
    labelKey: 'dcat.dist_access_url',
    descriptionKey: 'dcat.dist_access_url_desc',
    type: 'uri',
    obligation: 'mandatory',
  },
  {
    key: 'distribution.format',
    uri: 'dct:format',
    dcatClass: 'distribution',
    labelKey: 'dcat.dist_format',
    descriptionKey: 'dcat.dist_format_desc',
    type: 'select',
    obligation: 'optional',
    vocabularyKey: 'format',
  },
  {
    key: 'distribution.license',
    uri: 'dct:license',
    dcatClass: 'distribution',
    labelKey: 'dcat.dist_license',
    descriptionKey: 'dcat.dist_license_desc',
    type: 'uri',
    obligation: 'optional',
  },
  {
    key: 'distribution.description',
    uri: 'dct:description',
    dcatClass: 'distribution',
    labelKey: 'dcat.dist_description',
    descriptionKey: 'dcat.dist_description_desc',
    type: 'text',
    obligation: 'optional',
  },

  // ── Agent (publisher) ──
  {
    key: 'agent.name',
    uri: 'foaf:name',
    dcatClass: 'agent',
    labelKey: 'dcat.agent_name',
    descriptionKey: 'dcat.agent_name_desc',
    type: 'text',
    obligation: 'mandatory',
  },
  {
    key: 'agent.type',
    uri: 'dct:type',
    dcatClass: 'agent',
    labelKey: 'dcat.agent_type',
    descriptionKey: 'dcat.agent_type_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'agent.contactEmail',
    uri: 'cv:email',
    dcatClass: 'agent',
    labelKey: 'dcat.agent_email',
    descriptionKey: 'dcat.agent_email_desc',
    type: 'text',
    obligation: 'optional',
  },
  {
    key: 'agent.contactPage',
    uri: 'cv:contactPage',
    dcatClass: 'agent',
    labelKey: 'dcat.agent_contact_page',
    descriptionKey: 'dcat.agent_contact_page_desc',
    type: 'uri',
    obligation: 'optional',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getFieldsByClass(dcatClass: DcatClass): DcatFieldDef[] {
  return DCAT_FIELDS.filter((f) => f.dcatClass === dcatClass)
}

export function getFieldsByObligation(obligation: DcatObligation): DcatFieldDef[] {
  return DCAT_FIELDS.filter((f) => f.obligation === obligation)
}

export function getAutoFillableFields(): DcatFieldDef[] {
  return DCAT_FIELDS.filter((f) => f.autoFillable)
}
