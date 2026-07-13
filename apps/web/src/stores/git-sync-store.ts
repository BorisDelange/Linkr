/**
 * Git sync (push-only) for the Versioning "Git repository" tab, server mode only.
 *
 * The backend versions the export tree, so each op builds the entity's export ZIP
 * locally (reusing buildProjectZip / buildWorkspaceZip) and uploads it. This store
 * holds the transient UI state (pending files, branches, busy flags); the persisted
 * remote link still lives on the entity via the existing versioning stores.
 */
import { create } from 'zustand'
import { buildProjectZip, buildWorkspaceZip } from '@/lib/entity-io'
import { getStorage } from '@/lib/storage'
import { defaultSelectedPaths } from '@/lib/git-file-classify'
import { resolveLfsPaths } from '@/lib/git-lfs'
import { toGitError } from '@/lib/git-error-message'
import {
  gitBranches,
  gitCommitPush,
  gitDiff,
  gitStatus,
  type GitBranches,
  type GitCommitResult,
  type GitDiff,
  type GitErrorCode,
  type GitScope,
  type GitStatus,
} from '@/lib/api/git'

export interface GitSyncError {
  code: GitErrorCode
  raw: string
}

// lfsOverrides: forced per-file LFS decisions applied when generating the export's
// .gitattributes (undefined → use the automatic size/extension rule).
async function buildZipUncached(
  scope: GitScope,
  id: string,
  includeData: boolean,
  lfsOverrides?: Map<string, boolean>,
): Promise<Blob> {
  const storage = getStorage()
  let result: { blob: Blob } | null
  if (scope === 'projects') {
    result = await buildProjectZip(id, storage, { includeDataFiles: includeData })
  } else if (scope === 'workspaces') {
    result = await buildWorkspaceZip(id, storage, { includeDataFiles: includeData })
  } else if (scope === 'sql-script-collections') {
    const { buildSqlCollectionZip } = await import('@/lib/entity-io')
    result = await buildSqlCollectionZip(id, storage, { lfsOverrides })
  } else if (scope === 'etl-pipelines') {
    const { buildEtlPipelineZip } = await import('@/lib/entity-io')
    result = await buildEtlPipelineZip(id, storage, { lfsOverrides })
  } else if (scope === 'data-catalogs') {
    const { buildDataCatalogZip } = await import('@/lib/entity-io')
    result = await buildDataCatalogZip(id, storage, { lfsOverrides })
  } else if (scope === 'dq-rule-sets') {
    const { buildDqRuleSetZip } = await import('@/lib/entity-io')
    result = await buildDqRuleSetZip(id, storage, { lfsOverrides })
  } else if (scope === 'schema-presets') {
    const { buildSchemaPresetZip } = await import('@/lib/entity-io')
    result = await buildSchemaPresetZip(id, storage, { lfsOverrides })
  } else if (scope === 'user-plugins') {
    const { buildUserPluginZip } = await import('@/lib/entity-io')
    result = await buildUserPluginZip(id, storage, { lfsOverrides })
  } else {
    const { buildMappingProjectZip } = await import('@/lib/concept-mapping/export')
    result = await buildMappingProjectZip(id, storage, { includeData, lfsOverrides })
  }
  if (!result) throw new Error('export-failed')
  return result.blob
}

// Building the export ZIP is the expensive step (a mapping project's scores
// parquet can be ~100MB), so memoize the last one: status, every per-file diff,
// and commit within the same panel state reuse it instead of rebuilding. The key
// captures everything that changes the export; refreshStatus/setIncludeData/
// toggleLfs invalidate by changing the key, and reset() clears it.
let _zipCache: { key: string; blob: Blob } | null = null

function _zipKey(scope: GitScope, id: string, includeData: boolean, lfsOverrides?: Map<string, boolean>): string {
  const ov = lfsOverrides ? [...lfsOverrides.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',') : ''
  return `${scope}|${id}|${includeData}|${ov}`
}

