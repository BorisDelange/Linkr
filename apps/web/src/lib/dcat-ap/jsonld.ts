/**
 * Health-DCAT-AP JSON-LD builder — Release 8.
 *
 * Turns the flat metadata of the Health-DCAT-AP tab into a `dcat:Catalog`
 * holding one `dcat:Dataset`: the warehouse. Three things are kept apart, as
 * R8 wants them (docs/health-dcat-ap.md § Describing a clinical data warehouse):
 * - what the data looks like: data model (`dct:conformsTo`), coding systems,
 *   and the tables and columns as `healthdcatap:hasVariables`;
 * - how to get it: `dcat:distribution`, for hospital data the HDAB request page;
 * - what can be learnt without it: the published catalog page and its CSVs, as
 *   `healthdcatap:analytics`.
 */

import type { SchemaMapping, CatalogResultCache, DataCatalog } from '@/types'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'
import { EHDS_LEGISLATION, normalizeDcatMetadata } from './schema'

const CONTEXT = {
  dcat: 'http://www.w3.org/ns/dcat#',
  dcatap: 'http://data.europa.eu/r5r/',
  dct: 'http://purl.org/dc/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  cv: 'http://data.europa.eu/m8g/',
  geodcatap: 'http://data.europa.eu/930/',
  csvw: 'http://www.w3.org/ns/csvw#',
  dpv: 'https://w3id.org/dpv#',
  prov: 'http://www.w3.org/ns/prov#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  healthdcatap: 'http://healthdataportal.eu/ns/health#',
}

const FILE_TYPE = 'http://publications.europa.eu/resource/authority/file-type'
const MEDIA_TYPE = 'http://www.iana.org/assignments/media-types'
const LEGISLATION = { '@id': EHDS_LEGISLATION }

/** The files a published catalog is made of — the names the Publish ZIP uses. */
export const ANALYTICS_FILES = { html: 'catalog.html', concepts: 'concepts.csv', dimensions: 'dimensions.csv' } as const

export interface BuildJsonLdOptions {
  metadata: Record<string, unknown>
  schemaMapping?: SchemaMapping | null
  cache?: CatalogResultCache | null
  catalog?: DataCatalog | null
  /** Every table of the database. When given, the variables describe all of them, not only the mapped ones. */
  fullSchema?: IntrospectedTable[] | null
}

type Node = Record<string, unknown>

