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

  // Resolves an `id` or a `presetId`: the row is keyed on `id` on both sides
  // now, but a URL, an export tree or a catalog entry may still hold the
  // retired `presetId` — see docs/planning/schema-preset-identity-plan.md.
  getById: async (id) => {
    const all = await apiRequest<CustomSchemaPreset[]>('/schema-presets')
    return all.find((p) => p.id === id) ?? all.find((p) => p.presetId === id)
  },

  save: async (preset) => {
    // Addressed by `id`, like every other entity's route. A preset written
    // before the split has none stored, so `presetId` still stands in.
    await apiRequest(`/schema-presets/${preset.id ?? preset.presetId}`, {
      method: 'PUT',
      body: JSON.stringify(preset),
    })
  },

  delete: async (id) => {
    // The route resolves either identity, so the id can go straight through.
    await apiRequest(`/schema-presets/${id}`, { method: 'DELETE' })
  },
}
