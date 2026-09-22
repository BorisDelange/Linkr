/**
 * Two rules that keep a front-only query from racing its own mount.
 *
 * `shouldGuardMount` decides whether queryDataSource waits for the source to be
 * in DuckDB. Callers used to each call ensureMounted() themselves, and the ones
 * that forgot raced the mount on a fresh load: the schema was not there yet, so
 * the page failed with "No catalog + schema named ds_…" and stayed empty until
 * a reload.
 *
 * `isAttachedCatalog` decides how a remount cleans up. Trusting module memory
 * instead of the catalog is what made a second mount fail with "database with
 * name ds_… already exists": the source was attached, we had forgotten it, so
 * we ran DROP SCHEMA (which detaches nothing) and then ATTACHed on top.
 */
import { describe, expect, it } from 'vitest'
import { shouldGuardMount, isAttachedCatalog } from './mount-guard'

describe('shouldGuardMount', () => {
  it('guards an ordinary data source', () => {
    expect(shouldGuardMount('ds1', true)).toBe(true)
  })

  it('does not guard a mapping project file source', () => {
    // `filesrc_<projectId>` is not a data-source row: mounting it would throw
    // "not found" on a query that has nothing to mount in the first place.
    expect(shouldGuardMount('filesrc_p1', true)).toBe(false)
  })

  it('does nothing when no guard was injected (tests, early boot)', () => {
    expect(shouldGuardMount('ds1', false)).toBe(false)
  })
})

describe('isAttachedCatalog', () => {
  it('detaches what the catalog reports, even when unremembered', () => {
    // The set is filled only once a mount succeeds, so a mount that failed
    // after its ATTACH leaves a database we no longer track.
    expect(isAttachedCatalog({ remembered: false, catalogRows: 1 })).toBe(true)
  })

  it('drops the schema when the catalog holds no such database', () => {
    expect(isAttachedCatalog({ remembered: false, catalogRows: 0 })).toBe(false)
  })

  it('believes the catalog over stale memory', () => {
    expect(isAttachedCatalog({ remembered: true, catalogRows: 0 })).toBe(false)
  })

  it('falls back to memory when the catalog cannot be read', () => {
    expect(isAttachedCatalog({ remembered: true, catalogRows: undefined })).toBe(true)
    expect(isAttachedCatalog({ remembered: false, catalogRows: undefined })).toBe(false)
  })
})
