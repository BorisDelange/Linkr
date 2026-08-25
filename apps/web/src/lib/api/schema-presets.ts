import { apiRequest } from '@/lib/api-client'
import type { SchemaPresetStorage } from '@/lib/storage'
import type { CustomSchemaPreset } from '@/types'

/** Server-mode implementation of SchemaPresetStorage backed by the FastAPI API. */
export const apiSchemaPresetStorage: SchemaPresetStorage = {
  getAll: () => apiRequest<CustomSchemaPreset[]>('/schema-presets'),

  getByWorkspace: async (workspaceId) => {
    const all = await apiRequest<CustomSchemaPreset[]>('/schema-presets')
    return all.filter((p) => p.workspaceId === workspaceId)
  },

  // Resolves an `id` or a `presetId`: the store is keyed on `id` client-side
  // since v41, while the API routes still address rows by `preset_id` (the
  // server PK moves in a later step). Callers hold either while the rename
  // works through — see docs/planning/schema-preset-identity-plan.md.
  getById: async (id) => {
    const all = await apiRequest<CustomSchemaPreset[]>('/schema-presets')
    return all.find((p) => p.id === id) ?? all.find((p) => p.presetId === id)
  },

  save: async (preset) => {
    await apiRequest(`/schema-presets/${preset.presetId}`, {
      method: 'PUT',
      body: JSON.stringify(preset),
    })
  },

  delete: async (id) => {
    // The route keys on preset_id, so resolve first: passing an `id` straight
    // through would 404 (or, worse, hit a different row) once the two differ.
    const all = await apiRequest<CustomSchemaPreset[]>('/schema-presets')
    const row = all.find((p) => p.id === id) ?? all.find((p) => p.presetId === id)
    if (row) await apiRequest(`/schema-presets/${row.presetId}`, { method: 'DELETE' })
  },
}
