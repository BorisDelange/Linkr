/**
 * Git sync (push-only) for the Versioning "Git repository" tab, server mode only.
 *
 * The backend versions the export tree. For mapping projects the SERVER now builds
 * the export ZIP (buildZip returns null → the API omits the file part); for the
 * other scopes the client still builds it locally (buildProjectZip /
 * buildWorkspaceZip / …) and uploads it. This store holds the transient UI state
 * (pending files, branches, busy flags); the persisted remote link still lives on
 * the entity via the existing versioning stores.
 */
import { create } from 'zustand'
import { buildProjectZip, buildWorkspaceZip } from '@/lib/entity-io'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { defaultSelectedPaths, isUnownedConfigModification } from '@/lib/git-file-classify'
import { resolveLfsPaths } from '@/lib/git-lfs'
import { toGitError } from '@/lib/git-error-message'
import {
  gitBranches,
  gitCommitPush,
  gitDiff,
  gitStatus,
  gitSyncState,
  type GitBranches,
  type GitCommitResult,
  type GitDiff,
  type GitErrorCode,
  type GitScope,
  type GitStatus,
  type GitSyncState as GitSyncStateResult,
} from '@/lib/api/git'

export interface GitSyncError {
  code: GitErrorCode
  raw: string
}

// In server mode the backend assembles the export ZIP itself (offloading the
// browser), so the client sends no file — see docs/architecture.md ("Fullstack
// Storage & Compute"). Projects additionally send the include-data toggle (their
// server builder honors it). Other scopes are still client-built (extending them
// is tracked in docs/planning/versioning-plan.md); front-only always builds
// client-side.
function serverBuildsZip(scope: GitScope): boolean {
  return isServerMode() && (scope === 'projects' || scope === 'workspaces' || scope === 'mapping-projects' || scope === 'settings')
}

// lfsOverrides: opt-in per-file LFS decisions applied when generating the export's
// .gitattributes (absent/false → normal blob; LFS is opt-in only).
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
    result = await buildMappingProjectZip(id, storage, { lfsOverrides })
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

// Per-file diff cache, keyed by `${branch}|${path}`. Lives at module level (not in
// the diff dialog) so closing and reopening the dialog on the SAME entity reuses the
// already-computed diffs instead of rebuilding the export + refetching each file.
// Invalidated exactly when the export can change (invalidateZip / refreshStatus) and
// cleared on entity switch (reset), so a stale diff is never shown after an edit.
let _diffCache: Map<string, GitDiff | null> = new Map()

function _zipKey(scope: GitScope, id: string, includeData: boolean, lfsOverrides?: Map<string, boolean>): string {
  const ov = lfsOverrides ? [...lfsOverrides.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',') : ''
  return `${scope}|${id}|${includeData}|${ov}`
}

async function buildZip(
  scope: GitScope,
  id: string,
  includeData: boolean,
  lfsOverrides?: Map<string, boolean>,
): Promise<Blob | null> {
  // null → the server builds the ZIP; the client uploads nothing.
  if (serverBuildsZip(scope)) return null
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
  /** Standing vs the remote branch (behind / diverged); null until loaded. Drives
   *  the "N commits upstream" banner. Only computed for scopes that support it. */
  syncState: GitSyncStateResult | null
  /** Paths checked for the next commit; data files are unchecked by default. */
  selected: Set<string>
  /** Include dataset data files (CSV/parquet/…) in the export — mirrors the export
   *  tab's toggle. Off by default; off adds .gitignore rules that exclude them. */
  includeData: boolean
  /** Per-file opt-in LFS decisions (true = track via LFS, false/absent = normal
   *  blob). LFS is opt-in only — there's no automatic size/extension rule. */
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
  /** Load where the entity stands vs the remote (behind/diverged banner). */
  loadSyncState: (scope: GitScope, id: string, branch?: string) => Promise<void>
  getDiff: (scope: GitScope, id: string, path: string, branch?: string) => Promise<GitDiff | null>
  commitPush: (scope: GitScope, id: string, message: string, branch?: string) => Promise<GitCommitResult | null>
  /** Commit + push an EXPLICIT path list (Quick actions), independent of the
   *  checkbox selection. Same flow as commitPush otherwise. */
  commitPushPaths: (scope: GitScope, id: string, paths: string[], message: string, branch?: string) => Promise<GitCommitResult | null>
  /** Shared commit+push implementation behind commitPush / commitPushPaths. */
  _commitPushPaths: (scope: GitScope, id: string, paths: string[], message: string, branch?: string) => Promise<GitCommitResult | null>
  togglePath: (path: string) => void
  setAllSelected: (checked: boolean) => void
  setIncludeData: (scope: GitScope, id: string, value: boolean, branch?: string) => Promise<void>
  /** Set of paths that will be tracked via LFS (opt-in overrides only). */
  lfsPaths: () => Set<string>
  /** Force a file's LFS state on/off (used by the badge + context menu). */
  toggleLfs: (path: string) => void
  /** Drop the cached export ZIP without changing entity — call after something
   *  mutated the entity's DB content out-of-band (e.g. a pull applied changes) so
   *  the next refreshStatus rebuilds the ZIP from the fresh state, not the stale
   *  cache (same scope|id|includeData key would otherwise be reused). */
  invalidateZip: () => void
  reset: () => void
}

