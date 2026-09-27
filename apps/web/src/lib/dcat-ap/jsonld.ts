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

import { crossingCsvPath, crossingMeasures, publishedCrossingResults } from '@/lib/data-catalog/publish'
import { catalogCounts } from '@/lib/data-catalog/config'
import type { SchemaMapping, CatalogResultCache, DataCatalog } from '@/types'
import { mappedTableDocs } from './mapped-tables'
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
export const ANALYTICS_FILES = { html: 'catalog.html', concepts: 'concepts.csv' } as const

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
 * The published catalog page, the concept CSV and one CSV per crossing, as
 * analytics distributions.
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
  const cellSuppression = threshold != null
    ? ` Cells with fewer than ${threshold} patients, and cells that would reveal one by subtraction, have empty counts; the status column says which.`
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
      `Browsable catalog of the warehouse: patient, stay and record counts per concept and crossed by period, care unit, age group and sex, with charts and the data schema.${suppression}`,
      'HTML', 'text/html'),
    dist(ANALYTICS_FILES.concepts, 'Concept counts',
      `One row per concept: concept_id, concept_name, vocabulary, category, subcategory, patient_count, ${catalogCounts(catalog ?? {}).visits ? 'visit_count, ' : ''}record_count.${suppression}`,
      'CSV', 'text/csv'),
  ]
  for (const crossing of catalog ? publishedCrossingResults(catalog, cache) : cache.crossings ?? []) {
    out.push(dist(crossingCsvPath(crossing.id), `Counts by ${crossing.variables.join(' × ')}`,
      `One row per non-empty cell: ${[...crossing.variables, 'patients', ...crossingMeasures(catalog ?? {}, crossing.variables)].join(', ')}, status.${cellSuppression}`,
      'CSV', 'text/csv'))
  }
  return out
}

// ---------------------------------------------------------------------------
// Variables (healthdcatap:hasVariables) — the warehouse's tables and columns
// ---------------------------------------------------------------------------

/** The mapped tables only, when the full schema could not be read. */
function variablesFromMapping(mapping: SchemaMapping): Record<string, unknown> | null {
  const tables = mappedTableDocs(mapping).map((t) =>
    table(t.table, `${t.role} (${t.table})`, t.columns.map((c) => col(c.name, c.title, c.description, c.datatype))),
  )

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

  for (const t of mappedTableDocs(mapping)) {
    result.set(t.table, {
      role: t.role,
      columns: new Map(t.columns.map((c) => [c.name, { title: c.title, description: c.description }])),
    })
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
