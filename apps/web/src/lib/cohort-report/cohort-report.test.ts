import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { Cohort, SchemaMapping } from '@/types'
import { columnChart, donut, flowchart, horizontalBars, niceScale, verticalBars } from './charts'
import { describeCriteria } from './describe'
import { buildCohortReportModel, CohortReportUnavailable, fillMonths } from './model'
import { buildAgeSql, buildCareUnitSql, buildConceptSql, buildIndexSql, buildVisitCountSql } from './queries'
import { renderReportHtml } from './render-html'
import { suppress, suppressedShare } from './suppress'
import { tokenizeSql } from './sql-highlight'

// A key-echoing t: the text shows which key and values a sentence was built from.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}(${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')})` : key) as unknown as TFunction

const mapping: SchemaMapping = {
  presetId: 'omop', presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id', birthDateColumn: 'birth_datetime', genderColumn: 'gender_concept_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime' },
  visitDetailTable: {
    table: 'visit_detail', idColumn: 'visit_detail_id', visitIdColumn: 'visit_occurrence_id', patientIdColumn: 'person_id',
    startDateColumn: 'visit_detail_start_datetime', unitSourceValueColumn: 'visit_detail_source_value',
  },
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', sourceConceptIdColumn: 'measurement_source_concept_id', patientIdColumn: 'person_id' },
  },
  genderValues: { male: '8507', female: '8532' },
} as SchemaMapping

const criteriaTree = {
  kind: 'group', id: 'root', operator: 'AND', exclude: false, enabled: true,
  children: [
    { kind: 'criterion', id: 'a', type: 'age', operator: 'AND', exclude: false, enabled: true, config: { ageReference: 'admission', min: 18 } },
    { kind: 'criterion', id: 'b', type: 'concept', operator: 'AND', exclude: false, enabled: true,
      config: { eventTableLabel: 'Measurement', conceptIds: [3027018], conceptNames: { 3027018: 'Heart rate' } } },
    { kind: 'criterion', id: 'c', type: 'sex', operator: 'OR', exclude: true, enabled: true, config: { values: ['8507'] } },
    { kind: 'criterion', id: 'd', type: 'age', operator: 'AND', exclude: false, enabled: false, config: { ageReference: 'current', max: 90 } },
  ],
} as Cohort['criteriaTree']

const cohort = (over: Partial<Cohort> = {}): Cohort => ({
  id: 'c1', ownerDataSourceId: 'db', name: { en: 'ICU <adults>' }, description: { en: 'Feasibility' },
  level: 'visit_detail', criteriaTree, version: '0.2.0', ...over,
} as Cohort)

describe('suppress', () => {
  it('hides 1..threshold-1, keeps zero and the threshold itself', () => {
    expect(suppress(0, 11, 'en')).toEqual({ value: 0, label: '0' })
    expect(suppress(3, 11, 'en')).toEqual({ value: null, label: '<11' })
    expect(suppress(10, 11, 'en').value).toBeNull()
    expect(suppress(11, 11, 'en')).toEqual({ value: 11, label: '11' })
    expect(suppress(12345, 11, 'fr').label).toBe((12345).toLocaleString('fr'))
  })

  it('withholds a share of a hidden count, which would give it back', () => {
    expect(suppressedShare(suppress(5, 11, 'en'), suppress(100, 11, 'en'), 'en')).toBeNull()
    expect(suppressedShare(suppress(25, 11, 'en'), suppress(100, 11, 'en'), 'en')).toBe('25')
  })
})

describe('fillMonths', () => {
  it('fills the gaps between the first and the last month, across a year end', () => {
    expect(fillMonths([{ month: '2024-11', n: 3 }, { month: '2025-02', n: 1 }])).toEqual([
      { month: '2024-11', n: 3 }, { month: '2024-12', n: 0 }, { month: '2025-01', n: 0 }, { month: '2025-02', n: 1 },
    ])
    expect(fillMonths([{ month: 'null', n: 2 }])).toEqual([])
  })
})

describe('describeCriteria', () => {
  it('spells out enabled criteria in order, with operators, negation and units', () => {
    const out = describeCriteria(criteriaTree, t, mapping)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ depth: 0, text: 'cohort_report.crit_age_admission(range=cohort_report.crit_range_min(min=18,unit=cohort_report.crit_unit_years))' })
    expect(out[1].text).toBe('cohort_report.crit_concept(table=Measurement,concepts=Heart rate (3027018))')
    expect(out[2].operator).toBe('OR')
    // The gender concept id is named through the mapping, never shown raw.
    expect(out[2].text).toBe('cohort_report.crit_not(text=cohort_report.crit_sex(values=cohort_report.crit_sex_male))')
  })
})

