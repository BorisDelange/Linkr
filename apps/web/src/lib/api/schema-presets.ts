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

  getById: async (presetId) => {
    const all = await apiRequest<CustomSchemaPreset[]>('/schema-presets')
    return all.find((p) => p.presetId === presetId)
  },

  save: async (preset) => {
    await apiRequest(`/schema-presets/${preset.presetId}`, {
      method: 'PUT',
      body: JSON.stringify(preset),
    })
  },

  delete: async (presetId) => {
    await apiRequest(`/schema-presets/${presetId}`, { method: 'DELETE' })
  },
}
