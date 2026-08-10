import { describe, expect, it } from 'vitest'
import {
  classifyDiff,
  countByDiff,
  expectedRowsByTarget,
  isQualityCacheUsable,
  qualityFingerprint,
  sortTableCounts,
  type ConceptCount,
} from './quality-diff'

describe('classifyDiff', () => {
  it('flags rows that arrived but never mapped', () => {
    // The defect this view exists to find: data is there, the mapping did nothing.
    expect(classifyDiff(500, 0, 500)).toBe('missing')
  })

  it('reports a shortfall', () => {
    expect(classifyDiff(500, 400, 500)).toBe('fewer')
  })

  it('reports a surplus', () => {
    expect(classifyDiff(500, 600, 500)).toBe('more')
  })

  it('reports an exact match', () => {
    expect(classifyDiff(500, 500, 500)).toBe('match')
  })

  it('treats a concept with no source data as a match, not a defect', () => {
    // Nothing arrived, so nothing is missing: flagging it would bury the real
    // problems under every unused mapping in the dictionary.
    expect(classifyDiff(0, 0, 0)).toBe('match')
  })

  it('does not flag a shortfall when nothing was expected', () => {
    expect(classifyDiff(0, 10, 0)).toBe('match')
  })
})

describe('expectedRowsByTarget', () => {
  const counts = new Map<number, ConceptCount>([
    [2_000_000_001, { patients: 3, rows: 100 }],
    [2_000_000_002, { patients: 4, rows: 250 }],
  ])

  it('sums the source rows feeding one target concept', () => {
    // N:1 — two source codes map to the same standard concept, so the target is
    // expected to hold both their rows.
    const totals = expectedRowsByTarget([
      { sourceConceptId: 2_000_000_001, targetConceptId: 3027018 },
      { sourceConceptId: 2_000_000_002, targetConceptId: 3027018 },
    ], counts)
    expect(totals.get(3027018)).toBe(350)
  })

  it('keeps separate targets separate', () => {
    const totals = expectedRowsByTarget([
      { sourceConceptId: 2_000_000_001, targetConceptId: 1 },
      { sourceConceptId: 2_000_000_002, targetConceptId: 2 },
    ], counts)
    expect(totals.get(1)).toBe(100)
    expect(totals.get(2)).toBe(250)
  })

  it('counts an unassigned source concept as zero, not as missing data', () => {
    const totals = expectedRowsByTarget([{ sourceConceptId: 0, targetConceptId: 5 }], counts)
    expect(totals.get(5)).toBe(0)
  })

  it('treats a source concept with no observed rows as zero', () => {
    const totals = expectedRowsByTarget([{ sourceConceptId: 999, targetConceptId: 5 }], counts)
    expect(totals.get(5)).toBe(0)
  })
})

describe('countByDiff', () => {
  it('counts every verdict, including the absent ones', () => {
    const counts = countByDiff([
      { diff: 'match' as const }, { diff: 'match' as const }, { diff: 'missing' as const },
    ])
    expect(counts).toEqual({ match: 2, missing: 1, fewer: 0, more: 0 })
  })

  it('returns all zeros for no rows', () => {
    expect(countByDiff([])).toEqual({ match: 0, missing: 0, fewer: 0, more: 0 })
  })
})

describe('what "OK" (match) actually means', () => {
  it('is decided on ROWS alone, to the row — no tolerance', () => {
    // Asked directly: does OK allow a margin? It must not.
    expect(classifyDiff(100, 100, 100)).toBe('match')
    expect(classifyDiff(100, 99, 100)).toBe('fewer')
    expect(classifyDiff(100, 101, 100)).toBe('more')
  })

  it('ignores patient counts entirely', () => {
    // They are shown in the table but take no part in the verdict: the same rows
    // spread over a different number of patients is still a match.
    expect(classifyDiff(50, 50, 50)).toBe('match')
  })
})