export function buildJsonLd(opts: BuildJsonLdOptions): Node {
  const { schemaMapping, cache, catalog: linkrCatalog, fullSchema } = opts
  const metadata = normalizeDcatMetadata(opts.metadata)
  const str = (key: string): string | undefined => {
    const v = metadata[key]
    return v == null || v === '' ? undefined : String(v)
  }
  const list = (key: string): string[] => {
    const v = metadata[key]
    if (Array.isArray(v)) return v.filter(Boolean).map(String)
    if (typeof v === 'string') return v.split(v.includes(';') ? ';' : ',').map((s) => s.trim()).filter(Boolean)
    return []
  }
  const ids = (key: string) => list(key).map((v) => ({ '@id': v }))
  const one = <T>(xs: T[]): T | T[] => (xs.length === 1 ? xs[0] : xs)
  const set = (node: Node, prop: string, value: unknown) => {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return
    node[prop] = Array.isArray(value) ? one(value) : value
  }
  const date = (v: string | undefined) => (v ? { '@value': v.slice(0, 10), '@type': 'xsd:date' } : undefined)
  const period = (start?: string, end?: string): Node | undefined => {
    if (!start && !end) return undefined
    const p: Node = { '@type': 'dct:PeriodOfTime' }
    set(p, 'dcat:startDate', date(start))
    set(p, 'dcat:endDate', date(end))
    return p
  }
  /** A foaf:Agent with its cv:contactPoint — R8 wants exactly one on publisher, HDAB and coordinator. */
  const agent = (role: string, typeKey?: string): Node | undefined => {
    const name = str(`${role}.name`)
    if (!name) return undefined
    const a: Node = { '@type': 'foaf:Agent', 'foaf:name': name }
    if (typeKey) set(a, 'dct:type', str(typeKey) ? { '@id': str(typeKey) } : undefined)
    const email = str(`${role}.email`)
    const page = str(`${role}.contactPage`)
    if (email || page) {
      const cp: Node = { '@type': 'cv:ContactPoint' }
      set(cp, 'cv:email', email)
      set(cp, 'cv:contactPage', page ? { '@id': page } : undefined)
      a['cv:contactPoint'] = cp
    }
    return a
  }
  const count = (key: string) => {
    const v = str(key)
    return v ? { '@value': v, '@type': 'xsd:nonNegativeInteger' } : undefined
  }

  // ── Dataset ──
  const dataset: Node = { '@type': 'dcat:Dataset', 'dcatap:applicableLegislation': LEGISLATION }
  set(dataset, 'dct:title', str('dataset.title'))
  set(dataset, 'dct:description', str('dataset.description'))
  set(dataset, 'dct:identifier', str('dataset.identifier'))
  set(dataset, 'dct:type', ids('dataset.type'))
  set(dataset, 'dct:accessRights', str('dataset.accessRights') ? { '@id': str('dataset.accessRights') } : undefined)
  set(dataset, 'dcat:keyword', list('dataset.keyword'))
  set(dataset, 'dcat:theme', ids('dataset.theme'))
  set(dataset, 'dct:provenance', str('dataset.provenance')
    ? { '@type': 'dct:ProvenanceStatement', 'rdfs:label': str('dataset.provenance') }
    : undefined)
  set(dataset, 'dct:language', ids('dataset.language'))
  set(dataset, 'dct:accrualPeriodicity', str('dataset.accrualPeriodicity') ? { '@id': str('dataset.accrualPeriodicity') } : undefined)

  set(dataset, 'healthdcatap:healthCategory', ids('dataset.healthCategory'))
  set(dataset, 'healthdcatap:healthTheme', ids('dataset.healthTheme'))
  set(dataset, 'dct:conformsTo', ids('dataset.conformsTo'))
  set(dataset, 'healthdcatap:hasCodingSystem', ids('dataset.codingSystem'))
  set(dataset, 'healthdcatap:hasCodeValues', list('dataset.codeValues'))
  set(dataset, 'prov:wasGeneratedBy', list('dataset.wasGeneratedBy').map((a) => ({ '@type': 'prov:Activity', 'dct:type': { '@id': a } })))
  set(dataset, 'dpv:hasPersonalData', ids('dataset.personalData'))

  set(dataset, 'dct:temporal', period(str('dataset.temporalStart'), str('dataset.temporalEnd')))
  set(dataset, 'dct:spatial', ids('dataset.spatial'))
  set(dataset, 'healthdcatap:populationCoverage', str('dataset.populationCoverage'))
  set(dataset, 'healthdcatap:numberOfUniqueIndividuals', count('dataset.numberOfUniqueIndividuals'))
  set(dataset, 'healthdcatap:numberOfRecords', count('dataset.numberOfRecords'))
  set(dataset, 'healthdcatap:minTypicalAge', count('dataset.minTypicalAge'))
  set(dataset, 'healthdcatap:maxTypicalAge', count('dataset.maxTypicalAge'))
  set(dataset, 'healthdcatap:retentionPeriod', period(str('dataset.retentionStart'), str('dataset.retentionEnd')))

  const contactEmail = str('contact.email')
  const contactPage = str('contact.page')
  if (contactEmail || contactPage) {
    const kind: Node = { '@type': 'vcard:Kind' }
    set(kind, 'vcard:hasEmail', contactEmail ? { '@id': contactEmail.startsWith('mailto:') ? contactEmail : `mailto:${contactEmail}` } : undefined)
    set(kind, 'vcard:hasURL', contactPage ? { '@id': contactPage } : undefined)
    dataset['dcat:contactPoint'] = kind
  }
  const publisher = agent('publisher', 'publisher.type')
  set(dataset, 'dct:publisher', publisher)
  set(dataset, 'healthdcatap:hdab', agent('hdab'))
  set(dataset, 'geodcatap:custodian', agent('custodian'))
  set(dataset, 'healthdcatap:hdabCoordinator', agent('coordinator'))

  // Structure: an explicit "no" is kept; otherwise a schema to describe means yes.
  const variables = fullSchema?.length
    ? variablesFromFullSchema(fullSchema, schemaMapping)
    : schemaMapping ? variablesFromMapping(schemaMapping) : null
  const structured = metadata['dataset.hasStructuredData'] ?? (variables ? true : undefined)
  if (structured != null) {
    dataset['healthdcatap:hasStructuredData'] = { '@value': String(structured === true || structured === 'true'), '@type': 'xsd:boolean' }
  }
  if (variables && structured !== false && structured !== 'false') dataset['healthdcatap:hasVariables'] = variables

  // ── How to get the data ──
  if (str('distribution.accessURL')) {
    const distribution: Node = {
      '@type': 'dcat:Distribution',
      'dcat:accessURL': { '@id': str('distribution.accessURL') },
      'dcatap:applicableLegislation': LEGISLATION,
    }
    set(distribution, 'dct:title', str('distribution.title'))
    set(distribution, 'dct:description', str('distribution.description'))
    set(distribution, 'dct:format', str('distribution.format') ? { '@id': str('distribution.format') } : undefined)
    set(distribution, 'dct:license', str('distribution.license') ? { '@id': str('distribution.license') } : undefined)
    dataset['dcat:distribution'] = distribution
  }

  // ── What can be learnt without it ──
  set(dataset, 'healthdcatap:analytics', analyticsDistributions(cache, linkrCatalog, str('analytics.baseURL')))

  // ── Catalog ──
  const catalog: Node = {
    '@context': CONTEXT,
    '@type': 'dcat:Catalog',
    'dcatap:applicableLegislation': LEGISLATION,
  }
  set(catalog, 'dct:title', str('catalog.title'))
  set(catalog, 'dct:description', str('catalog.description'))
  set(catalog, 'dct:publisher', publisher)
  set(catalog, 'dct:language', ids('catalog.language'))
  set(catalog, 'foaf:homepage', str('catalog.homepage') ? { '@id': str('catalog.homepage') } : undefined)
  set(catalog, 'dct:issued', date(str('catalog.issued')))
  set(catalog, 'dct:modified', date(str('catalog.modified')))
  catalog['dcat:dataset'] = dataset
  return catalog
}