async function buildZip(
  scope: GitScope,
  id: string,
  includeData: boolean,
  lfsOverrides?: Map<string, boolean>,
): Promise<Blob> {
  const key = _zipKey(scope, id, includeData, lfsOverrides)
  if (_zipCache && _zipCache.key === key) return _zipCache.blob
  const blob = await buildZipUncached(scope, id, includeData, lfsOverrides)
  _zipCache = { key, blob }
  return blob
}

// Monotonic token for refreshStatus: a refresh (mount / branch change / refresh
// button / includeData toggle) can be superseded by a newer one while its ZIP
// build + network call are in flight. Only the latest may write status/selected,
// so a slow earlier response can't clobber the panel with stale (wrong branch or
// includeData) results. Module-level so bumping it never triggers a re-render.
let statusGen = 0

interface GitSyncState {
  status: GitStatus | null
  branches: GitBranches | null
  /** Paths checked for the next commit; data files are unchecked by default. */
  selected: Set<string>
  /** Include dataset data files (CSV/parquet/…) in the export — mirrors the export
   *  tab's toggle. Off by default; off adds .gitignore rules that exclude them. */
  includeData: boolean
  /** Per-file forced LFS decisions (true = force LFS, false = force normal blob);
   *  absent → the automatic size/extension rule applies. */
  lfsOverrides: Map<string, boolean>
  loadingStatus: boolean
  committing: boolean
  error: GitSyncError | null
  /** Identity (scope|id|branch|includeData) the current status was computed for,
   *  so remounting the panel on the same entity doesn't recompute from scratch. */
  statusKey: string | null

  refreshStatus: (scope: GitScope, id: string, branch?: string) => Promise<void>
  /** Compute status only if it isn't already current for this entity+branch. */
  ensureStatus: (scope: GitScope, id: string, branch?: string) => Promise<void>
  loadBranches: (scope: GitScope, id: string) => Promise<void>
  getDiff: (scope: GitScope, id: string, path: string, branch?: string) => Promise<GitDiff | null>
  commitPush: (scope: GitScope, id: string, message: string, branch?: string) => Promise<GitCommitResult | null>
  togglePath: (path: string) => void
  setAllSelected: (checked: boolean) => void
  setIncludeData: (scope: GitScope, id: string, value: boolean, branch?: string) => Promise<void>
  /** Set of paths that will be tracked via LFS (auto rule + overrides). */
  lfsPaths: () => Set<string>
  /** Force a file's LFS state on/off (used by the badge + context menu). */
  toggleLfs: (path: string) => void
  reset: () => void
}

