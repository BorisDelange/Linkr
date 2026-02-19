/**
 * Health-DCAT-AP JSON-LD builder.
 *
 * Converts flat metadata (Record<string, unknown>) into a JSON-LD document
 * following the Health-DCAT-AP Release 6 profile.
 *
 * Spec: https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-6/
 */

import type { SchemaMapping, CatalogResultCache, DataCatalog } from '@/types'
import type { IntrospectedTable } from '@/lib/duckdb/engine'

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
  /** The full catalog config (needed for dimension labels in CSVW schemas). */
  catalog?: DataCatalog | null
  /** URL of the exported HTML concept catalog, if available. */
  conceptCatalogUrl?: string
  /** Full introspected schema (all tables from information_schema). When provided, replaces SchemaMapping-based CSVW. */
  fullSchema?: IntrospectedTable[] | null
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
  let dataCatalog: DataCatalog | null | undefined
  let conceptCatalogUrl: string | undefined
  let fullSchema: IntrospectedTable[] | null | undefined

  if ('metadata' in metadataOrOpts && typeof (metadataOrOpts as BuildJsonLdOptions).metadata === 'object') {
    const opts = metadataOrOpts as BuildJsonLdOptions
    metadata = opts.metadata
    schemaMapping = opts.schemaMapping
    cache = opts.cache
    dataCatalog = opts.catalog
    conceptCatalogUrl = opts.conceptCatalogUrl
    fullSchema = opts.fullSchema
  } else {
    metadata = metadataOrOpts as Record<string, unknown>
    cache = legacyCache
  }

  const get = (key: string) => metadata[key]

  // Helper: split semicolon-separated strings into arrays (also accepts comma for backward compat)
  const toArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.filter(Boolean).map(String)
    if (typeof val === 'string') {
      const sep = val.includes(';') ? ';' : ','
      return val.split(sep).map((s) => s.trim()).filter(Boolean)
    }
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

  // 2. CSVW data dictionary (describes source warehouse schema)
  // Prefer full introspected schema when available; fall back to SchemaMapping
  if (fullSchema && fullSchema.length > 0) {
    distributions.push(buildCsvwFromFullSchema(fullSchema, schemaMapping))
  } else if (schemaMapping) {
    const csvwDist = buildCsvwDistribution(schemaMapping)
    if (csvwDist) distributions.push(csvwDist)
  }

  // 3. HTML concept catalog distribution
  if (cache && cache.concepts.length > 0) {
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

  // 4. CSV distribution: concepts table (one row per concept with exact counts)
  if (cache && cache.concepts.length > 0) {
    const conceptCols: Record<string, unknown>[] = [
      col('concept_id', 'Concept ID', 'Unique concept identifier', 'integer'),
      col('concept_name', 'Concept name', 'Human-readable concept label', 'string'),
      col('vocabulary', 'Vocabulary', 'Source dictionary / terminology', 'string'),
      col('category', 'Category', 'Concept category (e.g. domain)', 'string'),
      col('subcategory', 'Subcategory', 'Concept subcategory (e.g. class)', 'string'),
      col('patient_count', 'Patients', 'Number of unique patients', 'nonNegativeInteger'),
      col('visit_count', 'Visits', 'Number of unique visits', 'nonNegativeInteger'),
      col('record_count', 'Records', 'Number of clinical records', 'nonNegativeInteger'),
    ]
    distributions.push({
      '@type': 'dcat:Distribution',
      'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
      'dct:format': { '@id': 'http://publications.europa.eu/resource/authority/file-type/CSV' },
      'dct:description': 'Concepts table — one row per clinical concept with exact COUNT(DISTINCT) for patients, visits, and records',
      'csvw:tableGroup': {
        '@type': 'csvw:TableGroup',
        'csvw:table': [table('concepts.csv', 'Concepts', conceptCols)],
      },
    })
  }

  // 5. CSV distribution: dimensions table (one row per dimension × value with exact counts)
  if (cache && cache.dimensions.length > 0) {
    const dimCols: Record<string, unknown>[] = [
      col('dimension_id', 'Dimension ID', 'Dimension identifier (e.g. age_group, sex)', 'string'),
      col('dimension_type', 'Dimension type', 'Type of demographic dimension', 'string'),
      col('value', 'Value', 'Dimension bucket value (e.g. "18–24", "Male")', 'string'),
      col('patient_count', 'Patients', 'Number of unique patients in this bucket', 'nonNegativeInteger'),
      col('visit_count', 'Visits', 'Number of unique visits in this bucket', 'nonNegativeInteger'),
      col('record_count', 'Records', 'Number of clinical records in this bucket', 'nonNegativeInteger'),
    ]
    distributions.push({
      '@type': 'dcat:Distribution',
      'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
      'dct:format': { '@id': 'http://publications.europa.eu/resource/authority/file-type/CSV' },
      'dct:description': 'Dimensions table — one row per demographic dimension value with exact COUNT(DISTINCT) for patients, visits, and records',
      'csvw:tableGroup': {
        '@type': 'csvw:TableGroup',
        'csvw:table': [table('dimensions.csv', 'Dimensions', dimCols)],
      },
    })
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

// ---------------------------------------------------------------------------
// Distribution 2b: CSVW from full introspected schema
// ---------------------------------------------------------------------------

/**
 * Build a CSVW Distribution from the full introspected schema (information_schema).
 * Annotates columns with semantic info from SchemaMapping where available.
 */
function buildCsvwFromFullSchema(
  fullSchema: IntrospectedTable[],
  schemaMapping?: SchemaMapping | null,
): Record<string, unknown> {
  // Build a lookup: tableName → { role, columnAnnotations }
  const annotations = buildSchemaAnnotations(schemaMapping)

  const tables: Record<string, unknown>[] = fullSchema.map((tbl) => {
    const ann = annotations.get(tbl.name)
    const tableTitle = ann?.role ? `${ann.role} (${tbl.name})` : tbl.name

    const columns: Record<string, unknown>[] = tbl.columns.map((c) => {
      const colAnn = ann?.columns.get(c.name)
      const title = colAnn?.title ?? c.name
      const desc = colAnn?.description ?? `${c.type}${c.nullable ? ', nullable' : ''}`
      const dtype = mapDuckDbType(c.type)
      return col(c.name, title, desc, dtype)
    })

    return table(tbl.name, tableTitle, columns)
  })

  const presetLabel = schemaMapping?.presetLabel ?? 'introspected'

  return {
    '@type': 'dcat:Distribution',
    'dcatap:applicableLegislation': { '@id': EHDS_LEGISLATION },
    'dct:format': { '@id': 'http://publications.europa.eu/resource/authority/file-type/CSV' },
    'dct:description': `Data dictionary — full database schema (${presetLabel}, ${fullSchema.length} tables)`,
    'csvw:tableGroup': {
      '@type': 'csvw:TableGroup',
      'csvw:table': tables,
    },
  }
}

interface ColumnAnnotation {
  title: string
  description: string
}

interface TableAnnotation {
  role: string
  columns: Map<string, ColumnAnnotation>
}

/** Extract semantic annotations from SchemaMapping for column enrichment. */
function buildSchemaAnnotations(mapping?: SchemaMapping | null): Map<string, TableAnnotation> {
  const result = new Map<string, TableAnnotation>()
  if (!mapping) return result

  const addTable = (tableName: string, role: string, cols: [string, string, string][]) => {
    const colMap = new Map<string, ColumnAnnotation>()
    for (const [name, title, description] of cols) {
      colMap.set(name, { title, description })
    }
    result.set(tableName, { role, columns: colMap })
  }

  if (mapping.patientTable) {
    const pt = mapping.patientTable
    const cols: [string, string, string][] = [
      [pt.idColumn, 'Patient ID', 'Primary key — unique patient identifier'],
    ]
    if (pt.birthDateColumn) cols.push([pt.birthDateColumn, 'Birth date', 'Date of birth'])
    if (pt.birthYearColumn) cols.push([pt.birthYearColumn, 'Birth year', 'Year of birth'])
    if (pt.genderColumn) cols.push([pt.genderColumn, 'Gender', 'Gender concept ID or value'])
    addTable(pt.table, 'Patient demographics', cols)
  }

  if (mapping.visitTable) {
    const vt = mapping.visitTable
    const cols: [string, string, string][] = [
      [vt.idColumn, 'Visit ID', 'Primary key — unique visit identifier'],
      [vt.patientIdColumn, 'Patient ID', 'Foreign key to patient'],
      [vt.startDateColumn, 'Start date', 'Visit start date/time'],
    ]
    if (vt.endDateColumn) cols.push([vt.endDateColumn, 'End date', 'Visit end date/time'])
    if (vt.typeColumn) cols.push([vt.typeColumn, 'Visit type', 'Type or source of visit'])
    addTable(vt.table, 'Visit/encounter records', cols)
  }

  if (mapping.visitDetailTable) {
    const vd = mapping.visitDetailTable
    const cols: [string, string, string][] = [
      [vd.idColumn, 'Visit detail ID', 'Primary key'],
      [vd.visitIdColumn, 'Visit ID', 'Foreign key to visit'],
      [vd.patientIdColumn, 'Patient ID', 'Foreign key to patient'],
      [vd.startDateColumn, 'Start date', 'Sub-visit start date/time'],
    ]
    if (vd.endDateColumn) cols.push([vd.endDateColumn, 'End date', 'Sub-visit end date/time'])
    if (vd.unitColumn) cols.push([vd.unitColumn, 'Care site / unit', 'Care site or unit identifier'])
    addTable(vd.table, 'Visit detail / unit stays', cols)
  }

  if (mapping.noteTable) {
    const nt = mapping.noteTable
    const cols: [string, string, string][] = [
      [nt.idColumn, 'Note ID', 'Primary key'],
      [nt.patientIdColumn, 'Patient ID', 'Foreign key to patient'],
      [nt.dateColumn, 'Date', 'Note date'],
      [nt.textColumn, 'Text', 'Clinical note text'],
    ]
    if (nt.visitIdColumn) cols.push([nt.visitIdColumn, 'Visit ID', 'Foreign key to visit'])
    if (nt.titleColumn) cols.push([nt.titleColumn, 'Title', 'Note title'])
    if (nt.typeColumn) cols.push([nt.typeColumn, 'Type', 'Note type or category'])
    addTable(nt.table, 'Clinical notes', cols)
  }

  if (mapping.conceptTables) {
    for (const cd of mapping.conceptTables) {
      const cols: [string, string, string][] = [
        [cd.idColumn, 'Concept ID', 'Primary key — concept identifier'],
        [cd.nameColumn, 'Concept name', 'Human-readable concept label'],
      ]
      if (cd.codeColumn) cols.push([cd.codeColumn, 'Concept code', 'Code within the vocabulary'])
      if (cd.vocabularyColumn) cols.push([cd.vocabularyColumn, 'Vocabulary', 'Vocabulary/terminology identifier'])
      addTable(cd.table, `Concept dictionary`, cols)
    }
  }

  if (mapping.eventTables) {
    for (const [label, et] of Object.entries(mapping.eventTables)) {
      const cols: [string, string, string][] = [
        [et.conceptIdColumn, 'Concept ID', 'Foreign key to concept dictionary'],
      ]
      if (et.sourceConceptIdColumn) cols.push([et.sourceConceptIdColumn, 'Source concept ID', 'Source concept identifier'])
      if (et.patientIdColumn) cols.push([et.patientIdColumn, 'Patient ID', 'Foreign key to patient'])
      if (et.dateColumn) cols.push([et.dateColumn, 'Date', 'Event date/time'])
      if (et.valueColumn) cols.push([et.valueColumn, 'Numeric value', 'Measurement numeric value'])
      if (et.valueStringColumn) cols.push([et.valueStringColumn, 'String value', 'Measurement string value'])
      addTable(et.table, label, cols)
    }
  }

  return result
}

/** Map DuckDB data types to CSVW datatype names. */
function mapDuckDbType(duckdbType: string): string {
  const t = duckdbType.toUpperCase()
  if (t.includes('INT')) return 'integer'
  if (t.includes('FLOAT') || t.includes('DOUBLE') || t.includes('DECIMAL') || t.includes('NUMERIC') || t.includes('REAL')) return 'decimal'
  if (t.includes('BOOL')) return 'boolean'
  if (t.includes('DATE') && !t.includes('TIME')) return 'date'
  if (t.includes('TIMESTAMP') || t.includes('DATETIME')) return 'datetime'
  if (t.includes('TIME')) return 'time'
  return 'string'
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
