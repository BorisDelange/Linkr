import { describe, it, expect } from 'vitest'
import { importedDatabaseLineage, importedPresetLanding } from './workspace-import'

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

describe('importedPresetLanding', () => {
  const WS = 'ws-1'
  /** Deterministic ids, so a test can tell a minted key from a reused one. */
  const counter = () => { let n = 0; return () => `minted-${++n}` }

  it('lands on the row its lineage already wrote in this workspace', () => {
    // resolveByLineage did the scoping; a pointer WITH a lineage trusts it.
    const id = importedPresetLanding(
      { id: 'mimic-iv', lineageId: 'lin-1' }, 'mimic-iv', 'local-abc', null, WS, false, counter(),
    )
    expect(id).toBe('local-abc')
  })

  it('takes the key when no preset holds it', () => {
    const id = importedPresetLanding({ id: 'mimic-iv' }, 'mimic-iv', 'ignored', null, WS, false, counter())
    expect(id).toBe('mimic-iv')
  })

  it('reuses the row this workspace already has under that key', () => {
    const id = importedPresetLanding(
      { id: 'mimic-iv' }, 'mimic-iv', 'ignored', { workspaceId: WS }, WS, false, counter(),
    )
    expect(id).toBe('mimic-iv')
  })

  it('leaves another workspace\'s preset alone and mints instead', () => {
    // The regression: importing a second workspace that publishes the same four
    // presets (MIMIC-IV, OMOP 5.4, …) claimed the first workspace's keys, and the
    // delete-then-save deleted its presets outright. Presets are workspace-scoped
    // like every other child — two workspaces may each hold a `mimic-iv`.
    const id = importedPresetLanding(
      { id: 'mimic-iv' }, 'mimic-iv', 'ignored', { workspaceId: 'ws-2' }, WS, false, counter(),
    )
    expect(id).toBe('minted-1')
  })

  it('always mints on a duplicate', () => {
    const id = importedPresetLanding(
      { id: 'mimic-iv', lineageId: 'lin-1' }, 'mimic-iv', 'local-abc', { workspaceId: WS }, WS, true, counter(),
    )
    expect(id).toBe('minted-1')
  })
})
