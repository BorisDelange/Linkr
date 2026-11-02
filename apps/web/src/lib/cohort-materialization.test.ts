import { describe, expect, it } from 'vitest'
import { materializationFromRows, runMaterialization } from './cohort-materialization'

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

describe('runMaterialization', () => {
  const rows = [{ visit_id: 10, patient_id: 1 }, { visit_id: 11, patient_id: 1 }, { visit_id: 20, patient_id: 2 }]

  it('lists the run’s members, under an id that changes with them', () => {
    const m = runMaterialization('c', 'visit', rows, 3)!
    expect(m).toMatchObject({ level: 'visit', ids: ['10', '11', '20'], patientIds: ['1', '2'], count: 3 })
    expect(runMaterialization('c', 'visit', rows.slice(1), 2)!.materializedAt).not.toBe(m.materializedAt)
  })

  it('is none for a run that kept only its first rows', () => {
    expect(runMaterialization('c', 'visit', rows, 500_000)).toBeNull()
  })
})
