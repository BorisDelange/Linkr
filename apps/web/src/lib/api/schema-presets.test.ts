import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomSchemaPreset } from '@/types'

const apiRequest = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiRequest }))

const { apiSchemaPresetStorage } = await import('./schema-presets')

/** Two rows whose `id` and `presetId` differ — the state the rename creates. */
const ROWS = [
  { id: 'uuid-a', presetId: 'omop-cdm-5-4', entityId: 'omop-cdm-5-4' },
  { id: 'uuid-b', presetId: 'mimic-iv', entityId: 'mimic-iv' },
] as unknown as CustomSchemaPreset[]

describe('apiSchemaPresetStorage', () => {
  beforeEach(() => {
    apiRequest.mockReset()
    apiRequest.mockResolvedValue(ROWS)
  })

  it('resolves by id', async () => {
    expect((await apiSchemaPresetStorage.getById('uuid-b'))?.presetId).toBe('mimic-iv')
  })

  it('still resolves by presetId', async () => {
    // URLs, exports and the catalog all still hand over a presetId while the two
    // identities coexist; refusing them would break every one of those callers.
    expect((await apiSchemaPresetStorage.getById('omop-cdm-5-4'))?.id).toBe('uuid-a')
  })

  it('returns undefined for an unknown id', async () => {
    expect(await apiSchemaPresetStorage.getById('nope')).toBeUndefined()
  })

  it('deletes through the route key, given an id', async () => {
    // The API addresses rows by preset_id: passing `id` straight through would
    // 404, or hit another row once the two diverge.
    await apiSchemaPresetStorage.delete('uuid-a')
    expect(apiRequest).toHaveBeenCalledWith('/schema-presets/omop-cdm-5-4', { method: 'DELETE' })
  })

  it('deletes given a presetId too', async () => {
    await apiSchemaPresetStorage.delete('mimic-iv')
    expect(apiRequest).toHaveBeenCalledWith('/schema-presets/mimic-iv', { method: 'DELETE' })
  })

  it('does not call DELETE for an unknown id', async () => {
    await apiSchemaPresetStorage.delete('nope')
    expect(apiRequest).toHaveBeenCalledTimes(1) // the lookup only
  })
})
