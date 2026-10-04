import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { eventRelation } from '@/lib/schema-classes/relations'
import { eventScopeCondition, windowBound, windowCondition, NO_SCOPE, buildVisitWindowQuery, type PatientScope } from './patient-scope'
import { buildNotesQuery, buildTimelineQuery } from './patient-data-queries'

const v1 = {
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime', endDateColumn: 'visit_end_datetime' },
  visitDetailTable: { table: 'visit_detail', idColumn: 'visit_detail_id', visitIdColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_detail_start_datetime', endDateColumn: 'visit_detail_end_datetime' },
  noteTable: { table: 'note', idColumn: 'note_id', patientIdColumn: 'person_id', dateColumn: 'note_datetime', textColumn: 'note_text' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime', valueColumn: 'value_as_number' },
    Drug: { table: 'drug_exposure', conceptIdColumn: 'drug_concept_id', patientIdColumn: 'person_id', dateColumn: 'drug_exposure_start_datetime', endDateColumn: 'drug_exposure_end_datetime', valueColumn: 'quantity' },
  },
}
const mapping = mappingV1ToV2(v1 as unknown as SchemaMappingV1)
const measurement = eventRelation(mapping, 'Measurement')!
const drug = eventRelation(mapping, 'Drug')!
/** The convention maps the visit id on every event table; a mapping may not. */
const withVisitId = { ...measurement, mapped: new Set([...measurement.mapped, 'visit_id']) }
const noVisitId = { ...measurement, mapped: new Set([...measurement.mapped].filter((c) => c !== 'visit_id')) }

const visit = { start: '2150-01-01T00:00:00.000Z', end: '2150-01-10T18:00:00.000Z' }
const stay = { start: '2150-01-03T08:00:00.000Z', end: '2150-01-05T14:30:00.000Z' }
const scope = (patch: Partial<PatientScope>): PatientScope => ({ ...NO_SCOPE, ...patch })

describe('eventScopeCondition', () => {
  it('scopes nothing without a selection', () => {
    expect(eventScopeCondition(mapping, measurement, NO_SCOPE)).toBe('')
  })

  it('matches a hospitalisation by the visit id the row records', () => {
    const sql = eventScopeCondition(mapping, withVisitId, scope({ visitId: "v'1", visit }))
    expect(sql).toBe("\n  AND e.visit_id = 'v''1'")
  })

  it('falls back to the hospitalisation dates when the rows record no visit', () => {
    const sql = eventScopeCondition(mapping, noVisitId, scope({ visitId: 'v1', visit }))
    expect(sql).not.toContain('visit_id')
    expect(sql).toContain(`e.start_datetime >= TIMESTAMP '${visit.start}'`)
    expect(sql).toContain(`e.start_datetime <= TIMESTAMP '${visit.end}'`)
  })

  it('leaves rows without a visit unscoped until the dates are known, rather than empty', () => {
    expect(eventScopeCondition(mapping, noVisitId, scope({ visitId: 'v1' }))).toBe('')
  })

  it('adds the stay by time, even where the visit matched by id', () => {
    const sql = eventScopeCondition(mapping, withVisitId, scope({ visitId: 'v1', visit, stay }))
    expect(sql).toContain("e.visit_id = 'v1'")
    expect(sql).toContain(`e.start_datetime >= TIMESTAMP '${stay.start}'`)
    expect(sql).toContain(`e.start_datetime <= TIMESTAMP '${stay.end}'`)
  })

  it('keeps the whole last day of a window ending on a date', () => {
    const sql = windowCondition({ start: visit.start, end: '2150-01-10' }, 'e.start_datetime')
    expect(sql).toContain("e.start_datetime < TIMESTAMP '2150-01-10' + INTERVAL 1 DAY")
    expect(sql).not.toContain('<=')
  })

  it('stops a window ending on a timestamp at midnight there, not a day later', () => {
    const sql = windowCondition({ start: visit.start, end: '2150-01-10T00:00:00.000Z' }, 'e.start_datetime')
    expect(sql).toContain("e.start_datetime <= TIMESTAMP '2150-01-10T00:00:00.000Z'")
    expect(sql).not.toContain('INTERVAL')
  })

  it('keeps a row still running when the stay began', () => {
    const sql = eventScopeCondition(mapping, drug, scope({ stay }))
    expect(sql).toContain(`COALESCE(e.end_datetime, e.start_datetime) >= TIMESTAMP '${stay.start}'`)
  })
})

describe('windowCondition', () => {
  it('has no upper bound for an open stay', () => {
    const sql = windowCondition({ start: stay.start, end: null }, 'n.note_datetime')
    expect(sql).toBe(`\n  AND n.note_datetime >= TIMESTAMP '${stay.start}'`)
  })
})

describe('windowBound', () => {
  it('keeps a DATE as a date, as both engines return it', () => {
    expect(windowBound('2150-01-10')).toBe('2150-01-10')
  })

  it('reads a timestamp, midnight included, as its UTC instant', () => {
    expect(windowBound('2150-01-10T00:00:00')).toBe('2150-01-10T00:00:00.000Z')
    expect(windowBound('2150-01-10 00:00:00')).toBe('2150-01-10T00:00:00.000Z')
    expect(windowBound(Date.UTC(2150, 0, 10))).toBe('2150-01-10T00:00:00.000Z')
  })

  it('has no bound for a missing value', () => {
    expect(windowBound(null)).toBeNull()
  })
})

describe('buildVisitWindowQuery', () => {
  it('reads the hospitalisation dates by id', () => {
    const sql = buildVisitWindowQuery(mapping, 'v1')!
    expect(sql).toContain('start_datetime AS window_start')
    expect(sql).toContain('end_datetime AS window_end')
    expect(sql).toContain("WHERE visit_id = 'v1'")
  })
})

describe('Timeline and Notes honour the stay', () => {
  it('timeline: every event table is scoped to the stay', () => {
    const sql = buildTimelineQuery(mapping, [1], 'p1', scope({ visitId: 'v1', visit, stay }))!
    expect(sql.match(new RegExp(`>= TIMESTAMP '${stay.start}'`, 'g'))).toHaveLength(2)
  })

  it('notes: scoped by the note date, through the hospitalisation dates when notes record no visit', () => {
    const sql = buildNotesQuery(mapping, 'p1', scope({ visitId: 'v1', visit, stay }))!
    expect(sql).toContain(`n.note_datetime >= TIMESTAMP '${visit.start}'`)
    expect(sql).toContain(`n.note_datetime >= TIMESTAMP '${stay.start}'`)
    expect(sql).not.toContain("n.visit_id = 'v1'")
  })

  it('notes: by visit id when notes record one', () => {
    const withNoteVisit = mappingV1ToV2({ ...v1, noteTable: { ...v1.noteTable, visitIdColumn: 'visit_occurrence_id' } } as unknown as SchemaMappingV1)
    const sql = buildNotesQuery(withNoteVisit, 'p1', scope({ visitId: 'v1', visit }))!
    expect(sql).toContain("n.visit_id = 'v1'")
  })
})
