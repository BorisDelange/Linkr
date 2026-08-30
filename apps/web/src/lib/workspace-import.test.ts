import { describe, it, expect } from 'vitest'
import { importedDatabaseLineage } from './workspace-import'

const REMOTE = { url: 'https://framagit.org/g/mimic-iv-demo', branch: 'main' }

describe('importedDatabaseLineage', () => {
  it('keeps the lineage the manifest publishes', () => {
    expect(importedDatabaseLineage({ lineageId: 'lin-1' }, false)).toEqual({ lineageId: 'lin-1' })
  })

  it('mints one for an unlinked database, which no clone will ever identify', () => {
    const { lineageId } = importedDatabaseLineage({}, false)
    expect(lineageId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('leaves a git-linked pointer without one, so the clone supplies the published id', () => {
    // The regression: minting here beat the clone to it (the clone keeps what is
    // stored), pinning a local uuid the catalog could not match against its own
    // entry — the database read "Install" however many times it was installed.
    expect(importedDatabaseLineage({ gitRemoteConfig: REMOTE }, false)).toEqual({})
  })

  it('still takes a linked pointer\'s own lineage when it publishes one', () => {
    expect(importedDatabaseLineage({ lineageId: 'lin-1', gitRemoteConfig: REMOTE }, false))
      .toEqual({ lineageId: 'lin-1' })
  })

  it('mints for a duplicate and records what it was copied from', () => {
    const out = importedDatabaseLineage({ lineageId: 'lin-1', gitRemoteConfig: REMOTE }, true)
    expect(out.parentLineageId).toBe('lin-1')
    expect(out.lineageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.lineageId).not.toBe('lin-1')
  })

  it('mints for a duplicate of a database that had no lineage', () => {
    const out = importedDatabaseLineage({}, true)
    expect(out.lineageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.parentLineageId).toBeUndefined()
  })
})
