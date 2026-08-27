import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { AuthoringValue } from '@/components/ui/authoring-fields'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { stampAuthored, stampLineage } from '@/stores/app-store'
import type { CustomSchemaPreset, GitRemoteConfig, ProjectBadge, SchemaMapping } from '@/types'

interface SchemaPresetState {
  presets: CustomSchemaPreset[]
  loaded: boolean

  loadPresets: (workspaceId?: string) => Promise<void>
  getWorkspacePresets: (workspaceId: string) => CustomSchemaPreset[]
  savePreset: (preset: CustomSchemaPreset) => Promise<void>
  /** All three accept a preset's `id` or its retired `presetId`. */
  deletePreset: (key: string) => Promise<void>
  setGitRemote: (key: string, config: GitRemoteConfig | null) => Promise<void>
  updatePreset: (key: string, changes: Partial<CustomSchemaPreset>) => Promise<void>
}

/**
 * A preset's label lives in `mapping.presetLabel` rather than at the top level,
 * so it has no `name` of its own. This store holds the loaded set so both the
 * list page and the global header badge stay in sync when a preset is renamed,
 * git-linked, or deleted.
 *
 * Every lookup below matches `id` OR the retired `presetId`: callers hold either
 * one while `presetId` is being retired — a bookmarked URL, an export tree, a
 * catalog entry. `matches` is the single place that resolution lives.
 */
const matches = (preset: CustomSchemaPreset, key: string): boolean =>
  preset.id === key || preset.presetId === key

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
      const key = safe.id ?? safe.presetId
      const exists = s.presets.some((p) => matches(p, key))
      return {
        presets: exists
          ? s.presets.map((p) => (matches(p, key) ? safe : p))
          : [...s.presets, safe],
      }
    })
  },

  deletePreset: async (key) => {
    await getStorage().schemaPresets.delete(key)
    set((s) => ({ presets: s.presets.filter((p) => !matches(p, key)) }))
  },

  setGitRemote: async (key, config) => {
    await get().updatePreset(key, { gitRemoteConfig: config ?? undefined })
  },

  updatePreset: async (key, changes) => {
    const existing = get().presets.find((p) => matches(p, key))
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
  /** Metadata set by the create/edit form. Absent keys keep the existing value. */
  meta?: { version?: string; badges?: ProjectBadge[]; authoring?: Partial<AuthoringValue> },
): CustomSchemaPreset {
  const now = new Date().toISOString()
  // Stamp the creator on first save; keep the original author on update, unless the
  // Attribution tab re-attributed it — the same contract as every other entity's
  // edit dialog, which passes only the keys the user actually unlocked.
  const authored = {
    ...(existing
      ? { createdById: existing.createdById, createdBy: existing.createdBy, createdByDetails: existing.createdByDetails }
      : stampAuthored()),
    ...meta?.authoring,
  }
  // Same rule for the lineage: minted once, then carried unchanged. It is the
  // preset's cross-instance identity, so re-minting it on every save would make
  // every other instance holding a copy stop recognising it. A duplicate does NOT
  // come through here with `existing` — it calls buildForkedSchemaPreset below.
  const lineage = existing?.lineageId
    ? { lineageId: existing.lineageId, parentLineageId: existing.parentLineageId }
    : stampLineage()
  return {
    presetId,
    // Minted once, then carried unchanged — same contract as the lineage above.
    // `id` is the uuid that will become the key; `entityId` the readable slug
    // the UI and the URL will show. Both are written from now on so the
    // migration that switches the key has populated values to move to.
    // See docs/planning/schema-preset-identity-plan.md.
    id: existing?.id ?? crypto.randomUUID(),
    entityId: existing?.entityId ?? presetId,
    mapping: { ...mapping, presetId },
    gitRemoteConfig: existing?.gitRemoteConfig,
    // Carried, not dropped: this function rebuilds the whole record, so a field it
    // forgets is erased on every save. Editing a preset's mapping used to wipe its
    // README and licence that way.
    readme: existing?.readme,
    license: existing?.license,
    // Absent on a preset that has never been re-attributed: the export then inherits
    // the parent workspace's org (attachEntityOrganization). Once set here it wins,
    // which is what makes the choice survive the next export. `authored` spreads
    // after, so a re-attribution from the Attribution tab overrides it.
    organization: existing?.organization,
    version: meta?.version ?? existing?.version ?? '0.1.0',
    badges: meta?.badges ?? existing?.badges,
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
