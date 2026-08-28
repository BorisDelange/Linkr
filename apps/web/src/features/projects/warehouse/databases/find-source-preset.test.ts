import { describe, it, expect } from 'vitest'
import type { CustomSchemaPreset, DataSource, SchemaMapping } from '@/types'
import { findSourcePreset } from './AddDatabaseDialog'

const preset = (over: Partial<CustomSchemaPreset>): CustomSchemaPreset => ({
  id: 'local-uuid',
  entityId: 'omop-cdm-5-4',
  mapping: {} as SchemaMapping,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
}) as CustomSchemaPreset

const db = (over: Partial<DataSource>) => over as Pick<DataSource, 'schemaSource' | 'schemaMapping'>

describe('findSourcePreset', () => {
  it('resolves an imported database through its schemaSource lineage', () => {
    // The regression: a database imported with its workspace carries the ORIGIN
    // instance's presetId in the copied mapping. Nothing here has that id, so the
    // schema field read empty for a database that is in fact mapped — and there
    // was no way to re-link it short of deleting the database.
    const installed = preset({ id: 'here-1', presetId: 'custom-2ff406f1', lineageId: 'lin-omop' })
    const found = findSourcePreset(
      db({
        schemaSource: { lineageId: 'lin-omop' },
        schemaMapping: { presetId: 'a3e5eeb1-from-another-instance' } as SchemaMapping,
      }),
      [preset({ id: 'other', lineageId: 'lin-mimic' }), installed],
    )
    expect(found).toBe(installed)
  })

  it('falls back to presetId for a database built on this instance', () => {
    // Databases created before provenance was recorded have no schemaSource at
    // all; their mapping's presetId is a valid LOCAL key.
    const installed = preset({ id: 'here-1', presetId: 'custom-2ff406f1' })
    const found = findSourcePreset(
      db({ schemaMapping: { presetId: 'custom-2ff406f1' } as SchemaMapping }),
      [installed],
    )
    expect(found).toBe(installed)
  })

  it('matches presetId against the option key (id) too', () => {
    const installed = preset({ id: 'key-used-as-option-value', presetId: 'legacy' })
    const found = findSourcePreset(
      db({ schemaMapping: { presetId: 'key-used-as-option-value' } as SchemaMapping }),
      [installed],
    )
    expect(found).toBe(installed)
  })

  it('prefers lineage over a presetId that matches a DIFFERENT preset', () => {
    // Both could match; lineage is the identity that survives crossing instances,
    // so a colliding local key must not win over it.
    const byLineage = preset({ id: 'a', presetId: 'shared-key', lineageId: 'lin-omop' })
    const byPresetId = preset({ id: 'b', presetId: 'shared-key', lineageId: 'lin-other' })
    const found = findSourcePreset(
      db({
        schemaSource: { lineageId: 'lin-omop' },
        schemaMapping: { presetId: 'shared-key' } as SchemaMapping,
      }),
      [byPresetId, byLineage],
    )
    expect(found).toBe(byLineage)
  })

  it('falls back to presetId when the lineage names a preset that is not installed', () => {
    // A schema repo nobody installed here is the normal case, not an edge one.
    const installed = preset({ id: 'here-1', presetId: 'custom-2ff406f1' })
    const found = findSourcePreset(
      db({
        schemaSource: { lineageId: 'lin-absent' },
        schemaMapping: { presetId: 'custom-2ff406f1' } as SchemaMapping,
      }),
      [installed],
    )
    expect(found).toBe(installed)
  })

  it('returns undefined for an unmapped database', () => {
    expect(findSourcePreset(db({}), [preset({})])).toBeUndefined()
    // 'none' is an explicit opt-out, not a key to look up.
    expect(
      findSourcePreset(db({ schemaMapping: { presetId: 'none' } as SchemaMapping }), [preset({ presetId: 'none' })]),
    ).toBeUndefined()
  })
})
