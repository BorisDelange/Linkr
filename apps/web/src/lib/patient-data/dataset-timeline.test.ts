import { describe, expect, it } from 'vitest'
import {
  datasetRowsToTimeline,
  datasetSeriesId,
  datasetSeriesKeyId,
  datasetSeriesOptions,
  isDatasetSeriesId,
  timelineDatasets,
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
    const labelled = {
      ...mapping, labelColumn: 'col_kind', valueColumn: 'col_value',
      codes: ['PEEP', 'FiO2'],
    }
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

describe('datasetSeriesKeyId', () => {
  it('gives the same series the same id whatever rows arrive', () => {
    // The regression it guards: a positional id shifts when a patient is missing
    // the first code, moving every colour the user picked onto another series.
    expect(datasetSeriesKeyId('ds1', 'PEEP')).toBe(datasetSeriesKeyId('ds1', 'PEEP'))
  })

  it('separates two codes, and the same code in two datasets', () => {
    expect(datasetSeriesKeyId('ds1', 'PEEP')).not.toBe(datasetSeriesKeyId('ds1', 'FiO2'))
    expect(datasetSeriesKeyId('ds1', 'PEEP')).not.toBe(datasetSeriesKeyId('ds2', 'PEEP'))
  })

  it('always mints an id no OMOP concept can hold', () => {
    // Every id must be negative AND safe: the hash is unsigned before negation, so
    // a high hash cannot wrap round into a positive (colliding) id.
    for (const code of ['', 'a', 'PEEP', 'ÿÿÿ', 'x'.repeat(400), '9999999']) {
      const id = datasetSeriesKeyId('ds1', code)
      expect(id).toBeLessThan(0)
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(isDatasetSeriesId(id)).toBe(true)
    }
  })
})

describe('datasetRowsToTimeline — code filtering', () => {
  const coded: DatasetTimelineMapping = {
    ...mapping,
    conceptCodeColumn: 'col_code',
    labelColumn: 'col_label',
    seriesName: undefined,
  }
  const rows = [
    { col_person_id: 'p1', col_start: '2026-01-04', col_code: 'A', col_label: 'Alpha' },
    { col_person_id: 'p1', col_start: '2026-01-05', col_code: 'B', col_label: 'Beta' },
  ]

  it('plots nothing until codes are picked', () => {
    // Filtering is required: a dataset holds hundreds of codes, and drawing them
    // all would make the chart unreadable.
    expect(datasetRowsToTimeline(rows, coded, patient, 'ds')).toEqual([])
    expect(datasetRowsToTimeline(rows, { ...coded, codes: [] }, patient, 'ds')).toEqual([])
  })

  it('plots only the codes picked', () => {
    const out = datasetRowsToTimeline(rows, { ...coded, codes: ['A'] }, patient, 'ds')
    expect(out.map((r) => r.concept_name)).toEqual(['Alpha'])
  })

  it('still plots an ungrouped dataset with no codes at all', () => {
    // Nothing to filter when every row is one series, so requiring a pick there
    // would make a perfectly valid mapping undrawable.
    const out = datasetRowsToTimeline(
      [{ col_person_id: 'p1', col_start: '2026-01-04' }],
      { ...mapping, seriesName: 'Ventilation' }, patient, 'ds',
    )
    expect(out).toHaveLength(1)
  })

  it('groups by the CODE, not the label, when both are set', () => {
    // Two codes sharing a display name must stay two series.
    const sameName = [
      { col_person_id: 'p1', col_start: '2026-01-04', col_code: 'A', col_label: 'Dose' },
      { col_person_id: 'p1', col_start: '2026-01-05', col_code: 'B', col_label: 'Dose' },
    ]
    const out = datasetRowsToTimeline(sameName, { ...coded, codes: ['A', 'B'] }, patient, 'ds')
    expect(new Set(out.map((r) => r.concept_id)).size).toBe(2)
  })
})

describe('datasetSeriesOptions', () => {
  const coded: DatasetTimelineMapping = {
    ...mapping, conceptCodeColumn: 'col_code', labelColumn: 'col_label', seriesName: undefined,
  }

  it('counts distinct patients and rows over the WHOLE dataset', () => {
    // Counted across every patient, not the one on screen: a code absent from the
    // current patient is exactly what one still wants to put on the widget.
    const rows = [
      { col_person_id: 'p1', col_start: '2026-01-04', col_code: 'A', col_label: 'Alpha' },
      { col_person_id: 'p1', col_start: '2026-01-05', col_code: 'A', col_label: 'Alpha' },
      { col_person_id: 'p2', col_start: '2026-01-06', col_code: 'A', col_label: 'Alpha' },
      { col_person_id: 'p3', col_start: '2026-01-07', col_code: 'B', col_label: 'Beta' },
    ]
    const [first, second] = datasetSeriesOptions(rows, coded)
    expect(first).toEqual({ code: 'A', name: 'Alpha', patientCount: 2, recordCount: 3 })
    expect(second).toEqual({ code: 'B', name: 'Beta', patientCount: 1, recordCount: 1 })
  })

  it('excludes rows that carry no usable date', () => {
    // They can never be drawn, so counting them would offer a series that renders
    // empty.
    const rows = [
      { col_person_id: 'p1', col_start: '2026-01-04', col_code: 'A' },
      { col_person_id: 'p1', col_start: 'not a date', col_code: 'A' },
    ]
    expect(datasetSeriesOptions(rows, coded)[0].recordCount).toBe(1)
  })

  it('ranks the commonest series first', () => {
    const rows = [
      { col_person_id: 'p1', col_start: '2026-01-04', col_code: 'rare' },
      { col_person_id: 'p1', col_start: '2026-01-05', col_code: 'common' },
      { col_person_id: 'p2', col_start: '2026-01-06', col_code: 'common' },
    ]
    expect(datasetSeriesOptions(rows, coded).map((o) => o.code)).toEqual(['common', 'rare'])
  })

  it('falls back to the label when there is no code column', () => {
    const byLabel = { ...mapping, labelColumn: 'col_label', seriesName: undefined }
    const rows = [{ col_person_id: 'p1', col_start: '2026-01-04', col_label: 'Alpha' }]
    expect(datasetSeriesOptions(rows, byLabel)[0]).toMatchObject({ code: 'Alpha', name: 'Alpha' })
  })
})

describe('timelineDatasets', () => {
  it('reads a widget configured before multi-dataset support', () => {
    expect(timelineDatasets({ dataset: mapping })).toEqual([mapping])
  })

  it('prefers the new key when a config carries both', () => {
    const other = { ...mapping, datasetFileId: 'ds2' }
    expect(timelineDatasets({ datasets: [other], dataset: mapping })).toEqual([other])
  })

  it('honours an emptied list rather than resurrecting the legacy one', () => {
    // Editing an old widget writes `datasets` and leaves the legacy `dataset` in
    // place. Falling back on emptiness would silently undo removing the last one.
    expect(timelineDatasets({ datasets: [], dataset: mapping })).toEqual([])
  })

  it('is empty for a widget that plots concepts only', () => {
    expect(timelineDatasets({})).toEqual([])
  })
})
