import { create } from 'zustand'
import type { GitCommit, GitRemoteConfig } from '@/types'
import { useAppStore } from '@/stores/app-store'
import { getStorage } from '@/lib/storage'
import { buildProjectZip, downloadBlob, slugify } from '@/lib/entity-io'
import type { BuildProjectZipOptions } from '@/lib/entity-io'
import { isServerMode } from '@/lib/api-client'
import { fetchProjectExportZipFromServer } from '@/lib/api/projects'
import { localized } from '@/lib/localized'

const BACKEND_MSG = '[versioning] Requires backend — no-op in local mode'

interface VersioningState {
  commits: GitCommit[]
  loading: boolean
  fileChanges: { modified: number; added: number; deleted: number }
  /** Which project `remoteConfig` belongs to — readers must check it before trusting it. */
  projectUid: string | null
  remoteConfig: GitRemoteConfig | null

  initRepo: (projectUid: string) => Promise<void>
  syncFilesToGit: (projectUid: string) => Promise<void>
  loadCommits: (projectUid: string) => Promise<void>
  refreshStatus: (projectUid: string) => Promise<void>
  createCommit: (projectUid: string, message: string) => Promise<void>
  restoreCommit: (projectUid: string, oid: string) => Promise<void>
  loadRemoteConfig: (projectUid: string) => Promise<void>
  setRemoteConfig: (projectUid: string, config: GitRemoteConfig) => void
  clearRemoteConfig: (projectUid: string) => void
  exportZip: (options?: BuildProjectZipOptions) => Promise<void>
}

export const useVersioningStore = create<VersioningState>((set, get) => ({
  commits: [],
  loading: false,
  fileChanges: { modified: 0, added: 0, deleted: 0 },
  projectUid: null,
  remoteConfig: null,

  initRepo: async () => { console.info(BACKEND_MSG) },
  syncFilesToGit: async () => { console.info(BACKEND_MSG) },
  loadCommits: async () => { console.info(BACKEND_MSG); set({ commits: [] }) },
  refreshStatus: async () => { console.info(BACKEND_MSG); set({ fileChanges: { modified: 0, added: 0, deleted: 0 } }) },
  createCommit: async () => { console.info(BACKEND_MSG) },
  restoreCommit: async () => { console.info(BACKEND_MSG) },

  loadRemoteConfig: async (projectUid) => {
    // Clear before awaiting: the store is a singleton, so until the read resolves
    // `remoteConfig` still holds the PREVIOUS project's remote and the versioning
    // screen would show another project's repository.
    set({ projectUid, remoteConfig: null })
    const project = await getStorage().projects.getById(projectUid)
    // A slower read for a project we have since navigated away from must not
    // overwrite the current one.
    if (get().projectUid !== projectUid) return
    const config = project?.gitRemoteConfig?.url
      ? project.gitRemoteConfig
      : project?.gitUrl
        ? { url: project.gitUrl, branch: 'main' }
        : null
    set({ remoteConfig: config })
  },

  // The uid is passed in, not read from `activeProjectUid`: the caller writes to the
  // project it is displaying, which is not necessarily the active one.
  setRemoteConfig: (projectUid, config) => {
    set({ projectUid, remoteConfig: config })
    void getStorage().projects.update(projectUid, { gitRemoteConfig: config })
  },
  clearRemoteConfig: (projectUid) => {
    set({ projectUid, remoteConfig: null })
    void getStorage().projects.update(projectUid, { gitRemoteConfig: undefined })
  },

  exportZip: async (options) => {
    const projectUid = useAppStore.getState().activeProjectUid
    if (!projectUid) return
    // In server mode the backend builds the ZIP (offloads the browser); the front
    // only triggers + downloads. Front-only keeps the client builder. Data files
    // are included per the project's versionedDataFiles marking (read by the
    // builder from project.config) — no include flag to pass.
    if (isServerMode()) {
      const blob = await fetchProjectExportZipFromServer(projectUid)
      if (!blob) return
      const project = await getStorage().projects.getById(projectUid)
      const name = project ? localized(project.name, 'en') || projectUid : projectUid
      downloadBlob(blob, `${slugify(name)}.zip`)
      return
    }
    const result = await buildProjectZip(projectUid, getStorage(), options)
    if (!result) return
    downloadBlob(result.blob, `${slugify(result.projectName)}.zip`)
  },
}))
