/**
 * Health-DCAT-AP JSON-LD builder.
 *
 * Converts flat metadata (Record<string, unknown>) into a JSON-LD document
 * following the Health-DCAT-AP Release 6 profile.
 *
 * Spec: https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-6/
 */

import type { SchemaMapping } from '@/types'
import type { CatalogResultCache } from '@/types'

/** EHDS Regulation reference — mandatory on Catalog, Dataset, Distribution. */
const EHDS_LEGISLATION = 'http://data.europa.eu/eli/reg/2025/327'

const CONTEXT = {
  '@context': {
    dcat: 'http://www.w3.org/ns/dcat#',
    dcatap: 'http://data.europa.eu/r5r/',
    dct: 'http://purl.org/dc/terms/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    cv: 'http://data.europa.eu/m8g/',
    geodcatap: 'http://data.europa.eu/930/',
    csvw: 'http://www.w3.org/ns/csvw#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    healthdcatap: 'http://healthdataportal.eu/ns/health#',
  },
}

export interface BuildJsonLdOptions {
  metadata: Record<string, unknown>
  schemaMapping?: SchemaMapping | null
  cache?: CatalogResultCache | null
  /** URL of the exported HTML concept catalog, if available. */
  conceptCatalogUrl?: string
}

/**
 * Build a JSON-LD document from flat metadata.
 *
 * Keys follow the `class.field` convention from schema.ts
 * (e.g. `dataset.title`, `catalog.publisher`).
 *
 * Generates two auto-distributions:
 * 1. CSVW data dictionary from SchemaMapping (describes the source warehouse schema)
 * 2. HTML concept catalog (if cache and URL are provided)
 */
export function buildJsonLd(opts: BuildJsonLdOptions): Record<string, unknown>
/**
 * Legacy overload for backward compatibility.
 */