describe('queries', () => {
  const m = 'SELECT 1 AS id, 1 AS patient_id'

  it('dates each member from its own level', () => {
    expect(buildIndexSql(m, 'visit_detail', mapping)).toContain('JOIN "visit_detail" vd ON vd."visit_detail_id" = m.id')
    expect(buildIndexSql(m, 'patient', mapping)).toContain('MIN(v."visit_start_datetime")')
  })

  it('counts the parent stays of unit stays, and nothing at visit level', () => {
    expect(buildVisitCountSql(m, 'visit_detail', mapping)).toContain('COUNT(DISTINCT vd."visit_occurrence_id")')
    expect(buildVisitCountSql(m, 'visit', mapping)).toBeNull()
  })

  it('matches concepts on either column, as the criterion does', () => {
    const sql = buildConceptSql(m, mapping, { eventTableLabel: 'Measurement', conceptIds: [1, 2], conceptNames: {} })!
    expect(sql).toContain('(e."measurement_concept_id" IN (1, 2) OR e."measurement_source_concept_id" IN (1, 2))')
    expect(buildConceptSql(m, mapping, { eventTableLabel: 'Nope', conceptIds: [1], conceptNames: {} })).toBeNull()
  })

  it('needs a birth column for ages and a unit column for care units', () => {
    const idx = buildIndexSql(m, 'visit', mapping)!
    expect(buildAgeSql(idx, { ...mapping, patientTable: { table: 'person', idColumn: 'person_id' } })).toBeNull()
    expect(buildCareUnitSql(m, 'visit', mapping)).toContain('vd."visit_occurrence_id" IN')
    expect(buildCareUnitSql(m, 'visit', { ...mapping, visitDetailTable: undefined })).toBeNull()
  })
})

describe('charts', () => {
  it('draws no bar for a suppressed count but keeps its label', () => {
    const svg = verticalBars([
      { label: '2024-01', count: { value: 40, label: '40' } },
      { label: '2024-02', count: { value: null, label: '<11' } },
    ], { title: 'Months' })
    expect(svg.match(/<rect /g)).toHaveLength(1)
    expect(svg).toContain('2024-02')
    expect(horizontalBars([{ label: 'A & B', count: { value: 3, label: '3' } }], { title: 'x' })).toContain('A &amp; B')
    expect(flowchart([{ label: 'All', counts: '10' }, { label: 'Adults', counts: '8' }], { title: 'f' }).match(/<rect /g)).toHaveLength(2)
  })
})

describe('buildCohortReportModel', () => {
  // Answers each query by what it asks for, so the test does not depend on order.
  const run = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (sql.includes('AS units') && sql.startsWith('SELECT\n  COUNT(DISTINCT m.patient_id)')) return [{ patients: 870, units: 902 }]
    if (sql.includes('AS visits')) return [{ visits: 880 }]
    if (sql.includes('AS cnt')) return [{ cnt: 902, patients: 5 }]
    if (sql.includes('AS concept_id')) return [{ concept_id: 3027018, rows: 1069, patients: 568 }]
    if (sql.includes('AS bin')) return [{ bin: 20, n: 4 }, { bin: 60, n: 300 }]
    if (sql.includes('AS gender')) return [{ gender: '8532', n: 400 }, { gender: '8507', n: 470 }]
    if (sql.includes('AS month')) return [{ month: '2024-01', n: 30 }, { month: '2024-03', n: 2 }]
    if (sql.includes('COUNT(*) AS n FROM')) return [{ n: 40000 }]
    if (sql.includes('AS label')) return [
      { label: 'Drug', rows: 7, patients: 5 },
      { label: 'Condition', rows: 800, patients: 300 },
      { label: 'Measurement', rows: 5000, patients: 860 },
    ]
    if (sql.includes('AS unit')) return [{ unit: 'ICU', n: 700 }]
    return []
  }

  it('builds every section, suppressed at the model', async () => {
    const model = await buildCohortReportModel({ cohort: cohort(), mapping, databaseName: 'eHOP', run, t, locale: 'en', threshold: 11, now: new Date('2026-09-23T10:00:00Z') })
    expect(model.kpis.map((k) => k.count.label)).toEqual(['870', '902', '880'])
    // Total + the three enabled top-level criteria; the disabled one is not a step.
    expect(model.flow).toHaveLength(4)
    expect(model.flow[0].patients).toEqual({ value: null, label: '<11' })
    expect(model.concepts[0]).toMatchObject({ conceptId: 3027018, name: 'Heart rate', coverage: '65.3' })
    expect(model.age[0].count.value).toBeNull()
    expect(model.sex.map((s) => s.label)).toEqual(['cohort_report.sex_female', 'cohort_report.sex_male'])
    expect(model.months.map((m) => m.label)).toEqual(['2024-01', '2024-02', '2024-03'])
    expect(model.months[1].count).toEqual({ value: 0, label: '0' })
    expect(model.months[2].count.value).toBeNull()
    // Largest first, the suppressed one last.
    expect(model.eventTables.map((e) => e.label)).toEqual(['Measurement', 'Condition', 'Drug'])
    expect(model.source).toEqual({ databaseName: 'eHOP', databasePatients: { value: 40000, label: '40,000' } })
  })

  it('refuses a hand-written query and the event level', async () => {
    await expect(buildCohortReportModel({ cohort: cohort({ customSql: 'SELECT 1' }), mapping, databaseName: 'x', run, t, locale: 'en', threshold: 11 }))
      .rejects.toBeInstanceOf(CohortReportUnavailable)
    await expect(buildCohortReportModel({ cohort: cohort({ level: 'event' }), mapping, databaseName: 'x', run, t, locale: 'en', threshold: 11 }))
      .rejects.toMatchObject({ reason: 'event-level' })
  })

  it('renders a self-contained, escaped HTML file', async () => {
    const model = await buildCohortReportModel({ cohort: cohort(), mapping, databaseName: 'eHOP', run, t, locale: 'en', threshold: 11 })
    const html = renderReportHtml(model, t, { includeSql: true })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('ICU &lt;adults&gt;')
    expect(html).not.toContain('ICU <adults>')
    // Nothing is fetched: no external stylesheet, script or image.
    expect(html).not.toMatch(/<(link|script)\b|src="http/)
    expect(html).toContain('<pre class="sql"><span class="keyword">SELECT</span> <span class="keyword">DISTINCT</span>')
    expect(renderReportHtml(model, t, { includeSql: false })).not.toContain('<pre')
  })
})

