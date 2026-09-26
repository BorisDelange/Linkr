import { describe, it, expect } from 'vitest'
import type { CatalogResultCache, DataCatalog, SchemaMapping } from '@/types'
import { generateCatalogHtml } from './export-html'

const EVIL = '</script><img src=x onerror=alert(1)>'

function fixture(mode: 'replace' | 'suppress' = 'replace') {
  const catalog = {
    id: 'c1', workspaceId: 'w1', dataSourceId: 'd1',
    name: { en: `Rennes ICU ${EVIL}` }, description: { en: 'Adult ICU stays' },
    dimensions: [
      { id: 'age_group', type: 'age_group', label: 'Age group', enabled: true },
      { id: 'sex', type: 'sex', label: 'Sex', enabled: true },
      { id: 'admission_date', type: 'admission_date', label: 'Admissions', enabled: true },
      { id: 'care_site', type: 'care_site', label: 'Services', enabled: true },
    ],
    anonymization: { threshold: 10, mode },
    categoryColumn: 'domain_id',
    status: 'ready', createdAt: '', updatedAt: '',
    dcatApMetadata: { 'catalog.title': `ICU catalog ${EVIL}`, 'catalog.description': 'Demo', 'dataset.keyword': 'icu; sepsis' },
  } as unknown as DataCatalog

  const row = (label: string, n: number | null) => ({
    period_granularity: label === 'ALL' ? 'all' : 'month', period_start: '', period_label: label,
    n_patients: n, n_sejours: n, sex_m: n, sex_f: n == null ? null : Math.round(n / 2), sex_other: null,
    age_buckets: { '[0;18[': null, '[18;65[': n }, services: { ICU: { n_patients: n, n_sejours: n } },
    concept_categories: { Measurement: { n_patients: n, n_rows: n } },
  })

  const cache = {
    catalogId: 'c1', computedAt: '', durationMs: 0,
    concepts: [
      { conceptId: 1, conceptName: 'Heart rate', dictionaryKey: 'concept', category: 'Measurement', patientCount: 500, visitCount: 600, recordCount: 90000 },
      { conceptId: 2, conceptName: EVIL, dictionaryKey: 'concept', category: 'Condition', patientCount: 3, visitCount: 3, recordCount: 4 },
    ],
    dimensions: [
      { dimensionId: 'age_group', dimensionType: 'age_group', value: '18–64', patientCount: 300, visitCount: 1, recordCount: 1 },
      { dimensionId: 'age_group', dimensionType: 'age_group', value: '5–17', patientCount: 4, visitCount: 1, recordCount: 1 },
      { dimensionId: 'sex', dimensionType: 'sex', value: 'M', patientCount: 280, visitCount: 1, recordCount: 1 },
      { dimensionId: 'sex', dimensionType: 'sex', value: 'F', patientCount: 220, visitCount: 1, recordCount: 1 },
      { dimensionId: 'admission_date', dimensionType: 'admission_date', value: '2024-01', patientCount: 120, visitCount: 1, recordCount: 1 },
      { dimensionId: 'admission_date', dimensionType: 'admission_date', value: '2024-02', patientCount: 90, visitCount: 1, recordCount: 1 },
      { dimensionId: 'care_site', dimensionType: 'care_site', value: EVIL, patientCount: 200, visitCount: 1, recordCount: 1 },
    ],
    grandTotal: { totalPatients: 500, totalVisits: 640, totalRecords: 90004 },
    totalConcepts: 2, totalPatients: 500, totalVisits: 640,
    periods: [row('ALL', 500), row('Jan 2024', 120), row('Feb 2024', 90), row('Mar 2024', null)],
  } as unknown as CatalogResultCache

  const schemaMapping = {
    patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
    visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_date' },
    conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', extraColumns: { domain_id: 'domain_id' } }],
    eventTables: {
      Measurements: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', valueColumn: 'value_as_number', dateColumn: 'measurement_date' },
      Conditions: { table: 'condition_occurrence', conceptIdColumn: 'condition_concept_id', patientIdColumn: 'person_id', dateColumn: 'condition_start_date' },
    },
  } as unknown as SchemaMapping

  const fullSchema = [
    { name: 'person', columns: [{ name: 'person_id', type: 'BIGINT' }, { name: 'year_of_birth', type: 'INTEGER' }] },
    { name: 'measurement', columns: [{ name: 'measurement_concept_id', type: 'INTEGER' }, { name: 'value_as_number', type: 'DOUBLE' }] },
    { name: `weird ${EVIL}`, columns: [{ name: EVIL, type: 'VARCHAR' }] },
  ]
  return { catalog, cache, schemaMapping, fullSchema } as Parameters<typeof generateCatalogHtml>[0]
}

function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

describe('generateCatalogHtml', () => {
  const html = generateCatalogHtml(fixture())

  it('fetches nothing: no external stylesheet, script or font', () => {
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/@import|url\(http/)
  })

  it('never lets user text close a tag or the inline script', () => {
    expect(html).not.toContain('<img src=x')
    // The only </script> occurrences are the two legitimate closings.
    expect(html.match(/<\/script>/g)).toHaveLength(2)
  })

  it('embeds valid JSON-LD', () => {
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]
    expect(() => JSON.parse(ld)).not.toThrow()
  })

  it('emits a script that parses', () => {
    const [body] = scripts(html)
    expect(() => new Function(body)).not.toThrow()
  })

  it('draws the mapped tables as a diagram', () => {
    expect(html).toContain('class="erd"')
    expect(html.match(/class="edge"/g)?.length).toBe(5)
  })

  it('caps rows below the threshold in replace mode', () => {
    const concepts = JSON.parse(/var CONCEPTS = (.*);/.exec(html)![1].replace(/\\u003c/g, '<'))
    expect(concepts).toContainEqual([2, EVIL, 'Condition', 10, 10, 10, true])
  })

  it('removes rows below the threshold in suppress mode', () => {
    const suppressed = generateCatalogHtml(fixture('suppress'))
    const concepts = JSON.parse(/var CONCEPTS = (.*);/.exec(suppressed)![1])
    expect(concepts).toHaveLength(1)
    expect(suppressed).not.toContain('5–17')
  })
})