/**
 * The published catalog page and its two CSVs, as analytics distributions.
 *
 * Every distribution needs a `dcat:accessURL`. Without a hosting URL the file
 * names are left relative, which resolves correctly for `metadata.jsonld` read
 * next to them in the Publish ZIP.
 */
function analyticsDistributions(
  cache: CatalogResultCache | null | undefined,
  catalog: DataCatalog | null | undefined,
  baseUrl: string | undefined,
): Node[] {
  if (!cache?.concepts.length) return []
  const url = (file: string) => (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/${file}` : file)
  const threshold = catalog?.anonymization.threshold
  const suppression = threshold != null
    ? catalog?.anonymization.mode === 'suppress'
      ? ` Rows with fewer than ${threshold} patients are removed.`
      : ` Counts below ${threshold} patients are shown as "< ${threshold}".`
    : ''
  const dist = (file: string, title: string, description: string, format: string, media: string): Node => ({
    '@type': 'dcat:Distribution',
    'dct:title': title,
    'dct:description': description,
    'dcat:accessURL': { '@id': url(file) },
    ...(format === 'CSV' ? { 'dcat:downloadURL': { '@id': url(file) } } : {}),
    'dct:format': { '@id': `${FILE_TYPE}/${format}` },
    'dcat:mediaType': { '@id': `${MEDIA_TYPE}/${media}` },
    'dcatap:applicableLegislation': LEGISLATION,
  })
  const out = [
    dist(ANALYTICS_FILES.html, 'Concept catalog',
      `Browsable catalog of the clinical concepts in the warehouse, with patient, stay and record counts, demographic charts and the data schema.${suppression}`,
      'HTML', 'text/html'),
    dist(ANALYTICS_FILES.concepts, 'Concept counts',
      `One row per concept: concept_id, concept_name, vocabulary, category, subcategory, patient_count, visit_count, record_count.${suppression}`,
      'CSV', 'text/csv'),
  ]
  if (cache.dimensions.length) {
    out.push(dist(ANALYTICS_FILES.dimensions, 'Demographic breakdowns',
      `One row per dimension value (age group, sex, admission period, care site): dimension_id, dimension_type, value, patient_count, visit_count, record_count.${suppression}`,
      'CSV', 'text/csv'))
  }
  return out
}

// ---------------------------------------------------------------------------
// Variables (healthdcatap:hasVariables) — the warehouse's tables and columns
// ---------------------------------------------------------------------------

/** The mapped tables only, when the full schema could not be read. */
function variablesFromMapping(mapping: SchemaMapping): Record<string, unknown> | null {
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
      col(vt.startDateColumn, 'Start date', 'Visit start date/time', 'dateTime'),
    ]
    if (vt.endDateColumn) cols.push(col(vt.endDateColumn, 'End date', 'Visit end date/time', 'dateTime'))
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
      col(vd.startDateColumn, 'Start date', 'Sub-visit start date/time', 'dateTime'),
    ]
    if (vd.endDateColumn) cols.push(col(vd.endDateColumn, 'End date', 'Sub-visit end date/time', 'dateTime'))
    if (vd.unitColumn) cols.push(col(vd.unitColumn, 'Care site / unit', 'Care site or unit identifier', 'string'))
    tables.push(table(vd.table, `Visit detail / unit stays (${vd.table})`, cols))
  }

  // Note table
  if (mapping.noteTable) {
    const nt = mapping.noteTable
    const cols: Record<string, unknown>[] = [
      col(nt.idColumn, 'Note ID', 'Primary key', 'integer'),
      col(nt.patientIdColumn, 'Patient ID', 'Foreign key to patient', 'integer'),
      col(nt.dateColumn, 'Date', 'Note date', 'dateTime'),
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
      if (!cd.idColumn) continue
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
      if (et.dateColumn) cols.push(col(et.dateColumn, 'Date', 'Event date/time', 'dateTime'))
      if (et.valueColumn) cols.push(col(et.valueColumn, 'Numeric value', 'Measurement numeric value', 'decimal'))
      if (et.valueStringColumn) cols.push(col(et.valueStringColumn, 'String value', 'Measurement string value', 'string'))
      tables.push(table(et.table, `${label} (${et.table})`, cols))
    }
  }

  if (tables.length === 0) return null
  return tableGroup(`${localized(mapping.presetLabel, 'en') || 'Warehouse'} — mapped tables`, tables)
}

/** Every table of the database, columns annotated from the schema mapping where it knows them. */
function variablesFromFullSchema(
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

  const presetLabel = schemaMapping?.presetLabel ? localized(schemaMapping.presetLabel, 'en') : 'Warehouse'
  return tableGroup(`${presetLabel} — ${fullSchema.length} tables`, tables)
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
      if (!cd.idColumn) continue
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
  if (t.includes('TIMESTAMP') || t.includes('DATETIME')) return 'dateTime'
  if (t.includes('TIME')) return 'time'
  return 'string'
}

function col(name: string, title: string, description: string, datatype: string): Record<string, unknown> {
  return { 'csvw:name': name, 'csvw:title': title, 'dct:description': description, 'csvw:datatype': datatype }
}

function table(name: string, title: string, columns: Record<string, unknown>[]): Record<string, unknown> {
  return { '@type': 'csvw:Table', 'dct:title': title, 'csvw:url': name, 'csvw:column': columns }
}

/** R8 makes the group's `dct:title` mandatory. */
function tableGroup(title: string, tables: Record<string, unknown>[]): Record<string, unknown> {
  return { '@type': 'csvw:TableGroup', 'dct:title': title, 'csvw:table': tables }
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
