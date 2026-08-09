import { describe, expect, it } from 'vitest'
import { isSameEntity, type ExistingRow } from './install'
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
