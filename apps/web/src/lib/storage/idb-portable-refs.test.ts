import { describe, it, expect } from 'vitest'
import { pointerFor, backfillRows, linkedRefsFor } from './idb-portable-refs'

// The repair that saves links configured before pointers existed. It must fill
// blanks and nothing else: a pointer already there records the user's real
// choice, and an id that resolves to nothing must not become a guess — either
// mistake silently repoints an entity at the wrong database.
describe('pointerFor', () => {
  it('carries lineage, slug and label', () => {
    expect(pointerFor({ id: 'a', lineageId: 'lin', entityId: 'mimic', name: { en: 'MIMIC' } }))
      .toEqual({ lineageId: 'lin', entityId: 'mimic', label: { en: 'MIMIC' } })
  })

  it('omits what the row does not have', () => {
    expect(pointerFor({ id: 'a', lineageId: 'lin' })).toEqual({ lineageId: 'lin' })
    expect(pointerFor({ id: 'a', entityId: 'mimic' })).toEqual({ entityId: 'mimic' })
  })

  it('refuses a row with no identity to point at', () => {
    // Neither lineage nor slug is something the receiving instance could
    // resolve, so a pointer here would be noise that never matches.
    expect(pointerFor({ id: 'a', name: { en: 'X' } })).toBeUndefined()
    expect(pointerFor(undefined)).toBeUndefined()
  })
})

describe('backfillRows', () => {
  const SPECS = [
    { store: 'etl_pipelines', idField: 'sourceDataSourceId', refField: 'sourceDataSourceRef', targets: 'data_sources' },
    { store: 'etl_pipelines', idField: 'mappingProjectId', refField: 'mappingProjectRef', targets: 'mapping_projects' },
  ]
  const targets = {
    data_sources: [{ id: 'db-1', lineageId: 'db-lin', entityId: 'mimic', name: { en: 'MIMIC' } }],
    mapping_projects: [{ id: 'mp-1', lineageId: 'mp-lin', entityId: 'adult-icu' }],
  }

  it('derives the pointer of a link that has an id but none', () => {
    const rows = [{ id: 'p1', sourceDataSourceId: 'db-1', mappingProjectId: 'mp-1' }]
    expect(backfillRows(rows, SPECS, targets)).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sourceDataSourceRef: { lineageId: 'db-lin', entityId: 'mimic', label: { en: 'MIMIC' } },
      mappingProjectRef: { lineageId: 'mp-lin', entityId: 'adult-icu' },
    })
  })

  it('never overwrites a pointer already stamped', () => {
    // That one records the choice the user actually made, possibly pointing
    // somewhere the stale local id no longer does.
    const kept = { lineageId: 'chosen-by-hand' }
    const rows = [{ id: 'p1', sourceDataSourceId: 'db-1', sourceDataSourceRef: kept }]
    expect(backfillRows(rows, SPECS, targets)).toHaveLength(0)
    expect(rows[0].sourceDataSourceRef).toBe(kept)
  })

  it('leaves an id that resolves to nothing alone', () => {
    // A deleted database, or a foreign UUID from an import predating pointers:
    // there is nothing to derive from, and inventing one would be a guess.
    const rows = [{ id: 'p1', sourceDataSourceId: 'db-gone' }]
    expect(backfillRows(rows, SPECS, targets)).toHaveLength(0)
    expect(rows[0]).not.toHaveProperty('sourceDataSourceRef')
  })

  it('skips a link that was never configured', () => {
    const rows = [{ id: 'p1', sourceDataSourceId: '' }, { id: 'p2' }]
    expect(backfillRows(rows, SPECS, targets)).toHaveLength(0)
  })
})

describe('linkedRefsFor', () => {
  const databases = [
    { id: 'db-1', lineageId: 'lin-1', entityId: 'mimic' },
    { id: 'db-2', lineageId: 'lin-2' },
  ]

  it('keeps one entry per id, in order', () => {
    expect(linkedRefsFor(['db-1', 'db-2'], databases)).toEqual([
      { lineageId: 'lin-1', entityId: 'mimic' },
      { lineageId: 'lin-2' },
    ])
  })

  it('placeholds an unresolvable entry rather than dropping it', () => {
    // Dropping would shift every later pointer up one slot, silently moving a
    // project's link onto a different database than the one it named.
    expect(linkedRefsFor(['db-gone', 'db-2'], databases)).toEqual([
      {},
      { lineageId: 'lin-2' },
    ])
  })

  it('returns nothing when not one id resolves', () => {
    expect(linkedRefsFor(['db-gone'], databases)).toBeUndefined()
    expect(linkedRefsFor([], databases)).toBeUndefined()
    expect(linkedRefsFor(undefined, databases)).toBeUndefined()
  })
})
