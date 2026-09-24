import { describe, expect, it } from 'vitest'
import { materializationFromRows } from './cohort-materialization'

describe('materializationFromRows', () => {
  it('keeps every level id and the distinct patients, as strings', () => {
    const rows = [
      { id: 10, patient_id: 1 },
      { id: 11, patient_id: 1 },
      { id: null, patient_id: 2 },
      { id: 12, patient_id: null },
    ]
    expect(materializationFromRows('visit', rows, '2026-09-24T12:00:00.000Z')).toEqual({
      level: 'visit',
      ids: ['10', '11', '12'],
      patientIds: ['1', '2'],
      count: 3,
      materializedAt: '2026-09-24T12:00:00.000Z',
    })
  })

  it('freezes an empty cohort as an empty snapshot', () => {
    expect(materializationFromRows('patient', [], 't')).toMatchObject({ ids: [], patientIds: [], count: 0 })
  })
})