export const useGitSyncStore = create<GitSyncState>((set, get) => ({
  status: null,
  branches: null,
  syncState: null,
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
      // A refresh means "the state may have changed, rebuild": the ZIP cache key
      // (scope|id|includeData|overrides) can't see DB edits, so a mapping added
      // since the last build would otherwise be exported from the stale cached ZIP
      // and show no diff. Drop the cache first so the export reflects current DB
      // content; getDiff/commitPush then reuse the blob this refresh just built.
      get().invalidateZip()
      // Include the LFS overrides so the status reflects the .gitattributes the
      // user actually chose — otherwise unchecking LFS for a big file has no effect
      // until commit, and it keeps showing as changed (its blob vs an LFS pointer).
      const zip = await buildZip(scope, id, includeData, get().lfsOverrides)
      const status = await gitStatus(scope, id, zip, branch, includeData)
      if (gen !== statusGen) return // superseded by a newer refresh — drop this result
      // Re-seed the selection: keep the user's choices for paths that still
      // change, default-select new paths. Deletions are never checked by default
      // (see defaultSelectedPaths); data files only when includeData is on.
      const prev = get().selected
      const hadStatus = get().status !== null
      const changed = status.files.map((f) => f.path)
      const defaultList = includeData
        // includeData adds data files back in, but must still leave hand-enriched
        // repo config (.gitignore/.gitattributes) unchecked — same as the default.
        ? status.files
            .filter((f) => f.changeType !== 'deleted' && !isUnownedConfigModification(f))
            .map((f) => f.path)
        : defaultSelectedPaths(scope, status.files)
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

  loadSyncState: async (scope, id, branch) => {
    try {
      // Cheap oid-only check on the server — no export ZIP to build, so opening the
      // Versioning tab doesn't pay the (heavy) export cost just to show the banner.
      set({ syncState: await gitSyncState(scope, id, branch) })
    } catch (err) {
      set({ error: toGitError(err) })
    }
  },

  getDiff: async (scope, id, path, branch) => {
    // Reuse an already-computed diff for this file (survives dialog close/reopen on
    // the same entity; invalidated on edit/refresh/entity-switch — see _diffCache).
    const cacheKey = `${branch ?? ''}|${path}`
    if (_diffCache.has(cacheKey)) return _diffCache.get(cacheKey) ?? null
    try {
      // Same .gitattributes as the status/commit build, so the diff of a big file
      // matches its chosen LFS state (pointer vs blob) rather than the default rule.
      const zip = await buildZip(scope, id, get().includeData, get().lfsOverrides)
      const diff = await gitDiff(scope, id, zip, path, branch, get().includeData)
      _diffCache.set(cacheKey, diff)
      return diff
    } catch (err) {
      set({ error: toGitError(err) })
      return null
    }
  },

  commitPush: async (scope, id, message, branch) =>
    get()._commitPushPaths(scope, id, [...get().selected], message, branch),

  commitPushPaths: async (scope, id, paths, message, branch) =>
    get()._commitPushPaths(scope, id, paths, message, branch),

  _commitPushPaths: async (scope, id, paths, message, branch) => {
    set({ committing: true, error: null })
    try {
      const zip = await buildZip(scope, id, get().includeData, get().lfsOverrides)
      const result = await gitCommitPush(scope, id, zip, message, branch, paths, get().includeData)
      // After a commit the pushed files are clean; refresh so the UI updates and
      // the local anchor is level with the remote again (otherwise the pushed
      // files keep showing as "to commit"). refreshStatus flips loadingStatus, so
      // the Quick-actions cards show the spinner during the recompute rather than
      // flashing clickable — committing also stays true until the finally below.
      await get().refreshStatus(scope, id, branch)
      if (get().syncState) await get().loadSyncState(scope, id, branch)
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

  toggleLfs: (path) => {
    set((s) => {
      const file = s.status?.files.find((f) => f.path === path)
      // Current effective state (opt-in override, else normal blob), then flip it.
      const current = new Set(resolveLfsPaths(file ? [file] : [], s.lfsOverrides)).has(path)
      const next = new Map(s.lfsOverrides)
      next.set(path, !current)
      return { lfsOverrides: next }
    })
    // Toggling LFS changes the export .gitattributes → the file's diff (pointer vs
    // blob) and the .gitattributes diff both go stale. Drop the cached ZIP + diffs
    // so the next getDiff rebuilds against the new storage mode.
    get().invalidateZip()
  },

  invalidateZip: () => {
    _zipCache = null
    _diffCache = new Map() // diffs derive from the export ZIP → drop them together
  },

  reset: () => {
    statusGen++ // invalidate any in-flight refresh from the closing panel
    _zipCache = null // drop the cached export ZIP so the next entity rebuilds fresh
    _diffCache = new Map() // and the per-file diffs computed against it
    set({ status: null, branches: null, syncState: null, selected: new Set(), includeData: false, lfsOverrides: new Map(), error: null, loadingStatus: false, committing: false, statusKey: null })
  },
}))
