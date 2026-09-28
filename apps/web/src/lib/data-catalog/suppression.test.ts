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

  it('protects a small cell through the concept margin', () => {
    // Concept 42's total, 63, is published: 42·female = 3 would be 63 − 60.
    const masks = computeCrossingMasks([
      crossing('concept', [[['42'], 63], [['7'], 90]]),
      crossing('concept-sex', [[['42', 'male'], 60], [['42', 'female'], 3], [['7', 'male'], 50], [['7', 'female'], 40]]),
    ], 10)
    expect([...masks.get('concept-sex')!.status].slice(0, 2)).toEqual([SECONDARY, PRIMARY])
  })

  it('masks one more cell when the masked ones add up to a small total', () => {
    // Atrovent: one record in 2100 and one in 2210, both masked — two of them,
    // yet total − published = 2 records, so at most 2 patients: 2200 goes too.
    const rows = (cells: [string, number, number][]): CatalogCrossingResult['rows'] => cells.map(([p, patients, records]) => ({ values: ['c', p], patients, records }))
    const masks = computeCrossingMasks([
      { id: 'concept', variables: ['concept'], rows: [{ values: ['c'], patients: 900, records: 1300 }] },
      { id: 'concept-period', variables: ['concept', 'period'], rows: rows([['2100', 1, 1], ['2190', 800, 1164], ['2200', 79, 133], ['2210', 1, 1]]) },
    ], 10)
    expect([...masks.get('concept-period')!.status]).toEqual([PRIMARY, PUBLISHED, SECONDARY, PRIMARY])
  })

  it('protects a group whose total is masked: another table can give that total back', () => {
    // Period 2 is masked to protect period 1, but the grand total gives it
    // back; 2·male published would then tell 2·female = 70 − 63.
    const masks = computeCrossingMasks([
      crossing('period', [[['1'], 3], [['2'], 70], [['3'], 80]]),
      crossing('period-sex', [[['2', 'male'], 63], [['2', 'female'], 7], [['3', 'male'], 50], [['3', 'female'], 30]]),
    ], 10)
    expect(masks.get('period')!.status[1]).toBe(SECONDARY)
    expect([...masks.get('period-sex')!.status].slice(0, 2)).toEqual([SECONDARY, PRIMARY])
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
  it('sums up what the masks hide, crossing by crossing and in the concept list', () => {
    const crossings = [crossing('sex', [[['male'], 40], [['female'], 4], [['other'], 2]])]
    const impact = computeAnonymizationImpact(
      { crossings, masks: computeCrossingMasks(crossings, 10), conceptStatus: [PRIMARY, PUBLISHED, SECONDARY] },
      { threshold: 10, mode: 'suppress' },
    )
    expect(impact).toMatchObject({ threshold: 10, mode: 'suppress', concepts: { total: 3, masked: 2 } })
    // Men published would give the other two away: 46 − 40 = 6 patients between them.
    expect(impact.crossings).toEqual([{ id: 'sex', variables: ['sex'], cells: 3, primary: 2, secondary: 1, patientMass: 46, publishedMass: 0 }])
  })
})