export function buildJsonLd(
  metadata: Record<string, unknown>,
  cache?: CatalogResultCache | null,
): Record<string, unknown>
export function buildJsonLd(
  metadataOrOpts: Record<string, unknown> | BuildJsonLdOptions,
  legacyCache?: CatalogResultCache | null,
): Record<string, unknown> {
  // Resolve overloads
  let metadata: Record<string, unknown>
  let schemaMapping: SchemaMapping | null | undefined
  let cache: CatalogResultCache | null | undefined
  let conceptCatalogUrl: string | undefined

  if ('metadata' in metadataOrOpts && typeof (metadataOrOpts as BuildJsonLdOptions).metadata === 'object') {
    const opts = metadataOrOpts as BuildJsonLdOptions
    metadata = opts.metadata
    schemaMapping = opts.schemaMapping
    cache = opts.cache
    conceptCatalogUrl = opts.conceptCatalogUrl
  } else {
    metadata = metadataOrOpts as Record<string, unknown>
    cache = legacyCache
  }

  const get = (key: string) => metadata[key]

  // Helper: split comma-separated strings into arrays
  const toArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.filter(Boolean).map(String)
    if (typeof val === 'string') return val.split(',').map((s) => s.trim()).filter(Boolean)
    return []
  }

  // Publisher / Agent
  const agent: Record<string, unknown> = {
    '@type': 'foaf:Agent',
  }
  if (get('agent.name')) agent['foaf:name'] = get('agent.name')
  if (get('agent.type')) agent['dct:type'] = get('agent.type')
  if (get('agent.contactEmail') || get('agent.contactPage')) {
    const cp: Record<string, unknown> = { '@type': 'cv:ContactPoint' }
    if (get('agent.contactEmail')) cp['cv:email'] = get('agent.contactEmail')
    if (get('agent.contactPage')) cp['cv:contactPage'] = { '@id': get('agent.contactPage') }
    agent['cv:contactPoint'] = cp
  }

  // User-defined distribution
  const distribution: Record<string, unknown> = {
    '@type': 'dcat:Distribution',
    'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
  }
  if (get('distribution.accessURL')) {
    distribution['dcat:accessURL'] = { '@id': get('distribution.accessURL') }
  }
  if (get('distribution.format')) {
    distribution['dct:format'] = { '@id': get('distribution.format') }
  }
  if (get('distribution.license')) {
    distribution['dct:license'] = { '@id': get('distribution.license') }
  }
  if (get('distribution.description')) {
    distribution['dct:description'] = get('distribution.description')
  }

  // Dataset
  const dataset: Record<string, unknown> = {
    '@type': 'dcat:Dataset',
    'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
  }
  if (get('dataset.title')) dataset['dct:title'] = get('dataset.title')
  if (get('dataset.description')) dataset['dct:description'] = get('dataset.description')
  if (get('dataset.identifier')) dataset['dct:identifier'] = get('dataset.identifier')
  if (get('dataset.accessRights')) {
    dataset['dct:accessRights'] = { '@id': get('dataset.accessRights') }
  }
  if (get('dataset.publisher')) {
    dataset['dct:publisher'] = { '@type': 'foaf:Agent', 'foaf:name': get('dataset.publisher') }
  }
  if (get('dataset.hdab')) {
    dataset['healthdcatap:hdab'] = { '@type': 'foaf:Agent', 'foaf:name': get('dataset.hdab') }
  }
  if (get('dataset.custodian')) {
    dataset['geodcatap:custodian'] = { '@type': 'foaf:Agent', 'foaf:name': get('dataset.custodian') }
  }

  // Health categories
  const healthCats = toArray(get('dataset.healthCategory'))
  if (healthCats.length > 0) {
    dataset['healthdcatap:healthCategory'] = healthCats
  }

  // Keywords
  const keywords = toArray(get('dataset.keyword'))
  if (keywords.length > 0) dataset['dcat:keyword'] = keywords

  // Languages
  const langs = toArray(get('dataset.language'))
  if (langs.length > 0) {
    dataset['dct:language'] = langs.map((l) => ({ '@id': l }))
  }

  if (get('dataset.theme')) dataset['dcat:theme'] = get('dataset.theme')
  if (get('dataset.temporal')) dataset['dct:temporal'] = get('dataset.temporal')
  if (get('dataset.spatial')) dataset['dct:spatial'] = get('dataset.spatial')
  if (get('dataset.accrualPeriodicity')) {
    dataset['dct:accrualPeriodicity'] = { '@id': get('dataset.accrualPeriodicity') }
  }

  // Coding systems
  const codingSystems = toArray(get('dataset.codingSystem'))
  if (codingSystems.length > 0) {
    dataset['dct:conformsTo'] = codingSystems.map((c) => ({ '@id': c }))
  }

  // Numeric health fields
  const numField = (key: string, prop: string) => {
    if (get(key) != null && get(key) !== '') {
      dataset[prop] = {
        '@value': String(get(key)),
        '@type': 'xsd:nonNegativeInteger',
      }
    }
  }
  numField('dataset.numberOfRecords', 'healthdcatap:numberOfRecords')
  numField('dataset.numberOfUniqueIndividuals', 'healthdcatap:numberOfUniqueIndividuals')
  numField('dataset.minTypicalAge', 'healthdcatap:minTypicalAge')
  numField('dataset.maxTypicalAge', 'healthdcatap:maxTypicalAge')

  if (get('dataset.populationCoverage')) {
    dataset['healthdcatap:populationCoverage'] = get('dataset.populationCoverage')
  }
  if (get('dataset.personalData')) {
    dataset['healthdcatap:hasPersonalData'] = get('dataset.personalData')
  }
  if (get('dataset.retentionPeriod')) {
    dataset['dct:temporal'] = get('dataset.retentionPeriod')
  }

  // Build distributions array
  const distributions: Record<string, unknown>[] = []

  // 1. User-defined distribution (access URL, format, license...)
  const hasUserDistribution = get('distribution.accessURL') || get('distribution.format') ||
    get('distribution.license') || get('distribution.description')
  if (hasUserDistribution) {
    distributions.push(distribution)
  }

  // 2. CSVW data dictionary from SchemaMapping (describes source warehouse schema)
  if (schemaMapping) {
    const csvwDist = buildCsvwDistribution(schemaMapping)
    if (csvwDist) distributions.push(csvwDist)
  }

  // 3. HTML concept catalog distribution
  if (cache && cache.rows.length > 0) {
    const htmlDist: Record<string, unknown> = {
      '@type': 'dcat:Distribution',
      'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
      'dct:format': { '@id': 'http://publications.europa.eu/resource/authority/file-type/HTML' },
      'dct:description': 'Concept catalog — browsable list of clinical concepts with counts and demographic breakdowns',
    }
    if (conceptCatalogUrl) {
      htmlDist['dcat:accessURL'] = { '@id': conceptCatalogUrl }
    }
    distributions.push(htmlDist)
  }

  if (distributions.length === 1) {
    dataset['dcat:distribution'] = distributions[0]
  } else if (distributions.length > 1) {
    dataset['dcat:distribution'] = distributions
  }

  // Catalog
  const catalog: Record<string, unknown> = {
    ...CONTEXT,
    '@type': 'dcat:Catalog',
    'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
  }
  if (get('catalog.title')) catalog['dct:title'] = get('catalog.title')
  if (get('catalog.description')) catalog['dct:description'] = get('catalog.description')
  if (get('catalog.publisher')) {
    catalog['dct:publisher'] = agent['foaf:name'] ? agent : { '@type': 'foaf:Agent', 'foaf:name': get('catalog.publisher') }
  }
  const catLangs = toArray(get('catalog.language'))
  if (catLangs.length > 0) {
    catalog['dct:language'] = catLangs.map((l) => ({ '@id': l }))
  }
  if (get('catalog.homepage')) {
    catalog['foaf:homepage'] = { '@id': get('catalog.homepage') }
  }
  if (get('catalog.issued')) {
    catalog['dct:issued'] = {
      '@value': get('catalog.issued'),
      '@type': 'xsd:date',
    }
  }

  // Attach dataset to catalog
  catalog['dcat:dataset'] = dataset

  return catalog
}

