import { describe, expect, it } from 'vitest'
import type { CatalogCrossingResult } from '@/types/catalog'
import { computeAnonymizationImpact, computeCrossingMasks, PRIMARY, PUBLISHED, SECONDARY, publishedCellShare } from './suppression'

const crossing = (id: string, rows: [string[], number][]): CatalogCrossingResult => ({
  id, variables: id.split('-') as CatalogCrossingResult['variables'], rows: rows.map(([values, patients]) => ({ values, patients })),
})

describe('computeCrossingMasks', () => {
  it('masks the cells below the threshold', () => {
    const masks = computeCrossingMasks([crossing('age', [[['a'], 5], [['b'], 50], [['c'], 3]])], 10)
    expect([...masks.get('age')!.status]).toEqual([PRIMARY, PUBLISHED, PRIMARY])
  })

  it('masks the smallest other cell of a group whose total is published and holds one masked cell', () => {
    // 5 alone would be 100 − 60 − 35 by subtraction from the published sex total.
    const masks = computeCrossingMasks([
      crossing('sex', [[['male'], 100], [['female'], 80]]),
      crossing('age-sex', [[['a', 'male'], 5], [['b', 'male'], 60], [['c', 'male'], 35], [['a', 'female'], 40], [['b', 'female'], 40]]),
    ], 10)
    const m = masks.get('age-sex')!
    expect([...m.status]).toEqual([PRIMARY, PUBLISHED, SECONDARY, PUBLISHED, PUBLISHED])
    expect(m).toMatchObject({ cells: 5, primary: 1, secondary: 1 })
    expect(publishedCellShare(m)).toBeCloseTo(0.6)
  })

  it('cascades along the other variable', () => {
    const masks = computeCrossingMasks([
      crossing('age', [[['a'], 100], [['b'], 100]]),
      crossing('sex', [[['male'], 100], [['female'], 100]]),
      crossing('age-sex', [[['a', 'male'], 4], [['a', 'female'], 50], [['b', 'male'], 30], [['b', 'female'], 60]]),
    ], 10)
    // a·male masked → a·female (row a) and b·male (column male) protect it, then b·female closes the last pair.
    expect([...masks.get('age-sex')!.status].filter((s) => s !== PUBLISHED)).toHaveLength(4)
  })

  it('does not use a margin counted over another population', () => {
    const masks = computeCrossingMasks([
      crossing('sex', [[['male'], 100]]),
      crossing('concept-sex', [[['1', 'male'], 5], [['2', 'male'], 60]]),
    ], 10)
    // concept-sex counts events, sex counts visits: the visit total reveals nothing about events.
    // The grand total (always published) still groups the concepts, so the 60 protects the 5.
    expect([...masks.get('concept-sex')!.status]).toEqual([PRIMARY, SECONDARY])
  })
})

describe('computeAnonymizationImpact', () => {
  it('sums up what the settings mask, crossing by crossing', () => {
    const impact = computeAnonymizationImpact({
      concepts: [{ conceptId: 1, conceptName: 'A', patientCount: 3, recordCount: 3 }, { conceptId: 2, conceptName: 'B', patientCount: 30, recordCount: 30 }],
      crossings: [{ id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 40 }, { values: ['female'], patients: 4 }, { values: ['other'], patients: 2 }] }],
    }, { threshold: 10, mode: 'suppress' })
    expect(impact).toMatchObject({ threshold: 10, mode: 'suppress', concepts: { total: 2, masked: 1 } })
    expect(impact.crossings).toEqual([{ id: 'sex', variables: ['sex'], cells: 3, primary: 2, secondary: 0, patientMass: 46, publishedMass: 40 }])
  })
})
