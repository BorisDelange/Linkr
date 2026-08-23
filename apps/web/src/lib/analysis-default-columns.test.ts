import { describe, it, expect } from 'vitest'
import {
  looksLikeIdentifier,
  isDefaultAnalysisColumn,
  defaultAnalysisColumns,
  orderSelection,
} from './analysis-default-columns'
import type { DatasetColumn } from '@/types'

function col(name: string, type: DatasetColumn['type'] = 'string'): DatasetColumn {
  return { id: name, name, type, order: 0 }
}

describe('looksLikeIdentifier', () => {
  it('matches id alone and the separator suffixes exports produce', () => {
    for (const n of ['id', 'ID', 'Id', 'patient_id', 'PATIENT_ID', 'subject-id', 'visit.id']) {
      expect(looksLikeIdentifier(n)).toBe(true)
    }
  })

  it('does not match words that merely end in the letters', () => {
    // The reason the rule requires a separator: these are real variables.
    for (const n of ['valid', 'covid', 'fluid', 'rapid', 'avoid', 'thyroid']) {
      expect(looksLikeIdentifier(n)).toBe(false)
    }
  })

  it('ignores surrounding whitespace', () => {
    expect(looksLikeIdentifier('  id  ')).toBe(true)
  })

  it('does not match an id PREFIX, which is usually a real variable', () => {
    expect(looksLikeIdentifier('identity')).toBe(false)
    expect(looksLikeIdentifier('id_card_seen')).toBe(false)
  })
})

describe('isDefaultAnalysisColumn', () => {
  it('drops identifiers and dates, keeps everything else', () => {
    expect(isDefaultAnalysisColumn(col('age', 'number'))).toBe(true)
    expect(isDefaultAnalysisColumn(col('sex'))).toBe(true)
    expect(isDefaultAnalysisColumn(col('alive', 'boolean'))).toBe(true)
    expect(isDefaultAnalysisColumn(col('patient_id', 'number'))).toBe(false)
    expect(isDefaultAnalysisColumn(col('admission', 'date'))).toBe(false)
  })
})

describe('defaultAnalysisColumns', () => {
  it('keeps the order of the columns it keeps', () => {
    const columns = [col('patient_id'), col('age', 'number'), col('admission', 'date'), col('sex')]
    expect(defaultAnalysisColumns(columns).map((c) => c.name)).toEqual(['age', 'sex'])
  })

  it('falls back to everything rather than producing an empty analysis', () => {
    // A dataset of nothing but ids and dates: an empty table the user cannot
    // explain is worse than one they can untick.
    const columns = [col('patient_id'), col('admission', 'date')]
    expect(defaultAnalysisColumns(columns)).toHaveLength(2)
  })

  it('returns nothing for no columns, without throwing', () => {
    expect(defaultAnalysisColumns([])).toEqual([])
  })
})

describe('orderSelection', () => {
  const columns = [col('zebra'), col('alpha'), col('mid'), col('unused')]

  it('custom keeps the selection array as-is — the array IS the order', () => {
    expect(orderSelection(['mid', 'zebra', 'alpha'], columns, 'custom')).toEqual([
      'mid', 'zebra', 'alpha',
    ])
  })

  it('dataset order follows the column list, not the tick order', () => {
    // The point: ticking a variable late must not park it at the end.
    expect(orderSelection(['mid', 'zebra', 'alpha'], columns, 'dataset')).toEqual([
      'zebra', 'alpha', 'mid',
    ])
  })

  it('alphabetical sorts by the label when one is given', () => {
    const labelled = [
      { ...col('a'), label: 'Zebra' },
      { ...col('b'), label: 'Alpha' },
    ]
    expect(orderSelection(['a', 'b'], labelled, 'alphabetical', (c) => c.label ?? c.name)).toEqual([
      'b', 'a',
    ])
  })

  it('sorts accented labels by base letter, not by byte', () => {
    // "Âge" must come first; byte order would put it after "Zone".
    const labelled = [
      { ...col('a'), label: 'Zone' },
      { ...col('b'), label: 'Âge' },
    ]
    expect(orderSelection(['a', 'b'], labelled, 'alphabetical', (c) => c.label ?? c.name)).toEqual([
      'b', 'a',
    ])
  })

  it('drops ids of columns that no longer exist, in every mode', () => {
    for (const mode of ['custom', 'dataset', 'alphabetical'] as const) {
      expect(orderSelection(['alpha', 'ghost'], columns, mode)).toEqual(['alpha'])
    }
  })
})
