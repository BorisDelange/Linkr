import { describe, expect, it } from 'vitest'
import { buildJsonLd } from './jsonld'
import { EHDS_LEGISLATION, normalizeDcatMetadata, vocabularyIri } from './schema'
import type { CatalogResultCache, DataCatalog, SchemaMapping } from '@/types'

type Node = Record<string, unknown>
const dataset = (doc: Node) => doc['dcat:dataset'] as Node

const mapping = {
  presetLabel: { en: 'OMOP CDM 5.4' },
  patientTable: { table: 'person', idColumn: 'person_id', genderColumn: 'gender_concept_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime' },
} as unknown as SchemaMapping

const cache = {
  concepts: [{ conceptId: 1, conceptName: 'x', patientCount: 20, visitCount: 20, recordCount: 40 }],
  dimensions: [],
} as unknown as CatalogResultCache
const catalog = { anonymization: { threshold: 10, mode: 'replace' } } as unknown as DataCatalog

describe('buildJsonLd (Health-DCAT-AP R8)', () => {
  it('emits the data model, coding systems and categories as vocabulary IRIs', () => {
    const d = dataset(buildJsonLd({
      metadata: {
        'dataset.conformsTo': [vocabularyIri('standard', 'OMOP-CDM')],
        'dataset.codingSystem': [vocabularyIri('codingSystem', 'OHDSI-VOCAB'), vocabularyIri('codingSystem', 'SNOMED-CT')],
        'dataset.healthCategory': [vocabularyIri('healthCategory', 'EHRS')],
      },
    }))
    expect(d['dct:conformsTo']).toEqual({ '@id': 'https://hdeu-dcat.data.health.europa.eu/resource/authority/standard/OMOP-CDM' })
    expect(d['healthdcatap:hasCodingSystem']).toHaveLength(2)
    expect(d['healthdcatap:healthCategory']).toEqual({ '@id': 'https://hdeu-dcat.data.health.europa.eu/resource/authority/healthcategories/EHRS' })
    expect(d['dcatap:applicableLegislation']).toEqual({ '@id': EHDS_LEGISLATION })
  })

  it('hangs the schema off the dataset as hasVariables, with R8 CSVW terms', () => {
    const d = dataset(buildJsonLd({ metadata: {}, schemaMapping: mapping }))
    expect(d['healthdcatap:hasStructuredData']).toEqual({ '@value': 'true', '@type': 'xsd:boolean' })
    const group = d['healthdcatap:hasVariables'] as Node
    expect(group['dct:title']).toBeTruthy()
    const tables = group['csvw:table'] as Node[]
    const col = (tables[1]['csvw:column'] as Node[]).find((c) => c['csvw:name'] === 'visit_start_datetime')!
    expect(col['csvw:title']).toBe('Start date')
    expect(col['csvw:titles']).toBeUndefined()
    expect(col['csvw:datatype']).toBe('dateTime')
    expect(d['dcat:distribution']).toBeUndefined()
  })

  it('publishes the catalog page and CSVs as analytics, each with an access URL', () => {
    const d = dataset(buildJsonLd({ metadata: { 'analytics.baseURL': 'https://x.org/cat/' }, cache, catalog }))
    const analytics = d['healthdcatap:analytics'] as Node[]
    expect(analytics).toHaveLength(2)
    expect(analytics[0]['dcat:accessURL']).toEqual({ '@id': 'https://x.org/cat/catalog.html' })
    expect(analytics[1]['dcat:downloadURL']).toEqual({ '@id': 'https://x.org/cat/concepts.csv' })
    expect(String(analytics[1]['dct:description'])).toContain('< 10')
  })

  it('keeps temporal coverage and retention as separate periods', () => {
    const d = dataset(buildJsonLd({
      metadata: { 'dataset.temporalStart': '2010-01-01', 'dataset.temporalEnd': '2020-12-31', 'dataset.retentionEnd': '2040-01-01' },
    }))
    expect(d['dct:temporal']).toEqual({
      '@type': 'dct:PeriodOfTime',
      'dcat:startDate': { '@value': '2010-01-01', '@type': 'xsd:date' },
      'dcat:endDate': { '@value': '2020-12-31', '@type': 'xsd:date' },
    })
    expect((d['healthdcatap:retentionPeriod'] as Node)['dcat:endDate']).toEqual({ '@value': '2040-01-01', '@type': 'xsd:date' })
  })

  it('gives agents a contact point and the dataset a vcard contact', () => {
    const d = dataset(buildJsonLd({
      metadata: { 'hdab.name': 'HDH', 'hdab.email': 'a@hdh.fr', 'contact.email': 'cdw@chu.fr' },
    }))
    expect(d['healthdcatap:hdab']).toEqual({
      '@type': 'foaf:Agent', 'foaf:name': 'HDH',
      'cv:contactPoint': { '@type': 'cv:ContactPoint', 'cv:email': 'a@hdh.fr' },
    })
    expect(d['dcat:contactPoint']).toEqual({ '@type': 'vcard:Kind', 'vcard:hasEmail': { '@id': 'mailto:cdw@chu.fr' } })
  })
})

describe('normalizeDcatMetadata', () => {
  it('reads metadata saved before Release 8', () => {
    const m = normalizeDcatMetadata({
      'agent.name': 'CHU', 'agent.contactEmail': 'x@chu.fr', 'dataset.hdab': 'HDH',
      'dataset.healthCategory': ['EHR', 'IMAGING'],
      'dataset.codingSystem': ['http://snomed.info/sct'],
      'dataset.temporal': '2010-01-01 / 2020-12-31',
      'dataset.theme': 'Health data', 'dataset.personalData': 'No',
    })
    expect(m['publisher.name']).toBe('CHU')
    expect(m['publisher.email']).toBe('x@chu.fr')
    expect(m['hdab.name']).toBe('HDH')
    expect(m['dataset.healthCategory']).toEqual([vocabularyIri('healthCategory', 'EHRS')])
    expect(m['dataset.codingSystem']).toEqual([vocabularyIri('codingSystem', 'SNOMED-CT')])
    expect(m['dataset.temporalStart']).toBe('2010-01-01')
    expect(m['dataset.theme']).toEqual([vocabularyIri('dataTheme', 'HEAL')])
    expect(m['dataset.personalData']).toBeUndefined()
    expect(m['agent.name']).toBeUndefined()
  })

  it('is idempotent', () => {
    const once = normalizeDcatMetadata({ 'agent.name': 'CHU', 'dataset.healthCategory': ['EHR'] })
    expect(normalizeDcatMetadata(once)).toEqual(once)
  })
})
