/**
 * The v41 IndexedDB upgrade rekeys `schema_presets` from `presetId` to `id`.
 *
 * A keyPath cannot be altered in place, so the store is dropped and recreated
 * and every row copied across — which means a row the transform gets wrong is a
 * row the user loses. This covers what each row becomes; the surrounding
 * ordering (read, drop, recreate, all synchronous inside the upgrade
 * transaction) needs a real IndexedDB and is not exercised here.
 */
import { describe, expect, it } from 'vitest'
import { rekeyPresetOnId } from './idb-storage'
import type { CustomSchemaPreset } from '@/types'

const preset = (over: Partial<CustomSchemaPreset>): CustomSchemaPreset => ({
  mapping: { presetId: 'x', presetLabel: { en: 'X' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as CustomSchemaPreset)

describe('v41 upgrade: rekey schema presets on id', () => {
  it('gives a pre-split row both identities, taken from presetId', () => {
    // The row the migration exists for: written before `id`/`entityId` existed.
    const out = rekeyPresetOnId(preset({ presetId: 'omop-cdm-5-4' }))
    expect(out.id).toBe('omop-cdm-5-4')
    expect(out.entityId).toBe('omop-cdm-5-4')
    // Not a fresh uuid: git working trees, README attachment owners and
    // git_sync_state already point at that value, and the server migration
    // backfills the same way. Minting here would orphan all of them.
    expect(out.presetId).toBe('omop-cdm-5-4')
  })

  it('leaves a row that already carries both alone', () => {
    const out = rekeyPresetOnId(preset({
      presetId: 'omop-cdm-5-4',
      id: '4c82109e-d8ef-43fd-8779-0c7938eccf3a',
      entityId: 'omop-cdm-5-4',
    }))
    expect(out.id).toBe('4c82109e-d8ef-43fd-8779-0c7938eccf3a')
    expect(out.entityId).toBe('omop-cdm-5-4')
  })

  it('fills only the missing half', () => {
    // A row written between the two steps has an id but no slug, or the reverse.
    expect(rekeyPresetOnId(preset({ presetId: 'p', id: 'uuid-1' })).entityId).toBe('p')
    expect(rekeyPresetOnId(preset({ presetId: 'p', entityId: 'slug' })).id).toBe('p')
  })

  it('always produces an id, since the store keys on it', () => {
    // `put` throws on a value missing the keyPath, and the row is lost with the
    // dropped store — there is no second chance inside an upgrade transaction.
    for (const row of [
      preset({ presetId: 'p' }),
      preset({ presetId: 'p', id: 'u' }),
      preset({ presetId: 'p', entityId: 'e' }),
      preset({ presetId: 'p', id: 'u', entityId: 'e' }),
    ]) {
      expect(rekeyPresetOnId(row).id).toBeTruthy()
    }
  })

  it('keeps every other field verbatim', () => {
    // The copy must not quietly drop what it does not understand: a mapping, a
    // git link and the workspace are what make the preset usable at all.
    const row = preset({
      presetId: 'p',
      workspaceId: 'ws-1',
      version: '2.1.0',
      lineageId: 'lin-1',
      gitRemoteConfig: { url: 'https://example.org/x.git', branch: 'main' },
      readme: { en: '# Docs' },
    })
    const out = rekeyPresetOnId(row)
    expect(out.workspaceId).toBe('ws-1')
    expect(out.version).toBe('2.1.0')
    expect(out.lineageId).toBe('lin-1')
    expect(out.gitRemoteConfig?.url).toBe('https://example.org/x.git')
    expect(out.readme).toEqual({ en: '# Docs' })
    expect(out.mapping).toEqual(row.mapping)
  })

  it('does not mutate the row it was given', () => {
    // The upgrade reads rows out of the old store and writes them into the new
    // one; mutating in place would be a side effect on a live transaction.
    const row = preset({ presetId: 'p' })
    rekeyPresetOnId(row)
    expect(row.id).toBeUndefined()
    expect(row.entityId).toBeUndefined()
  })
})
