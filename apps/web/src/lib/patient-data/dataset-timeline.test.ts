import { describe, expect, it } from 'vitest'
import {
  datasetRowsToTimeline,
  datasetSeriesId,
  isDatasetSeriesId,
  type DatasetTimelineMapping,
} from './dataset-timeline'

const mapping: DatasetTimelineMapping = {
  datasetFileId: 'ds1',
  personColumn: 'col_person_id',
  dateColumn: 'col_start',
  endColumn: 'col_end',
  seriesName: 'Ventilation',
}

const patient = { personId: 'p1', visitId: 'v1' }

describe('datasetSeriesId', () => {
  it('mints ids that cannot collide with an OMOP concept', () => {
    // OMOP ids are positive (locally-minted ones sit in the 2-billion range), so
    // negative space is free — the same trick as negative row ordinals.
    expect(datasetSeriesId(0)).toBeLessThan(0)
    expect(isDatasetSeriesId(datasetSeriesId(3))).toBe(true)
    expect(isDatasetSeriesId(3620000)).toBe(false)
  })
})

describe('datasetRowsToTimeline', () => {
  it('keeps only the selected patient rows', () => {
    const rows = [
      { col_person_id: 'p1', col_start: '2026-01-04' },
      { col_person_id: 'p2', col_start: '2026-01-05' },
    ]
    const out = datasetRowsToTimeline(rows, mapping, patient, 'ds')
    expect(out).toHaveLength(1)
    expect(out[0].concept_name).toBe('Ventilation')
  })

  it('compares ids as text, since they cross JSON as numbers or strings', () => {
    const rows = [{ col_person_id: 1, col_start: '2026-01-04' }]
    const out = datasetRowsToTimeline(rows, mapping, { personId: '1', visitId: null }, 'ds')
    expect(out).toHaveLength(1)
  })

  it('filters on the visit when the mapping names a visit column', () => {
    const withVisit = { ...mapping, visitColumn: 'col_visit' }
    const rows = [
      { col_person_id: 'p1', col_visit: 'v1', col_start: '2026-01-04' },
      { col_person_id: 'p1', col_visit: 'v2', col_start: '2026-01-06' },
    ]
    expect(datasetRowsToTimeline(rows, withVisit, patient, 'ds')).toHaveLength(1)
  })

  it('shows a per-patient dataset on every visit', () => {
    // No visit column: the collection is per patient, so it is not stay-specific.
    const rows = [{ col_person_id: 'p1', col_start: '2026-01-04' }]
    expect(datasetRowsToTimeline(rows, mapping, patient, 'ds')).toHaveLength(1)
  })

  it('drops a row that cannot be placed in time', () => {
    const rows = [
      { col_person_id: 'p1', col_start: '' },
      { col_person_id: 'p1', col_start: 'not a date' },
      { col_person_id: 'p1', col_start: '2026-01-04' },
    ]
    expect(datasetRowsToTimeline(rows, mapping, patient, 'ds')).toHaveLength(1)
  })

  it('carries an end date so a lasting event draws as a block', () => {
    const rows = [{ col_person_id: 'p1', col_start: '2026-01-04', col_end: '2026-01-09' }]
    const [row] = datasetRowsToTimeline(rows, mapping, patient, 'ds')
    expect(row.end_date).toBeInstanceOf(Date)
  })

  it('splits series by the label column', () => {
    const labelled = { ...mapping, labelColumn: 'col_kind', valueColumn: 'col_value' }
    const rows = [
      { col_person_id: 'p1', col_start: '2026-01-04', col_kind: 'PEEP', col_value: '8' },
      { col_person_id: 'p1', col_start: '2026-01-05', col_kind: 'FiO2', col_value: '40' },
      { col_person_id: 'p1', col_start: '2026-01-06', col_kind: 'PEEP', col_value: '10' },
    ]
    const out = datasetRowsToTimeline(rows, labelled, patient, 'ds')
    const byName = new Map(out.map((r) => [r.concept_name, r.concept_id]))
    expect([...byName.keys()].sort()).toEqual(['FiO2', 'PEEP'])
    // The same label keeps the same series id, or the chart would draw two curves.
    expect(out.filter((r) => r.concept_name === 'PEEP').map((r) => r.concept_id))
      .toEqual([byName.get('PEEP'), byName.get('PEEP')])
  })

  it('reads a non-numeric value as a categorical marker', () => {
    const withValue = { ...mapping, valueColumn: 'col_mode' }
    const rows = [{ col_person_id: 'p1', col_start: '2026-01-04', col_mode: 'pressure support' }]
    const [row] = datasetRowsToTimeline(rows, withValue, patient, 'ds')
    expect(row.value_string).toBe('pressure support')
  })

  it('parses numbers a CSV leaves as text', () => {
    const withValue = { ...mapping, valueColumn: 'col_value' }
    const rows = [{ col_person_id: 'p1', col_start: '2026-01-04', col_value: '8' }]
    const [row] = datasetRowsToTimeline(rows, withValue, patient, 'ds')
    expect(row.value).toBe(8)
    expect(row.value_string).toBeNull()
  })

  it('returns rows in chronological order', () => {
    const rows = [
      { col_person_id: 'p1', col_start: '2026-01-09' },
      { col_person_id: 'p1', col_start: '2026-01-04' },
      { col_person_id: 'p1', col_start: '2026-01-06' },
    ]
    const out = datasetRowsToTimeline(rows, mapping, patient, 'ds')
    expect(out.map((r) => (r.event_date as Date).toISOString().slice(0, 10)))
      .toEqual(['2026-01-04', '2026-01-06', '2026-01-09'])
  })

  it('returns nothing without a patient or a configured mapping', () => {
    const rows = [{ col_person_id: 'p1', col_start: '2026-01-04' }]
    expect(datasetRowsToTimeline(rows, mapping, { personId: null, visitId: null }, 'ds')).toEqual([])
    expect(datasetRowsToTimeline(rows, { ...mapping, dateColumn: '' }, patient, 'ds')).toEqual([])
  })

  it('handles the Date and epoch forms DuckDB returns', () => {
    const rows = [
      { col_person_id: 'p1', col_start: new Date('2026-01-04T00:00:00Z') },
      { col_person_id: 'p1', col_start: Date.parse('2026-01-05T00:00:00Z') },
    ]
    expect(datasetRowsToTimeline(rows, mapping, patient, 'ds')).toHaveLength(2)
  })
})
