import { describe, expect, it } from 'vitest'
import type { CohortDerivation } from '@/types'
import { DEFAULT_PSEUDONYMS, draftFromDerivations, draftFromOptions } from './derive-draft'

describe('draftFromOptions', () => {
  it('reopens on what a derivation kept and how it pseudonymised', () => {
    const draft = draftFromOptions({
      scope: 'patient',
      tables: [{ schema: 'icu', table: 'chartevents' }, { schema: null, table: 'person' }],
      variables: { conceptIds: [1], conceptNames: {} },
      birthPrecision: 'year',
      pseudonymization: { method: 'random', keepKey: false, correspondence: { dataSourceId: 'db9', schemaName: 'p' } },
    })
    expect(draft).toMatchObject({ scope: 'patient', variablesMode: 'list', included: ['icu.chartevents', 'person'], birthPrecision: 'year' })
    expect(draft.pseudonyms).toMatchObject({ enabled: true, method: 'random', correspondenceId: 'db9', correspondenceSchema: 'p', correspondenceTable: 'linkr_pseudonyms' })
  })

  it('reads a build without pseudonyms or a birth precision as such', () => {
    const draft = draftFromOptions({ scope: 'visit' })
    expect(draft.pseudonyms).toEqual({ ...DEFAULT_PSEUDONYMS, enabled: false })
    expect(draft.birthPrecision).toBe('day')
    expect(draft.variablesMode).toBe('all')
    expect(draft).not.toHaveProperty('included')
  })
})

describe('draftFromDerivations', () => {
  const d = (builtAt: string, scope?: 'patient' | 'visit'): CohortDerivation => ({
    kind: 'new-database', targetId: 't', builtAt, patientCount: 1, ...(scope ? { options: { scope } } : {}),
  })
  it('takes the latest derivation that recorded its options', () => {
    expect(draftFromDerivations([d('2026-01-01', 'patient'), d('2026-03-01', 'visit'), d('2026-05-01')]).scope).toBe('visit')
    expect(draftFromDerivations([d('2026-05-01')])).toEqual({})
    expect(draftFromDerivations(undefined)).toEqual({})
  })
})
