import { describe, expect, it } from 'vitest'
import {
  datasetRowsToTimeline,
  datasetSeriesId,
  datasetSeriesKeyId,
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

describe('datasetRowsToTimeline — one mapping is one named variable', () => {
  const named: DatasetTimelineMapping = {
    datasetFileId: 'ds1',
    personColumn: 'col_person_id',
    dateColumn: 'col_hr_datetime',
    valueColumn: 'col_hr_value',
    seriesName: 'Heart rate',
  }

  it('names every row after the mapping, not after the data', () => {
    // A wide dataset has no label column to read: the variable IS the column, and
    // its name is the one the user typed.
    const rows = [
      { col_person_id: 'p1', col_hr_datetime: '2026-01-04', col_hr_value: 80 },
      { col_person_id: 'p1', col_hr_datetime: '2026-01-05', col_hr_value: 92 },
    ]
    const out = datasetRowsToTimeline(rows, named, patient, 'file.csv')
    expect(out.map((r) => r.concept_name)).toEqual(['Heart rate', 'Heart rate'])
    expect(out.map((r) => r.value)).toEqual([80, 92])
  })

  it('gives every row of one variable the same series id', () => {
    const rows = [
      { col_person_id: 'p1', col_hr_datetime: '2026-01-04', col_hr_value: 80 },
      { col_person_id: 'p1', col_hr_datetime: '2026-01-05', col_hr_value: 92 },
    ]
    const ids = new Set(datasetRowsToTimeline(rows, named, patient, '').map((r) => r.concept_id))
    expect(ids.size).toBe(1)
  })

  it('separates two variables of the SAME dataset', () => {
    // heart_rate_value and creat_value live in one file; they must not share a
    // series id, or the chart would draw them as one line.
    const creat: DatasetTimelineMapping = {
      ...named, dateColumn: 'col_creat_datetime', valueColumn: 'col_creat_value',
      seriesName: 'Creatinine',
    }
    const hr = datasetRowsToTimeline(
      [{ col_person_id: 'p1', col_hr_datetime: '2026-01-04', col_hr_value: 80 }],
      named, patient, '',
    )
    const cr = datasetRowsToTimeline(
      [{ col_person_id: 'p1', col_creat_datetime: '2026-01-04', col_creat_value: 12 }],
      creat, patient, '',
    )
    expect(hr[0].concept_id).not.toBe(cr[0].concept_id)
  })

  it('falls back to the dataset name when nothing was typed', () => {
    const unnamed = { ...named, seriesName: undefined }
    const rows = [{ col_person_id: 'p1', col_hr_datetime: '2026-01-04', col_hr_value: 80 }]
    expect(datasetRowsToTimeline(rows, unnamed, patient, 'labs.csv')[0].concept_name)
      .toBe('labs.csv')
  })

  it('drops rows whose own date column is empty', () => {
    // The pairing is per-variable: a row holding a creatinine but no heart-rate
    // time is simply not a heart-rate measurement.
    const rows = [
      { col_person_id: 'p1', col_hr_datetime: '2026-01-04', col_hr_value: 80 },
      { col_person_id: 'p1', col_hr_datetime: null, col_hr_value: null },
    ]
    expect(datasetRowsToTimeline(rows, named, patient, '')).toHaveLength(1)
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
