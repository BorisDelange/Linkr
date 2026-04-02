import { create } from 'zustand'
import type { GitCommit, GitRemoteConfig, WikiPage, CommitFileChange, FileChangeType, RestoreResult } from '@/types'
import { buildWorkspaceZip, downloadBlob, slugify, timestamp } from '@/lib/entity-io'
import type { BuildWorkspaceZipOptions } from '@/lib/entity-io'
import { getStorage } from '@/lib/storage'

export type VersionedEntityType = 'plugin' | 'schema' | 'database'

const BACKEND_MSG = '[versioning] Requires backend — no-op in local mode'

interface WorkspaceVersioningState {
  workspaceId: string | null
  commits: GitCommit[]
  loading: boolean
  initialized: boolean
  hasMoreCommits: boolean
  remoteConfig: GitRemoteConfig | null

  ensureRepo: (workspaceId: string) => Promise<void>
  syncWorkspaceToGit: (workspaceId: string) => Promise<void>
  loadCommits: (workspaceId: string) => Promise<void>
  loadMoreCommits: (workspaceId: string) => Promise<void>

  commitPluginChange: (workspaceId: string, pluginId: string, pluginName: string, changeType: 'create' | 'update' | 'delete') => Promise<void>
  commitWikiPageChange: (workspaceId: string, page: WikiPage, changeType: 'create' | 'update' | 'delete') => Promise<void>
  commitSchemaPresetChange: (workspaceId: string, presetId: string, presetName: string, changeType: 'create' | 'update' | 'delete') => Promise<void>
  commitDataSourceChange: (workspaceId: string, sourceId: string, sourceName: string, changeType: 'create' | 'update' | 'delete') => Promise<void>

  getWikiCommits: (workspaceId: string) => Promise<GitCommit[]>
  getFileCommits: (workspaceId: string, pageId: string) => Promise<GitCommit[]>
  readFileAtCommit: (workspaceId: string, oid: string, pageId: string) => Promise<string | null>
  restoreWikiPage: (workspaceId: string, pageId: string, oid: string) => Promise<void>
  restoreWikiToCommit: (workspaceId: string, oid: string) => Promise<void>
  getCommitFiles: (workspaceId: string, oid: string) => Promise<CommitFileChange[]>
  getFileDiff: (workspaceId: string, oid: string, filepath: string) => Promise<{ filepath: string; changeType: FileChangeType; oldContent: string; newContent: string } | null>
  getEntityCommits: (workspaceId: string, entityType: VersionedEntityType, entityId: string) => Promise<GitCommit[]>
  restoreEntity: (workspaceId: string, entityType: VersionedEntityType, entityId: string, oid: string) => Promise<RestoreResult>
  restoreToCommit: (workspaceId: string, oid: string) => Promise<RestoreResult>

  setRemoteConfig: (config: GitRemoteConfig) => void
  clearRemoteConfig: () => void
  exportZip: (workspaceId: string, options?: BuildWorkspaceZipOptions) => Promise<void>
}

export const useWorkspaceVersioningStore = create<WorkspaceVersioningState>((set) => ({
  workspaceId: null,
  commits: [],
  loading: false,
  initialized: false,
  hasMoreCommits: false,
  remoteConfig: null,

  ensureRepo: async () => { console.info(BACKEND_MSG) },
  syncWorkspaceToGit: async () => { console.info(BACKEND_MSG) },
  loadCommits: async () => { console.info(BACKEND_MSG); set({ commits: [], loading: false, initialized: true }) },
  loadMoreCommits: async () => { console.info(BACKEND_MSG) },

  commitPluginChange: async () => { console.info(BACKEND_MSG) },
  commitWikiPageChange: async () => { console.info(BACKEND_MSG) },
  commitSchemaPresetChange: async () => { console.info(BACKEND_MSG) },
  commitDataSourceChange: async () => { console.info(BACKEND_MSG) },

  getWikiCommits: async () => { console.info(BACKEND_MSG); return [] },
  getFileCommits: async () => { console.info(BACKEND_MSG); return [] },
  readFileAtCommit: async () => { console.info(BACKEND_MSG); return null },
  restoreWikiPage: async () => { console.info(BACKEND_MSG) },
  restoreWikiToCommit: async () => { console.info(BACKEND_MSG) },
  getCommitFiles: async () => { console.info(BACKEND_MSG); return [] },
  getFileDiff: async () => { console.info(BACKEND_MSG); return null },
  getEntityCommits: async () => { console.info(BACKEND_MSG); return [] },
  restoreEntity: async () => { console.info(BACKEND_MSG); return { success: false, restoredFiles: [] } },
  restoreToCommit: async () => { console.info(BACKEND_MSG); return { success: false, restoredFiles: [] } },

  setRemoteConfig: (config) => set({ remoteConfig: config }),
  clearRemoteConfig: () => set({ remoteConfig: null }),
  exportZip: async (workspaceId: string, options: BuildWorkspaceZipOptions = {}) => {
    set({ loading: true })
    try {
      const result = await buildWorkspaceZip(workspaceId, getStorage(), options)
      if (result) {
        downloadBlob(result.blob, `${slugify(result.workspaceName)}-${timestamp()}.zip`)
      }
    } finally {
      set({ loading: false })
    }
  },
}))