// ---------------------------------------------------------------------------
// Distribution 1: CSVW data dictionary from SchemaMapping
// ---------------------------------------------------------------------------

/**
 * Build a CSVW Distribution describing the warehouse schema tables and columns.
 * Uses the SchemaMapping definition (patient table, visit table, event tables, etc.)
 * to produce a CSVW TableGroup with one Table per schema table and Column per column.
 */
function buildCsvwDistribution(mapping: SchemaMapping): Record<string, unknown> | null {
  const tables: Record<string, unknown>[] = []

  // Patient table
  if (mapping.patientTable) {
    const pt = mapping.patientTable
    const cols: Record<string, unknown>[] = [
      col(pt.idColumn, 'Patient ID', 'Primary key — unique patient identifier', 'integer'),
    ]
    if (pt.birthDateColumn) cols.push(col(pt.birthDateColumn, 'Birth date', 'Date of birth', 'date'))
    if (pt.birthYearColumn) cols.push(col(pt.birthYearColumn, 'Birth year', 'Year of birth', 'integer'))
    if (pt.genderColumn) cols.push(col(pt.genderColumn, 'Gender', 'Gender concept ID or value', 'string'))
    tables.push(table(pt.table, `Patient demographics (${pt.table})`, cols))
  }

  // Visit table
  if (mapping.visitTable) {
    const vt = mapping.visitTable
    const cols: Record<string, unknown>[] = [
      col(vt.idColumn, 'Visit ID', 'Primary key — unique visit identifier', 'integer'),
      col(vt.patientIdColumn, 'Patient ID', 'Foreign key to patient', 'integer'),
      col(vt.startDateColumn, 'Start date', 'Visit start date/time', 'datetime'),
    ]
    if (vt.endDateColumn) cols.push(col(vt.endDateColumn, 'End date', 'Visit end date/time', 'datetime'))
    if (vt.typeColumn) cols.push(col(vt.typeColumn, 'Visit type', 'Type or source of visit', 'string'))
    tables.push(table(vt.table, `Visit/encounter records (${vt.table})`, cols))
  }

  // Visit detail table
  if (mapping.visitDetailTable) {
    const vd = mapping.visitDetailTable
    const cols: Record<string, unknown>[] = [
      col(vd.idColumn, 'Visit detail ID', 'Primary key', 'integer'),
      col(vd.visitIdColumn, 'Visit ID', 'Foreign key to visit', 'integer'),
      col(vd.patientIdColumn, 'Patient ID', 'Foreign key to patient', 'integer'),
      col(vd.startDateColumn, 'Start date', 'Sub-visit start date/time', 'datetime'),
    ]
    if (vd.endDateColumn) cols.push(col(vd.endDateColumn, 'End date', 'Sub-visit end date/time', 'datetime'))
    if (vd.unitColumn) cols.push(col(vd.unitColumn, 'Care site / unit', 'Care site or unit identifier', 'string'))
    tables.push(table(vd.table, `Visit detail / unit stays (${vd.table})`, cols))
  }

  // Note table
  if (mapping.noteTable) {
    const nt = mapping.noteTable
    const cols: Record<string, unknown>[] = [
      col(nt.idColumn, 'Note ID', 'Primary key', 'integer'),
      col(nt.patientIdColumn, 'Patient ID', 'Foreign key to patient', 'integer'),
      col(nt.dateColumn, 'Date', 'Note date', 'datetime'),
      col(nt.textColumn, 'Text', 'Clinical note text', 'string'),
    ]
    if (nt.visitIdColumn) cols.push(col(nt.visitIdColumn, 'Visit ID', 'Foreign key to visit', 'integer'))
    if (nt.titleColumn) cols.push(col(nt.titleColumn, 'Title', 'Note title', 'string'))
    if (nt.typeColumn) cols.push(col(nt.typeColumn, 'Type', 'Note type or category', 'string'))
    tables.push(table(nt.table, `Clinical notes (${nt.table})`, cols))
  }

  // Concept dictionary tables
  if (mapping.conceptTables) {
    for (const cd of mapping.conceptTables) {
      const cols: Record<string, unknown>[] = [
        col(cd.idColumn, 'Concept ID', 'Primary key — concept identifier', 'integer'),
        col(cd.nameColumn, 'Concept name', 'Human-readable concept label', 'string'),
      ]
      if (cd.codeColumn) cols.push(col(cd.codeColumn, 'Concept code', 'Code within the vocabulary', 'string'))
      if (cd.vocabularyColumn) cols.push(col(cd.vocabularyColumn, 'Vocabulary', 'Vocabulary/terminology identifier', 'string'))
      if (cd.extraColumns) {
        for (const [semantic, actual] of Object.entries(cd.extraColumns)) {
          cols.push(col(actual, titleCase(semantic), `Concept ${semantic}`, 'string'))
        }
      }
      tables.push(table(cd.table, `Concept dictionary (${cd.table})`, cols))
    }
  }

  // Event tables (clinical data)
  if (mapping.eventTables) {
    for (const [label, et] of Object.entries(mapping.eventTables)) {
      const cols: Record<string, unknown>[] = [
        col(et.conceptIdColumn, 'Concept ID', 'Foreign key to concept dictionary', 'integer'),
      ]
      if (et.sourceConceptIdColumn) {
        cols.push(col(et.sourceConceptIdColumn, 'Source concept ID', 'Source concept identifier', 'integer'))
      }
      if (et.patientIdColumn) cols.push(col(et.patientIdColumn, 'Patient ID', 'Foreign key to patient', 'integer'))
      if (et.dateColumn) cols.push(col(et.dateColumn, 'Date', 'Event date/time', 'datetime'))
      if (et.valueColumn) cols.push(col(et.valueColumn, 'Numeric value', 'Measurement numeric value', 'decimal'))
      if (et.valueStringColumn) cols.push(col(et.valueStringColumn, 'String value', 'Measurement string value', 'string'))
      tables.push(table(et.table, `${label} (${et.table})`, cols))
    }
  }

  if (tables.length === 0) return null

  return {
    '@type': 'dcat:Distribution',
    'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
    'dct:format': { '@id': 'http://publications.europa.eu/resource/authority/file-type/CSV' },
    'dct:description': `Data dictionary — schema structure (${mapping.presetLabel})`,
    'csvw:tableGroup': {
      '@type': 'csvw:TableGroup',
      'csvw:table': tables,
    },
  }
}

function col(name: string, title: string, description: string, datatype: string): Record<string, unknown> {
  return { 'csvw:name': name, 'csvw:titles': title, 'dct:description': description, 'csvw:datatype': datatype }
}

function table(name: string, title: string, columns: Record<string, unknown>[]): Record<string, unknown> {
  return { '@type': 'csvw:Table', 'dct:title': title, 'csvw:url': name, 'csvw:column': columns }
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
