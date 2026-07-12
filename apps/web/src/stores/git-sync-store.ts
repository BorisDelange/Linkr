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
import {
  gitBranches,
  gitCommitPush,
  gitDiff,
  gitStatus,
  type GitBranches,
  type GitCommitResult,
  type GitDiff,
  type GitScope,
  type GitStatus,
} from '@/lib/api/git'

async function buildZip(scope: GitScope, id: string): Promise<Blob> {
  const result =
    scope === 'projects'
      ? await buildProjectZip(id, getStorage())
      : await buildWorkspaceZip(id, getStorage())
  if (!result) throw new Error('export-failed')
  return result.blob
}

interface GitSyncState {
  status: GitStatus | null
  branches: GitBranches | null
  loadingStatus: boolean
  committing: boolean
  error: string | null

  refreshStatus: (scope: GitScope, id: string, branch?: string) => Promise<void>
  loadBranches: (scope: GitScope, id: string) => Promise<void>
  getDiff: (scope: GitScope, id: string, path: string, branch?: string) => Promise<GitDiff | null>
  commitPush: (scope: GitScope, id: string, message: string, branch?: string) => Promise<GitCommitResult | null>
  reset: () => void
}

export const useGitSyncStore = create<GitSyncState>((set) => ({
  status: null,
  branches: null,
  loadingStatus: false,
  committing: false,
  error: null,

  refreshStatus: async (scope, id, branch) => {
    set({ loadingStatus: true, error: null })
    try {
      const zip = await buildZip(scope, id)
      set({ status: await gitStatus(scope, id, zip, branch) })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ loadingStatus: false })
    }
  },

  loadBranches: async (scope, id) => {
    try {
      set({ branches: await gitBranches(scope, id) })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  getDiff: async (scope, id, path, branch) => {
    try {
      const zip = await buildZip(scope, id)
      return await gitDiff(scope, id, zip, path, branch)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  commitPush: async (scope, id, message, branch) => {
    set({ committing: true, error: null })
    try {
      const zip = await buildZip(scope, id)
      const result = await gitCommitPush(scope, id, zip, message, branch)
      // After a commit the working tree is clean; refresh so the UI empties out.
      const fresh = await gitStatus(scope, id, zip, branch)
      set({ status: fresh })
      return result
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    } finally {
      set({ committing: false })
    }
  },

  reset: () => set({ status: null, branches: null, error: null, loadingStatus: false, committing: false }),
}))
