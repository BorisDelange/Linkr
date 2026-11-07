import { describe, expect, it } from 'vitest'
import { materializationFromRows, runMaterialization, withUnfreezeOnRebind } from './cohort-materialization'
import type { Cohort } from '@/types'

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

describe('withUnfreezeOnRebind', () => {
  const frozen = {
    id: 'c', dataSourceId: 'db1', resultCount: 2, attrition: [],
    materialization: { level: 'patient', ids: ['1', '2'], patientIds: ['1', '2'], count: 2, materializedAt: 't', dataSourceId: 'db1' },
  } as unknown as Cohort

  it('drops the frozen membership and counts when the database changes', () => {
    expect(withUnfreezeOnRebind(frozen, { dataSourceId: 'db2' })).toEqual({
      materialization: undefined, resultCount: undefined, attrition: undefined, dataSourceId: 'db2',
    })
  })

  it('keeps them for an edit of anything else, or a move to the database it was frozen on', () => {
    expect(withUnfreezeOnRebind(frozen, { name: { en: 'x' } })).toEqual({ name: { en: 'x' } })
    expect(withUnfreezeOnRebind(frozen, { dataSourceId: 'db1' })).toEqual({ dataSourceId: 'db1' })
    const unbound = { ...frozen, dataSourceId: undefined } as Cohort
    expect(withUnfreezeOnRebind(unbound, { dataSourceId: 'db1' })).toEqual({ dataSourceId: 'db1' })
  })
})
