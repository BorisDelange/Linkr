import { describe, expect, it } from 'vitest'
import { freshId, idOf, isSameEntity, type ExistingRow } from './install'
import type { CatalogEntry } from './types'

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'e1',
    type: 'etl-pipeline',
    name: { en: 'Pipeline' },
    git: { url: 'https://gitlab.com/org/pipeline', branch: 'main' },
    ...overrides,
  } as CatalogEntry
}

describe('isSameEntity', () => {
  it('matches on a shared lineageId', () => {
    const row: ExistingRow = { lineageId: 'lin-1' }
    expect(isSameEntity(row, entry({ lineageId: 'lin-1' }))).toBe(true)
  })

  it('matches on the same git remote (normalised)', () => {
    const row: ExistingRow = { gitRemoteConfig: { url: 'https://gitlab.com/org/pipeline/-/tree/main' } }
    expect(isSameEntity(row, entry())).toBe(true)
  })

  it('does NOT match when only the id would collide (no lineage, no remote)', () => {
    // The dangerous case: an unrelated local row that merely shares the declared id.
    const row: ExistingRow = { name: { en: "Victim's pipeline" } }
    expect(isSameEntity(row, entry())).toBe(false)
  })

  it('does NOT match a different lineage or a different remote', () => {
    expect(isSameEntity({ lineageId: 'other' }, entry({ lineageId: 'lin-1' }))).toBe(false)
    expect(
      isSameEntity({ gitRemoteConfig: { url: 'https://gitlab.com/org/OTHER' } }, entry()),
    ).toBe(false)
  })
})

describe('idOf', () => {
  // Regression: buildProjectZip writes `projectId` and deliberately drops `uid`
  // (the local PK churns the diff). Reading only `uid` returned null, the caller
  // fell back to a random uuid, and every re-install of the same project created a
  // duplicate instead of being recognised as already installed.
  it('reads a project id from projectId', () => {
    expect(idOf('project', { projectId: 'icu-activity-dashboard' })).toBe('icu-activity-dashboard')
  })

  it('still reads uid, for repos exported before the switch', () => {
    expect(idOf('project', { uid: 'legacy-uid' })).toBe('legacy-uid')
  })

  it('prefers projectId when a repo carries both', () => {
    expect(idOf('project', { projectId: 'portable', uid: 'local-pk' })).toBe('portable')
  })

  it('reads presetId for a schema preset and id for everything else', () => {
    expect(idOf('schema-preset', { presetId: 'omop-cdm-5-4' })).toBe('omop-cdm-5-4')
    expect(idOf('etl-pipeline', { id: 'pipe-1' })).toBe('pipe-1')
  })

  it('returns null when the id is missing or not a non-empty string', () => {
    expect(idOf('project', {})).toBeNull()
    expect(idOf('project', { projectId: '' })).toBeNull()
    expect(idOf('etl-pipeline', { id: 42 })).toBeNull()
  })
})

describe('freshId', () => {
  // A preset's id is its user-facing Identifier (it fills that field and rides in the
  // URL), so a duplicate install used to put a 36-char uuid in front of the user.
  it('mints a short readable slug for a schema preset', () => {
    const id = freshId('schema-preset')
    expect(id).toMatch(/^custom-[0-9a-f]{8}$/)
  })

  it('keeps an opaque uuid for the types whose id the user never sees', () => {
    for (const type of ['project', 'etl-pipeline', 'mapping-project'] as const) {
      expect(freshId(type)).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 50 }, () => freshId('schema-preset')))
    expect(ids.size).toBe(50)
  })
})
