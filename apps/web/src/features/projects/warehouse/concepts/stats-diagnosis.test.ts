import { describe, expect, it } from 'vitest'
import { diagnosisLines } from './stats-diagnosis'

describe('diagnosisLines', () => {
  it('prints scalars, one line per list entry, and a dash for empty lists', () => {
    const lines = diagnosisLines({
      conceptId: 220045,
      dictKey: null,
      covering: [{ unit: 'stats-1-of-2', lo: 1, hi: 300000, done: true }],
      inRecordUnits: [],
    })
    expect(lines).toEqual([
      { label: 'conceptId', value: (220045).toLocaleString() },
      { label: 'dictKey', value: '—' },
      { label: 'covering', value: `stats-1-of-2 — lo 1 · hi ${(300000).toLocaleString()} · done true` },
      { label: 'inRecordUnits', value: '—' },
    ])
  })

  it('keeps an entry without a unit name readable', () => {
    expect(diagnosisLines({ inStatsUnits: [{ asText: 0, asNumber: 3 }] })).toEqual([
      { label: 'inStatsUnits', value: 'asText 0 · asNumber 3' },
    ])
  })
})
