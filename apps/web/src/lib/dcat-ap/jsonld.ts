/**
 * Health-DCAT-AP JSON-LD builder.
 *
 * Converts flat metadata (Record<string, unknown>) into a JSON-LD document
 * following the Health-DCAT-AP profile.
 */

const CONTEXT = {
  '@context': {
    dcat: 'http://www.w3.org/ns/dcat#',
    dct: 'http://purl.org/dc/terms/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    vcard: 'http://www.w3.org/2006/vcard/ns#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    healthdcatap: 'http://healthdcat-ap.eu/ns#',
  },
}

/**
 * Build a JSON-LD document from flat metadata.
 *
 * Keys follow the `class.field` convention from schema.ts
 * (e.g. `dataset.title`, `catalog.publisher`).
 */
export function buildJsonLd(metadata: Record<string, unknown>): Record<string, unknown> {
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
  if (get('agent.contactPoint')) {
    agent['dcat:contactPoint'] = {
      '@type': 'vcard:Kind',
      'vcard:fn': get('agent.contactPoint'),
    }
  }

  // Distribution
  const distribution: Record<string, unknown> = {
    '@type': 'dcat:Distribution',
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
    dataset['healthdcatap:codingSystem'] = codingSystems.map((c) => ({ '@id': c }))
  }

  // Numeric health fields
  if (get('dataset.numberOfRecords') != null && get('dataset.numberOfRecords') !== '') {
    dataset['healthdcatap:numberOfRecords'] = {
      '@value': String(get('dataset.numberOfRecords')),
      '@type': 'xsd:integer',
    }
  }
  if (get('dataset.numberOfUniqueIndividuals') != null && get('dataset.numberOfUniqueIndividuals') !== '') {
    dataset['healthdcatap:numberOfUniqueIndividuals'] = {
      '@value': String(get('dataset.numberOfUniqueIndividuals')),
      '@type': 'xsd:integer',
    }
  }
  if (get('dataset.minTypicalAge') != null && get('dataset.minTypicalAge') !== '') {
    dataset['healthdcatap:minTypicalAge'] = {
      '@value': String(get('dataset.minTypicalAge')),
      '@type': 'xsd:integer',
    }
  }
  if (get('dataset.maxTypicalAge') != null && get('dataset.maxTypicalAge') !== '') {
    dataset['healthdcatap:maxTypicalAge'] = {
      '@value': String(get('dataset.maxTypicalAge')),
      '@type': 'xsd:integer',
    }
  }

  if (get('dataset.populationCoverage')) {
    dataset['healthdcatap:populationCoverage'] = get('dataset.populationCoverage')
  }
  if (get('dataset.retentionPeriod')) {
    dataset['healthdcatap:retentionPeriod'] = get('dataset.retentionPeriod')
  }

  // Attach distribution to dataset
  const hasDistribution = Object.keys(distribution).length > 1
  if (hasDistribution) {
    dataset['dcat:distribution'] = distribution
  }

  // Catalog
  const catalog: Record<string, unknown> = {
    ...CONTEXT,
    '@type': 'dcat:Catalog',
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
