import { describe, it, expect } from 'vitest'
import type { CatalogResultCache, DataCatalog, SchemaMapping } from '@/types'
import { generateCatalogHtml } from './export-html'
import { TABLE_HELPERS } from './export-html-script'

const EVIL = '</script><img src=x onerror=alert(1)>'

function fixture(mode: 'replace' | 'suppress' = 'replace') {
  const catalog = {
    id: 'c1', workspaceId: 'w1', dataSourceId: 'd1',
    name: { en: `Rennes ICU ${EVIL}` }, description: { en: 'Adult ICU stays' },
    variables: {
      age: { enabled: true, brackets: [18] },
      sex: { enabled: true },
      period: { enabled: true, granularity: 'month' },
      service: { enabled: true, level: 'visit', grouping: 'all', topN: 10, groups: {}, unassigned: 'other' },
      concept: { enabled: false, level: 'concept', categoryColumn: 'domain_id', scope: 'all', topN: 10 },
    },
    crossings: [['age', 'sex']],
    anonymization: { threshold: 10, mode },
    status: 'ready', createdAt: '', updatedAt: '',
    dcatApMetadata: { 'catalog.title': `ICU catalog ${EVIL}`, 'catalog.description': 'Demo', 'dataset.keyword': 'icu; sepsis' },
  } as unknown as DataCatalog

  const cache = {
    catalogId: 'c1', computedAt: '', durationMs: 0,
    concepts: [
      { conceptId: 1, conceptName: 'Heart rate', dictionaryKey: 'concept', category: 'Measurement', patientCount: 500, visitCount: 600, recordCount: 90000 },
      { conceptId: 2, conceptName: EVIL, dictionaryKey: 'concept', category: 'Condition', patientCount: 3, visitCount: 3, recordCount: 4 },
    ],
    crossings: [
      { id: 'period', variables: ['period'], rows: [{ values: ['2024-01'], patients: 120, stays: 130 }, { values: ['2024-02'], patients: 90, stays: 95 }] },
      { id: 'service', variables: ['service'], rows: [{ values: [EVIL], patients: 200, stays: 210 }] },
      { id: 'age', variables: ['age'], rows: [{ values: ['[0;18['], patients: 4, stays: 4 }, { values: ['[18;+∞['], patients: 496, stays: 600 }] },
      { id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 280, stays: 330 }, { values: ['female'], patients: 220, stays: 274 }] },
      { id: 'age-sex', variables: ['age', 'sex'], rows: [
        { values: ['[0;18[', 'male'], patients: 4, stays: 4444 },
        { values: ['[18;+∞[', 'male'], patients: 276, stays: 300 },
        { values: ['[18;+∞[', 'female'], patients: 220, stays: 270 },
      ] },
    ],
    modalities: { period: ['2024-01', '2024-02'], age: ['[0;18[', '[18;+∞['], sex: ['male', 'female'], service: [EVIL] },
    grandTotal: { totalPatients: 500, totalVisits: 640, totalRecords: 90004 },
    totalConcepts: 2, totalPatients: 500, totalVisits: 640,
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

  const data = (page: string) => JSON.parse(/var DATA = (.*);/.exec(page)![1].replace(/\\u003c/g, '<'))

  it('caps concepts below the threshold in replace mode', () => {
    expect(data(html).concepts.rows).toContainEqual([2, EVIL, 'Condition', 10, 10, 10, true])
  })

  it('removes concepts below the threshold in suppress mode', () => {
    expect(data(generateCatalogHtml(fixture('suppress'))).concepts.rows).toHaveLength(1)
  })

  it('inlines crossings without the numbers of masked cells', () => {
    const { crossings } = data(html)
    const ageSex = crossings.find((c: { id: string }) => c.id === 'age-sex')
    expect(ageSex.cells).toContainEqual([0, 0, null, null, 1])
    expect(html).not.toContain('4444')
  })
})

describe('page table CSV', () => {
  type Row = Record<string, unknown>
  type Col = { key: string; label: string; type: 'text' | 'number'; format?: (v: unknown, r: Row) => string }
  const { tableCsv, csvField } = new Function(`${TABLE_HELPERS}; return { tableCsv: tableCsv, csvField: csvField }`)() as {
    tableCsv: (cols: Col[], rows: Row[]) => string
    csvField: (v: unknown) => string
  }

  it('quotes per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField(' padded')).toBe('" padded"')
    expect(csvField(null)).toBe('')
  })

  it('exports masked counts as displayed and other numbers raw', () => {
    const masked = (v: unknown, r: Row) => (r._anon ? '< ' : '') + Number(v).toLocaleString('en')
    const cols: Col[] = [
      { key: 'name', label: 'Concept name', type: 'text' },
      { key: 'n', label: 'Patients', type: 'number', format: masked },
    ]
    const csv = tableCsv(cols, [
      { name: 'Heart rate, bedside', n: 90000 },
      { name: 'Rare', n: 10, _anon: true },
    ])
    expect(csv).toBe('Concept name,Patients\r\n"Heart rate, bedside",90000\r\nRare,< 10\r\n')
  })
})
