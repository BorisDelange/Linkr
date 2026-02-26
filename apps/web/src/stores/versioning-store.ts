import { create } from 'zustand'
import JSZip from 'jszip'
import type { GitCommit, GitRemoteConfig } from '@/types'
import { useFileStore, type FileNode } from '@/stores/file-store'

const BACKEND_MSG = '[versioning] Requires backend — no-op in local mode'

/** Build a relative file path from a FileNode by walking up parents. */
function buildFilePath(node: FileNode, files: FileNode[]): string {
  const parts: string[] = [node.name]
  let current = node
  while (current.parentId) {
    const parent = files.find((f) => f.id === current.parentId)
    if (!parent) break
    parts.unshift(parent.name)
    current = parent
  }
  return parts.join('/')
}

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
  exportZip: () => void
  importZip: (file: File) => Promise<void>
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

  exportZip: () => {
    const files = useFileStore.getState().files
    const zip = new JSZip()

    for (const file of files) {
      if (file.type === 'file') {
        const path = buildFilePath(file, files)
        zip.file(path, file.content ?? '')
      }
    }

    zip.generateAsync({ type: 'blob' }).then((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'project-export.zip'
      a.click()
      URL.revokeObjectURL(url)
    })
  },

  importZip: async (file) => {
    set({ loading: true })
    try {
      const zip = await JSZip.loadAsync(file)
      const { createFile, createFolder, updateFileContent } = useFileStore.getState()

      // Clear existing files
      const store = useFileStore.getState()
      for (const f of [...store.files]) {
        useFileStore.getState().deleteNode(f.id)
      }

      // Track created folders to avoid duplicates
      const createdFolders = new Map<string, string>()

      const ensureFolder = (folderPath: string): string | null => {
        if (!folderPath) return null
        if (createdFolders.has(folderPath)) return createdFolders.get(folderPath)!

        const parts = folderPath.split('/')
        let parentId: string | null = null
        let currentPath = ''

        for (const part of parts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part
          if (!createdFolders.has(currentPath)) {
            createFolder(part, parentId)
            const newFiles = useFileStore.getState().files
            const created = newFiles[newFiles.length - 1]
            createdFolders.set(currentPath, created.id)
            parentId = created.id
          } else {
            parentId = createdFolders.get(currentPath)!
          }
        }
        return parentId
      }

      for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue
        const content = await zipEntry.async('string')
        const parts = relativePath.split('/')
        const fileName = parts.pop()!
        const folderPath = parts.join('/')
        const parentId = ensureFolder(folderPath)

        const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
        const langMap: Record<string, string> = {
          py: 'python', r: 'r', sql: 'sql', sh: 'shell',
          json: 'json', md: 'markdown', txt: 'plaintext',
        }
        createFile(fileName, parentId, langMap[ext] ?? 'plaintext')
        const newFiles = useFileStore.getState().files
        const created = newFiles[newFiles.length - 1]
        if (created) updateFileContent(created.id, content)
      }
    } finally {
      set({ loading: false })
    }
  },
}))
