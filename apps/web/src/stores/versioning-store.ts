import { Buffer } from 'buffer'
if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
}

import { create } from 'zustand'
import git from 'isomorphic-git'
import LightningFS from '@isomorphic-git/lightning-fs'
import JSZip from 'jszip'
import type { GitCommit, GitRemoteConfig } from '@/types'
import { useFileStore, type FileNode } from '@/stores/file-store'

const FS_PREFIX = 'linkr-git'
const GIT_AUTHOR = { name: 'Linkr User', email: 'user@linkr.local' }

function getFs(projectUid: string) {
  return new LightningFS(`${FS_PREFIX}-${projectUid}`)
}

function getDir(projectUid: string) {
  return `/${projectUid}`
}

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

export const useVersioningStore = create<VersioningState>((set, get) => ({
  commits: [],
  loading: false,
  fileChanges: { modified: 0, added: 0, deleted: 0 },
  remoteConfig: null,

  initRepo: async (projectUid) => {
    const fs = getFs(projectUid)
    const dir = getDir(projectUid)
    try {
      await fs.promises.stat(dir)
    } catch {
      await fs.promises.mkdir(dir)
    }
    try {
      await git.init({ fs, dir })
    } catch {
      // already initialized
    }
  },

  syncFilesToGit: async (projectUid) => {
    const fs = getFs(projectUid)
    const dir = getDir(projectUid)
    const files = useFileStore.getState().files

    // Write all project files into the git working directory
    for (const file of files) {
      if (file.type === 'folder') {
        const folderPath = `${dir}/${buildFilePath(file, files)}`
        try {
          await fs.promises.stat(folderPath)
        } catch {
          await fs.promises.mkdir(folderPath, { recursive: true } as never)
        }
      }
    }
    for (const file of files) {
      if (file.type === 'file') {
        const filePath = `${dir}/${buildFilePath(file, files)}`
        // Ensure parent directories exist
        const parts = filePath.split('/')
        for (let i = 2; i < parts.length; i++) {
          const parentPath = parts.slice(0, i).join('/')
          try {
            await fs.promises.stat(parentPath)
          } catch {
            await fs.promises.mkdir(parentPath)
          }
        }
        await fs.promises.writeFile(filePath, file.content ?? '')
      }
    }
  },

  loadCommits: async (projectUid) => {
    const fs = getFs(projectUid)
    const dir = getDir(projectUid)
    try {
      const log = await git.log({ fs, dir, depth: 100 })
      const commits: GitCommit[] = log.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message,
        author: {
          name: entry.commit.author.name,
          email: entry.commit.author.email,
          timestamp: entry.commit.author.timestamp,
        },
        parents: entry.commit.parent,
      }))
      set({ commits })
    } catch {
      // No commits yet
      set({ commits: [] })
    }
  },

  refreshStatus: async (projectUid) => {
    const fs = getFs(projectUid)
    const dir = getDir(projectUid)
    try {
      await get().syncFilesToGit(projectUid)
      const matrix = await git.statusMatrix({ fs, dir })
      let modified = 0
      let added = 0
      let deleted = 0
      for (const row of matrix) {
        const [, head, workdir, stage] = row as [string, number, number, number]
        if (head === 0 && workdir === 2) added++
        else if (head === 1 && workdir === 0) deleted++
        else if (head === 1 && workdir === 2 && stage !== 1) modified++
        else if (head === 1 && workdir === 2 && stage === 1) modified++
      }
      set({ fileChanges: { modified, added, deleted } })
    } catch {
      set({ fileChanges: { modified: 0, added: 0, deleted: 0 } })
    }
  },

  createCommit: async (projectUid, message) => {
    set({ loading: true })
    try {
      const fs = getFs(projectUid)
      const dir = getDir(projectUid)

      await get().syncFilesToGit(projectUid)

      // Stage all files
      const matrix = await git.statusMatrix({ fs, dir })
      for (const row of matrix) {
        const [filepath, , workdir] = row as [string, number, number, number]
        if (workdir === 0) {
          await git.remove({ fs, dir, filepath })
        } else {
          await git.add({ fs, dir, filepath })
        }
      }

      await git.commit({
        fs,
        dir,
        message,
        author: GIT_AUTHOR,
      })

      await get().loadCommits(projectUid)
      set({ fileChanges: { modified: 0, added: 0, deleted: 0 } })
    } finally {
      set({ loading: false })
    }
  },

  restoreCommit: async (projectUid, oid) => {
    set({ loading: true })
    try {
      const fs = getFs(projectUid)
      const dir = getDir(projectUid)

      await git.checkout({ fs, dir, ref: oid, force: true })

      // Read files back from git into the file store
      // For now, this is a placeholder — full implementation
      // would walk the tree and update useFileStore
      await get().loadCommits(projectUid)
      await get().refreshStatus(projectUid)
    } finally {
      set({ loading: false })
    }
  },

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

      // Clear existing files (simple approach — replace all)
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