describe('sortTableCounts', () => {
  const TABLES = [
    { tableName: 'measurement', rowCount: 5_849_705 },
    { tableName: 'person', rowCount: 40_795 },
    { tableName: 'Device_exposure', rowCount: 0 },
    { tableName: 'observation', rowCount: 0 },
  ]

  it('sorts by row count, biggest first', () => {
    const out = sortTableCounts(TABLES, '', { by: 'rows', desc: true })
    expect(out.map((t) => t.tableName)).toEqual(['measurement', 'person', 'Device_exposure', 'observation'])
  })

  it('sorts by row count ascending', () => {
    const out = sortTableCounts(TABLES, '', { by: 'rows', desc: false })
    expect(out.map((t) => t.rowCount)).toEqual([0, 0, 40_795, 5_849_705])
  })

  it('breaks count ties by name, so the order is stable across renders', () => {
    // A partly-filled OMOP target has many empty tables; without the tiebreak
    // they came out in whatever order the export happened to produce.
    const out = sortTableCounts(TABLES, '', { by: 'rows', desc: true })
    expect(out.slice(2).map((t) => t.tableName)).toEqual(['Device_exposure', 'observation'])
  })

  it('sorts by name, case-insensitively as the user reads it', () => {
    const out = sortTableCounts(TABLES, '', { by: 'name', desc: false })
    // 'Device_exposure' sorts under D despite the capital, not before everything.
    expect(out.map((t) => t.tableName)).toEqual(['Device_exposure', 'measurement', 'observation', 'person'])
  })

  it('reverses the name order', () => {
    const out = sortTableCounts(TABLES, '', { by: 'name', desc: true })
    expect(out[0].tableName).toBe('person')
  })

  it('filters on a substring, ignoring case', () => {
    expect(sortTableCounts(TABLES, 'OBS', { by: 'name', desc: false }).map((t) => t.tableName))
      .toEqual(['observation'])
    expect(sortTableCounts(TABLES, 'exposure', { by: 'name', desc: false }).map((t) => t.tableName))
      .toEqual(['Device_exposure'])
  })

  it('ignores surrounding whitespace in the search', () => {
    expect(sortTableCounts(TABLES, '  person  ', { by: 'name', desc: false })).toHaveLength(1)
  })

  it('returns nothing when nothing matches', () => {
    expect(sortTableCounts(TABLES, 'zzz', { by: 'rows', desc: true })).toEqual([])
  })

  it('never mutates the input', () => {
    const input = [...TABLES]
    sortTableCounts(input, '', { by: 'name', desc: true })
    expect(input).toEqual(TABLES)
  })
})

describe('qualityFingerprint', () => {
  const run = (completedAt: string | undefined, status = 'success') =>
    ({ status, completedAt, startedAt: '2026-01-01T00:00:00Z' })

  it('is the newest completion stamp', () => {
    expect(qualityFingerprint([
      run('2026-08-01T10:00:00Z'),
      run('2026-08-09T18:30:00Z'),
      run('2026-08-05T09:00:00Z'),
    ])).toBe('2026-08-09T18:30:00Z')
  })

  it('does not depend on the array order', () => {
    // Run history order is not guaranteed across backends; a re-sorted list must
    // not read as a different fingerprint and force a recompute.
    const runs = [run('2026-08-01T10:00:00Z'), run('2026-08-09T18:30:00Z')]
    expect(qualityFingerprint(runs)).toBe(qualityFingerprint([...runs].reverse()))
  })

  it('is "none" when the pipeline has never run', () => {
    expect(qualityFingerprint([])).toBe('none')
  })

  it('ignores a run still in progress, which has no result yet', () => {
    expect(qualityFingerprint([run(undefined, 'running')])).toBe('none')
    expect(qualityFingerprint([
      run('2026-08-01T10:00:00Z'),
      run(undefined, 'running'),
    ])).toBe('2026-08-01T10:00:00Z')
  })

  it('counts a failed run: it may still have written rows', () => {
    // An ETL that errored halfway has changed the target, so the cached counts
    // are stale even though the run did not succeed.
    expect(qualityFingerprint([run('2026-08-02T08:00:00Z', 'error')])).toBe('2026-08-02T08:00:00Z')
  })

  it('changes after a new run, which is what invalidates the cache', () => {
    const before = qualityFingerprint([run('2026-08-01T10:00:00Z')])
    const after = qualityFingerprint([run('2026-08-01T10:00:00Z'), run('2026-08-10T12:00:00Z')])
    expect(after).not.toBe(before)
  })
})

describe('isQualityCacheUsable', () => {
  const cache = { targetDataSourceId: 'ds-target', fingerprint: 'fp-1' }

  it('accepts a cache matching both the target and the fingerprint', () => {
    expect(isQualityCacheUsable(cache, 'ds-target', 'fp-1')).toBe(true)
  })

  it('rejects a cache from before the last run', () => {
    expect(isQualityCacheUsable(cache, 'ds-target', 'fp-2')).toBe(false)
  })

  it('rejects a cache read from a DIFFERENT target database', () => {
    // The rows are counts read FROM the target; repointing the pipeline would
    // otherwise display the previous database's figures.
    expect(isQualityCacheUsable(cache, 'ds-other', 'fp-1')).toBe(false)
  })

  it('rejects an absent cache, and an unknown target', () => {
    expect(isQualityCacheUsable(undefined, 'ds-target', 'fp-1')).toBe(false)
    expect(isQualityCacheUsable(cache, undefined, 'fp-1')).toBe(false)
  })

  it('rejects a cache written before these fields existed', () => {
    expect(isQualityCacheUsable({}, 'ds-target', 'fp-1')).toBe(false)
  })
})
