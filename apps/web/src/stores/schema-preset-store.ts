import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { stampAuthored, stampLineage } from '@/stores/app-store'
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
    const rows = workspaceId
      ? await storage.schemaPresets.getByWorkspace(workspaceId)
      : await storage.schemaPresets.getAll()
    // Also validated on read: an imported ZIP, a cloned repo, a pull and the
    // seed loader all write presets straight to storage without coming through
    // savePreset, and a preset's mapping ends up interpolated into SQL.
    const presets = rows.map((p) => ({ ...p, mapping: sanitizeSchemaMapping(p.mapping) }))
    set({ presets, loaded: true })
  },

  getWorkspacePresets: (workspaceId) =>
    get().presets.filter((p) => p.workspaceId === workspaceId),

  savePreset: async (preset) => {
    // The one door every preset comes through — a manual save, an imported ZIP,
    // a cloned repo, the seed loader. Its table/column names are interpolated
    // straight into SQL downstream, so they are validated here rather than at
    // each of the ~100 interpolation sites.
    const safe = { ...preset, mapping: sanitizeSchemaMapping(preset.mapping) }
    await getStorage().schemaPresets.save(safe)
    set((s) => {
      const exists = s.presets.some((p) => p.presetId === safe.presetId)
      return {
        presets: exists
          ? s.presets.map((p) => (p.presetId === safe.presetId ? safe : p))
          : [...s.presets, safe],
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
  // Same rule for the lineage: minted once, then carried unchanged. It is the
  // preset's cross-instance identity, so re-minting it on every save would make
  // every other instance holding a copy stop recognising it. A duplicate does NOT
  // come through here with `existing` — it calls buildForkedSchemaPreset below.
  const lineage = existing?.lineageId
    ? { lineageId: existing.lineageId, parentLineageId: existing.parentLineageId }
    : stampLineage()
  return {
    presetId,
    mapping: { ...mapping, presetId },
    gitRemoteConfig: existing?.gitRemoteConfig,
    version: existing?.version ?? '0.1.0',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    workspaceId: workspaceId ?? existing?.workspaceId,
    ...authored,
    ...lineage,
  }
}

/**
 * Lineage for a preset created as a *copy* of another (duplicate on import, or an
 * install that kept both). A fork is a new work: it mints its own lineageId and
 * records where it came from in parentLineageId — a weak reference, since the source
 * may not exist on this instance. Sharing the source's lineageId instead would make
 * the two copies claim to be the same published entity.
 */
export function forkedLineage(source: CustomSchemaPreset | undefined) {
  return { ...stampLineage(), ...(source?.lineageId ? { parentLineageId: source.lineageId } : {}) }
}
