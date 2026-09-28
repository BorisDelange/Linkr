import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { describe, it, expect } from 'vitest'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { buildCatalogPageData, buildConceptsCsv, generateCatalogHtml, PAGE_READY_MESSAGE } from './export-html'
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
      // Enough records between the two rare ones (24) that their total tells no small group.
      { conceptId: 3, conceptName: 'Rare too', dictionaryKey: 'concept', category: 'Condition', patientCount: 2, visitCount: 2, recordCount: 20 },
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
    grandTotal: { totalPatients: 500, totalVisits: 640, totalRecords: 90024 },
    totalConcepts: 2, totalPatients: 500, totalVisits: 640,
  } as unknown as CatalogResultCache

  const schemaMapping = mappingV1ToV2({
    patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
    visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_date' },
    conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', extraColumns: { domain_id: 'domain_id' } }],
    eventTables: {
      Measurements: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', valueColumn: 'value_as_number', dateColumn: 'measurement_date' },
      Conditions: { table: 'condition_occurrence', conceptIdColumn: 'condition_concept_id', patientIdColumn: 'person_id', dateColumn: 'condition_start_date' },
    },
  } as unknown as SchemaMappingV1)

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
    // visit → patient, and each event table → patient, dictionary and visit.
    expect(html.match(/class="edge"/g)?.length).toBe(7)
  })

  const data = (page: string) => JSON.parse(/var DATA = (.*);/.exec(page)![1].replace(/\\u003c/g, '<'))

  it('caps concepts below the threshold in replace mode', () => {
    expect(data(html).concepts.rows).toContainEqual([2, EVIL, 'Condition', 10, 10, 10, true])
  })

  it('removes concepts below the threshold in suppress mode', () => {
    expect(data(generateCatalogHtml(fixture('suppress'))).concepts.rows).toHaveLength(1)
  })

  it('inlines no masked cell, nor how many there are: masked and empty read alike', () => {
    const { crossings } = data(html)
    const ageSex = crossings.find((c: { id: string }) => c.id === 'age-sex')
    expect(ageSex.cells.every((c: number[]) => c[c.length - 1] === 0)).toBe(true)
    expect(ageSex.masked).toBeUndefined()
    expect(html).not.toContain('4444')
  })
})

describe('the concept list against the crossings', () => {
  const conceptFixture = (mode: 'replace' | 'suppress', concepts: [number, number][], crossings: unknown[] = []) => {
    const f = fixture(mode)
    f.catalog = { ...f.catalog, variables: { ...f.catalog.variables, concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } }, crossings: [['concept', 'sex']] }
    f.cache = {
      ...f.cache,
      concepts: concepts.map(([conceptId, patientCount]) => ({ conceptId, conceptName: `C${conceptId}`, patientCount, recordCount: patientCount })),
      crossings: crossings as CatalogResultCache['crossings'],
      modalities: { concept: concepts.map(([id]) => String(id)), sex: ['male', 'female'] },
    }
    return f
  }
  // Concept 42: 60 men and 3 women, threshold 10.
  const reproduced = (mode: 'replace' | 'suppress') => conceptFixture(mode, [[42, 63], [7, 90]], [
    { id: 'concept', variables: ['concept'], rows: [{ values: ['42'], patients: 63, records: 63 }, { values: ['7'], patients: 90, records: 90 }] },
    { id: 'concept-sex', variables: ['concept', 'sex'], rows: [
      { values: ['42', 'male'], patients: 60, records: 60 }, { values: ['42', 'female'], patients: 3, records: 3 },
      { values: ['7', 'male'], patients: 50, records: 50 }, { values: ['7', 'female'], patients: 40, records: 40 },
    ] },
  ])

  it('never publishes both a concept\'s total and all but one of its cells', () => {
    for (const mode of ['replace', 'suppress'] as const) {
      const page = buildCatalogPageData(reproduced(mode))
      expect(page.concepts.rows).toContainEqual([42, 'C42', 63, 63, false])
      const cells = page.crossings.find((c) => c.id === 'concept-sex')!.cells
      // Published, 60 would give the women away: 63 − 60 = 3.
      expect(cells.some((c) => c[2] === 60)).toBe(false)
    }
  })

  it('masks in the list a concept masked to protect another, in both modes', () => {
    // One concept below the threshold: the smallest other is masked with it.
    const f = (mode: 'replace' | 'suppress') => conceptFixture(mode, [[1, 5], [2, 50], [3, 200]])
    const replaced = buildCatalogPageData(f('replace')).concepts.rows
    expect(replaced).toContainEqual([2, 'C2', 10, 10, true])
    expect(JSON.stringify(replaced)).not.toContain('50')
    expect(buildCatalogPageData(f('suppress')).concepts.rows.map((r) => r[0])).toEqual([3])

    const csv = buildConceptsCsv(f('replace').catalog, f('replace').cache).split('\n')
    expect(csv[0]).toBe('concept_id,concept_name,vocabulary,category,subcategory,patient_count,record_count,status')
    expect(csv[1]).toBe('3,C3,,,,200,200,published')
    // Capped rows tie on their capped count: no trace of their real order.
    expect(csv.slice(2)).toEqual(['1,C1,,,,,,suppressed', '2,C2,,,,,,suppressed'])
    expect(buildConceptsCsv(f('suppress').catalog, f('suppress').cache).split('\n')).toHaveLength(2)
  })
})

describe('generateCatalogHtml for the app preview', () => {
  const html = generateCatalogHtml({ ...fixture(), dataFrom: 'parent' })

  it('carries no data: the page asks its parent for it', () => {
    expect(html).toContain('var DATA = null;')
    expect(html).toContain(PAGE_READY_MESSAGE)
    expect(html).not.toContain(EVIL)
  })

  it('accepts data from the embedding window only', () => {
    expect(html).toContain('e.source !== window.parent')
  })

  it('emits a script that parses', () => {
    const [body] = scripts(html)
    expect(() => new Function(body)).not.toThrow()
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
