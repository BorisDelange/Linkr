import { describe, expect, it } from 'vitest'
import type { CohortReportModel } from '@/lib/cohort-report/model'
import { suppress } from '@/lib/cohort-report/suppress'
import { embedReportHtml, reportTranslator, summarizeReport } from './report'

const n = (v: number) => suppress(v, 11, 'en')

const model: CohortReportModel = {
  title: 'Women over 60', description: '', databaseName: 'MIMIC-IV Demo', level: 'visit',
  unitLabel: 'hospital stays', generatedAt: '2026-09-23T10:00:00Z', version: '0.1.0', threshold: 11, locale: 'en',
  kpis: [{ label: 'Patients', count: n(42) }, { label: 'hospital stays', count: n(57) }],
  flow: [{ label: 'All records', units: n(275), patients: n(100) }, { label: 'Sex: female', units: n(57), patients: n(42) }],
  criteria: [{ depth: 0, text: 'Sex: female' }, { depth: 0, operator: 'OR', text: 'Deceased' }],
  concepts: [{ criterion: 'Lactate', table: 'Lab events', conceptId: 50813, name: 'Lactate', rows: n(300), patients: n(4), coverage: null }],
  age: [{ label: '60–69', count: n(30) }], sex: [{ label: 'Female', count: n(42) }],
  months: [{ label: '2150-01', count: n(3) }, { label: '2150-04', count: n(12) }],
  source: { databaseName: 'MIMIC-IV Demo', databasePatients: n(100) },
  eventTables: [], careUnits: [], sql: 'SELECT 1',
}

describe('summarizeReport', () => {
  it('gives the figures as the report shows them, small counts suppressed', () => {
    const text = summarizeReport(model)
    expect(text).toContain('Counts: Patients: 42, hospital stays: 57.')
    expect(text).toContain('  Sex: female: 57 (42 patients)')
    expect(text).toContain('  OR Deceased')
    expect(text).toContain('Lactate (Lab events 50813): <11 patients, 300 rows')
    expect(text).toContain('Index dates: 2150-01 to 2150-04.')
    expect(text).not.toMatch(/\b4 patients/)
  })
})

describe('embedReportHtml', () => {
  it('fits the page to the frame and reports its height to the host', () => {
    const html = embedReportHtml('<html><head></head><body><div class="page"></div></body></html>')
    expect(html).toMatch(/<style>[^<]*max-width:210mm[^<]*<\/style><\/head>/)
    expect(html).toMatch(/ui-size-change[\s\S]*<\/script><\/body>/)
  })
})

describe('reportTranslator', () => {
  it('reads the app locales', async () => {
    expect((await reportTranslator('fr'))('cohort_report.kpi_patients')).toBe('Patients')
    expect((await reportTranslator('en'))('cohort_report.suppression_caption', { threshold: 11 })).toContain('<11')
  })
})
