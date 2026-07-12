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

async function buildZip(scope: GitScope, id: string, includeData: boolean): Promise<Blob> {
  const result =
    scope === 'projects'
      ? await buildProjectZip(id, getStorage(), { includeDataFiles: includeData })
      : await buildWorkspaceZip(id, getStorage(), { includeDataFiles: includeData })
  if (!result) throw new Error('export-failed')
  return result.blob
}

interface GitSyncState {
  status: GitStatus | null
  branches: GitBranches | null
  /** Paths checked for the next commit; data files are unchecked by default. */
  selected: Set<string>
  /** Include dataset data files (CSV/parquet/…) in the export — mirrors the export
   *  tab's toggle. Off by default; off adds .gitignore rules that exclude them. */
  includeData: boolean
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
  reset: () => void
}

export const useGitSyncStore = create<GitSyncState>((set, get) => ({
  status: null,
  branches: null,
  selected: new Set(),
  includeData: false,
  loadingStatus: false,
  committing: false,
  error: null,

  refreshStatus: async (scope, id, branch) => {
    set({ loadingStatus: true, error: null })
    try {
      const includeData = get().includeData
      const zip = await buildZip(scope, id, includeData)
      const status = await gitStatus(scope, id, zip, branch)
      // Re-seed the selection: keep the user's choices for paths that still
      // change, default-select new paths (data files default-off unless includeData).
      const prev = get().selected
      const hadStatus = get().status !== null
      const changed = status.files.map((f) => f.path)
      const defaults = new Set(includeData ? changed : defaultSelectedPaths(changed))
      const selected = new Set(
        changed.filter((p) => (hadStatus ? prev.has(p) : defaults.has(p))),
      )
      if (hadStatus) for (const p of changed) if (!prev.has(p) && defaults.has(p)) selected.add(p)
      set({ status, selected })
    } catch (err) {
      set({ error: toGitError(err) })
    } finally {
      set({ loadingStatus: false })
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
      const zip = await buildZip(scope, id, get().includeData)
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

  reset: () =>
    set({ status: null, branches: null, selected: new Set(), includeData: false, error: null, loadingStatus: false, committing: false }),
}))
