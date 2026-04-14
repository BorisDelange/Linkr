import { create } from 'zustand'
import type { GitCommit, GitRemoteConfig } from '@/types'
import { useAppStore } from '@/stores/app-store'
import { getStorage } from '@/lib/storage'
import { buildProjectZip, downloadBlob, slugify } from '@/lib/entity-io'
import type { BuildProjectZipOptions } from '@/lib/entity-io'

const BACKEND_MSG = '[versioning] Requires backend — no-op in local mode'

interface VersioningState {
  commits: GitCommit[]
  loading: boolean
  fileChanges: { modified: number; added: number; deleted: number }
  remoteConfig: GitRemoteConfig | null

  initRepo: (projectUid: string) => Promise<void>
  syncFilesToGit: (projectUid: string) => Promise<void>
  loadCommits: (projectUid: string) => Promise<void>
  refreshStatus: (projectUid: string) => Promise<void>
  createCommit: (projectUid: string, message: string) => Promise<void>
  restoreCommit: (projectUid: string, oid: string) => Promise<void>
  setRemoteConfig: (config: GitRemoteConfig) => void
  clearRemoteConfig: () => void
  exportZip: (options?: BuildProjectZipOptions) => Promise<void>
}

export const useVersioningStore = create<VersioningState>((set) => ({
  commits: [],
  loading: false,
  fileChanges: { modified: 0, added: 0, deleted: 0 },
  remoteConfig: null,

  initRepo: async () => { console.info(BACKEND_MSG) },
  syncFilesToGit: async () => { console.info(BACKEND_MSG) },
  loadCommits: async () => { console.info(BACKEND_MSG); set({ commits: [] }) },
  refreshStatus: async () => { console.info(BACKEND_MSG); set({ fileChanges: { modified: 0, added: 0, deleted: 0 } }) },
  createCommit: async () => { console.info(BACKEND_MSG) },
  restoreCommit: async () => { console.info(BACKEND_MSG) },

  setRemoteConfig: (config) => set({ remoteConfig: config }),
  clearRemoteConfig: () => set({ remoteConfig: null }),

  exportZip: async (options) => {
    const projectUid = useAppStore.getState().activeProjectUid
    if (!projectUid) return
    const result = await buildProjectZip(projectUid, getStorage(), options)
    if (!result) return
    downloadBlob(result.blob, `${slugify(result.projectName)}.zip`)
  },
}))
