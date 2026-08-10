import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { stampAuthored } from '@/stores/app-store'
import type { CustomSchemaPreset, GitRemoteConfig, SchemaMapping } from '@/types'

interface SchemaPresetState {
  presets: CustomSchemaPreset[]
  loaded: boolean

  loadPresets: (workspaceId?: string) => Promise<void>
  getWorkspacePresets: (workspaceId: string) => CustomSchemaPreset[]
  savePreset: (preset: CustomSchemaPreset) => Promise<void>
  deletePreset: (presetId: string) => Promise<void>
  setGitRemote: (presetId: string, config: GitRemoteConfig | null) => Promise<void>
  updatePreset: (presetId: string, changes: Partial<CustomSchemaPreset>) => Promise<void>
}

/**
 * Schema presets have no per-item id/name of their own: they key on `presetId`
 * and their label lives in `mapping.presetLabel`. This store holds the loaded
 * set so both the list page and the global header badge stay in sync when a
 * preset is renamed, git-linked, or deleted.
 */
export const useSchemaPresetStore = create<SchemaPresetState>((set, get) => ({
  presets: [],
  loaded: false,

  loadPresets: async (workspaceId) => {
    const storage = getStorage()
    const presets = workspaceId
      ? await storage.schemaPresets.getByWorkspace(workspaceId)
      : await storage.schemaPresets.getAll()
    set({ presets, loaded: true })
  },

  getWorkspacePresets: (workspaceId) =>
    get().presets.filter((p) => p.workspaceId === workspaceId),

  savePreset: async (preset) => {
    await getStorage().schemaPresets.save(preset)
    set((s) => {
      const exists = s.presets.some((p) => p.presetId === preset.presetId)
      return {
        presets: exists
          ? s.presets.map((p) => (p.presetId === preset.presetId ? preset : p))
          : [...s.presets, preset],
      }
    })
  },

  deletePreset: async (presetId) => {
    await getStorage().schemaPresets.delete(presetId)
    set((s) => ({ presets: s.presets.filter((p) => p.presetId !== presetId) }))
  },

  setGitRemote: async (presetId, config) => {
    await get().updatePreset(presetId, { gitRemoteConfig: config ?? undefined })
  },

  updatePreset: async (presetId, changes) => {
    const existing = get().presets.find((p) => p.presetId === presetId)
    if (!existing) return
    await get().savePreset({ ...existing, ...changes, updatedAt: new Date().toISOString() })
  },
}))

/** Rebuild a CustomSchemaPreset when saving an edited mapping, preserving timestamps. */
export function buildSchemaPreset(
  presetId: string,
  mapping: SchemaMapping,
  existing: CustomSchemaPreset | undefined,
  workspaceId: string | undefined,
): CustomSchemaPreset {
  const now = new Date().toISOString()
  // Stamp the creator on first save; keep the original author on update.
  const authored = existing
    ? { createdById: existing.createdById, createdBy: existing.createdBy, createdByDetails: existing.createdByDetails }
    : stampAuthored()
  return {
    presetId,
    mapping: { ...mapping, presetId },
    gitRemoteConfig: existing?.gitRemoteConfig,
    version: existing?.version ?? '0.1.0',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    workspaceId: workspaceId ?? existing?.workspaceId,
    ...authored,
  }
}