describe('renderReportDocx', () => {
  it('writes a Word archive holding the title and the suppressed counts', async () => {
    const { renderReportDocx } = await import('./render-docx')
    const JSZip = (await import('jszip')).default
    const run = async (sql: string): Promise<Record<string, unknown>[]> =>
      sql.includes('AS units') ? [{ patients: 870, units: 5 }] : []
    const model = await buildCohortReportModel({ cohort: cohort(), mapping, databaseName: 'eHOP', run, t, locale: 'en', threshold: 11 })
    // A 1×1 PNG: the renderer only needs bytes and a size.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const blob = await renderReportDocx(model, t, { includeSql: false }, async () => ({ data: png, width: 1, height: 1 }))
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('ICU &lt;adults&gt;')
    expect(doc).toContain('&lt;11')
  })
})

describe('tokenizeSql', () => {
  it('colours keywords, not the same words inside strings, identifiers or comments', () => {
    const toks = tokenizeSql(`SELECT "from" AS x, 'select' -- where\nFROM t1 WHERE n > 10`)
    const of = (kind: string) => toks.filter((k) => k.kind === kind).map((k) => k.text)
    expect(of('keyword')).toEqual(['SELECT', 'AS', 'FROM', 'WHERE'])
    expect(of('identifier')).toEqual(['"from"'])
    expect(of('string')).toEqual(["'select'"])
    expect(of('comment')).toEqual(['-- where'])
    expect(of('number')).toEqual(['10'])
    // Nothing lost or reordered.
    expect(toks.map((k) => k.text).join('')).toBe(`SELECT "from" AS x, 'select' -- where\nFROM t1 WHERE n > 10`)
  })
})

describe('niceScale', () => {
  it('rounds the axis up to a whole step', () => {
    expect(niceScale(47)).toEqual({ max: 60, step: 20 })
    expect(niceScale(3)).toEqual({ max: 3, step: 1 })
    expect(niceScale(0)).toEqual({ max: 1, step: 1 })
    expect(niceScale(1234)).toEqual({ max: 1500, step: 500 })
  })
})

describe('donut', () => {
  it('draws one arc per shown count, none for a suppressed one, and gives no share for it', () => {
    const svg = donut([
      { label: 'Female', count: { value: 300, label: '300' } },
      { label: 'Male', count: { value: 100, label: '100' } },
      { label: 'Unknown', count: { value: null, label: '<11' } },
    ], { title: 'Sex', locale: 'fr', centerValue: '411', centerLabel: 'patients' })
    expect(svg.match(/<path /g)).toHaveLength(2)
    // Shares in the report's locale; the suppressed one shows its label instead.
    expect(svg).toMatch(/Female — 75,0\s%/)
    expect(svg).toContain('Unknown — &lt;11')
    expect(svg).toContain('>411<')
    // A single category is a full ring, not a degenerate arc.
    expect(donut([{ label: 'Female', count: { value: 5, label: '5' } }], { title: 'Sex', locale: 'en' })).toContain('<circle')
  })
})

describe('columnChart', () => {
  it('keeps each count in a tooltip and skips suppressed columns', () => {
    const svg = columnChart([
      { label: '20–29', count: { value: 40, label: '40' } },
      { label: '30–39', count: { value: null, label: '<11' } },
    ], { title: 'Age', unit: 'patients' })
    expect(svg.match(/<rect /g)).toHaveLength(1)
    expect(svg).toContain('<title>20–29 : 40 patients</title>')
    expect(svg).toContain('>30–39<')
  })
})
