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
async function buildZip(
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
  } else {
    const { buildMappingProjectZip } = await import('@/lib/concept-mapping/export')
    result = await buildMappingProjectZip(id, storage, { includeData, lfsOverrides })
  }
  if (!result) throw new Error('export-failed')
  return result.blob
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

  refreshStatus: (scope: GitScope, id: string, branch?: string) => Promise<void>
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

  refreshStatus: async (scope, id, branch) => {
    const gen = ++statusGen
    set({ loadingStatus: true, error: null })
    try {
      const includeData = get().includeData
      const zip = await buildZip(scope, id, includeData)
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
      const zip = await buildZip(scope, id, get().includeData)
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
    set({ status: null, branches: null, selected: new Set(), includeData: false, lfsOverrides: new Map(), error: null, loadingStatus: false, committing: false })
  },
}))