export const useGitSyncStore = create<GitSyncState>((set, get) => ({
  status: null,
  branches: null,
  selected: new Set(),
  includeData: false,
  lfsOverrides: new Map(),
  loadingStatus: false,
  committing: false,
  error: null,
  statusKey: null,

  ensureStatus: async (scope, id, branch) => {
    // Moving to a different entity → clear transient panel state (selection,
    // includeData, overrides, cached ZIP) so nothing leaks across projects.
    const prevKey = get().statusKey
    const sameEntity = prevKey?.startsWith(`${scope}|${id}|`)
    if (prevKey && !sameEntity) get().reset()
    const key = `${scope}|${id}|${branch ?? ''}|${get().includeData}`
    // Already computed (or computing) for this exact entity+branch → keep it,
    // so switching tabs and coming back doesn't recompute from scratch.
    if (get().statusKey === key && (get().status !== null || get().loadingStatus)) return
    await get().refreshStatus(scope, id, branch)
  },

  refreshStatus: async (scope, id, branch) => {
    const gen = ++statusGen
    const includeData = get().includeData
    const key = `${scope}|${id}|${branch ?? ''}|${includeData}`
    set({ loadingStatus: true, error: null, statusKey: key })
    try {
      // Include the LFS overrides so the status reflects the .gitattributes the
      // user actually chose — otherwise unchecking LFS for a big file has no effect
      // until commit, and it keeps showing as changed (its blob vs an LFS pointer).
      const zip = await buildZip(scope, id, includeData, get().lfsOverrides)
      const status = await gitStatus(scope, id, zip, branch)
      if (gen !== statusGen) return // superseded by a newer refresh — drop this result
      // Re-seed the selection: keep the user's choices for paths that still
      // change, default-select new paths. Deletions are never checked by default
      // (see defaultSelectedPaths); data files only when includeData is on.
      const prev = get().selected
      const hadStatus = get().status !== null
      const changed = status.files.map((f) => f.path)
      const defaultList = includeData
        ? status.files.filter((f) => f.changeType !== 'deleted').map((f) => f.path)
        : defaultSelectedPaths(status.files)
      const defaults = new Set(defaultList)
      const selected = new Set(
        changed.filter((p) => (hadStatus ? prev.has(p) : defaults.has(p))),
      )
      if (hadStatus) for (const p of changed) if (!prev.has(p) && defaults.has(p)) selected.add(p)
      set({ status, selected })
    } catch (err) {
      if (gen !== statusGen) return // a newer refresh owns the state now
      set({ error: toGitError(err) })
    } finally {
      if (gen === statusGen) set({ loadingStatus: false })
    }
  },

  loadBranches: async (scope, id) => {
    try {
      set({ branches: await gitBranches(scope, id) })
    } catch (err) {
      set({ error: toGitError(err) })
    }
  },

  getDiff: async (scope, id, path, branch) => {
    try {
      // Same .gitattributes as the status/commit build, so the diff of a big file
      // matches its chosen LFS state (pointer vs blob) rather than the default rule.
      const zip = await buildZip(scope, id, get().includeData, get().lfsOverrides)
      return await gitDiff(scope, id, zip, path, branch)
    } catch (err) {
      set({ error: toGitError(err) })
      return null
    }
  },

  commitPush: async (scope, id, message, branch) => {
    set({ committing: true, error: null })
    try {
      const paths = [...get().selected]
      const zip = await buildZip(scope, id, get().includeData, get().lfsOverrides)
      const result = await gitCommitPush(scope, id, zip, message, branch, paths)
      // After a commit the pushed files are clean; refresh so the UI updates.
      await get().refreshStatus(scope, id, branch)
      return result
    } catch (err) {
      set({ error: toGitError(err) })
      return null
    } finally {
      set({ committing: false })
    }
  },

  setIncludeData: async (scope, id, value, branch) => {
    // Changing data inclusion changes the export (files + .gitignore), so the
    // pending changes must be recomputed against the new ZIP.
    set({ includeData: value })
    await get().refreshStatus(scope, id, branch)
  },

  togglePath: (path) =>
    set((s) => {
      const next = new Set(s.selected)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { selected: next }
    }),

  setAllSelected: (checked) =>
    set((s) => ({
      selected: checked ? new Set((s.status?.files ?? []).map((f) => f.path)) : new Set(),
    })),

  lfsPaths: () => {
    const files = get().status?.files ?? []
    return new Set(resolveLfsPaths(files, get().lfsOverrides))
  },

  toggleLfs: (path) =>
    set((s) => {
      const file = s.status?.files.find((f) => f.path === path)
      // Current effective state (auto rule unless already overridden), then flip it.
      const current = new Set(resolveLfsPaths(file ? [file] : [], s.lfsOverrides)).has(path)
      const next = new Map(s.lfsOverrides)
      next.set(path, !current)
      return { lfsOverrides: next }
    }),

  reset: () => {
    statusGen++ // invalidate any in-flight refresh from the closing panel
    _zipCache = null // drop the cached export ZIP so the next entity rebuilds fresh
    set({ status: null, branches: null, selected: new Set(), includeData: false, lfsOverrides: new Map(), error: null, loadingStatus: false, committing: false, statusKey: null })
  },
}))
