import { Buffer } from 'buffer'
// isomorphic-git requires a global Buffer polyfill in browser environments
if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
}

import { create } from 'zustand'
import git from 'isomorphic-git'
import LightningFS from '@isomorphic-git/lightning-fs'
import JSZip from 'jszip'
import type { GitCommit, GitRemoteConfig, WikiPage } from '@/types'

const WS_FS_PREFIX = 'linkr-ws-git'
const GIT_AUTHOR = { name: 'Linkr User', email: 'user@linkr.local' }

function getFs(workspaceId: string) {
  return new LightningFS(`${WS_FS_PREFIX}-${workspaceId}`)
}

function getDir(workspaceId: string) {
  return `/${workspaceId}`
}

/** Metadata stored in _index.json for each wiki page (everything except content). */
interface WikiPageMeta {
  id: string
  title: string
  slug: string
  icon?: string
  parentId: string | null
  sortOrder: number
  template?: string
  owner?: string
  verified?: boolean
  verifiedAt?: string
  reviewDueAt?: string
  createdAt: string
  updatedAt: string
}

function pageToMeta(page: WikiPage): WikiPageMeta {
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    icon: page.icon,
    parentId: page.parentId,
    sortOrder: page.sortOrder,
    template: page.template,
    owner: page.owner,
    verified: page.verified,
    verifiedAt: page.verifiedAt,
    reviewDueAt: page.reviewDueAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  }
}

interface WorkspaceVersioningState {
  workspaceId: string | null
  commits: GitCommit[]
  loading: boolean
  initialized: boolean
  fileChanges: { modified: number; added: number; deleted: number }
  remoteConfig: GitRemoteConfig | null

  ensureRepo: (workspaceId: string) => Promise<void>
  syncWorkspaceToGit: (workspaceId: string) => Promise<void>
  loadCommits: (workspaceId: string) => Promise<void>
  refreshStatus: (workspaceId: string) => Promise<void>
  createCommit: (workspaceId: string, message: string) => Promise<void>

  commitPluginChange: (workspaceId: string, pluginId: string, pluginName: string, changeType: 'create' | 'update' | 'delete') => Promise<void>
  commitWikiPageChange: (workspaceId: string, page: WikiPage, changeType: 'create' | 'update' | 'delete') => Promise<void>
  getFileCommits: (workspaceId: string, pageId: string) => Promise<GitCommit[]>
  readFileAtCommit: (workspaceId: string, oid: string, pageId: string) => Promise<string | null>
  restoreWikiPage: (workspaceId: string, pageId: string, oid: string) => Promise<void>

  setRemoteConfig: (config: GitRemoteConfig) => void
  clearRemoteConfig: () => void
  exportZip: (workspaceId: string) => Promise<void>
}

// Serialize git operations to avoid concurrent write races
let commitQueue: Promise<void> = Promise.resolve()

function enqueue(fn: () => Promise<void>): Promise<void> {
  commitQueue = commitQueue.then(fn, fn)
  return commitQueue
}

async function ensureDirExists(fs: LightningFS, path: string) {
  try {
    await fs.promises.stat(path)
  } catch {
    await fs.promises.mkdir(path)
  }
}

async function removeDirRecursive(fs: LightningFS, path: string) {
  try {
    const entries = await fs.promises.readdir(path)
    for (const entry of entries) {
      const full = `${path}/${entry}`
      const stat = await fs.promises.stat(full)
      if (stat.isDirectory()) {
        await removeDirRecursive(fs, full)
      } else {
        await fs.promises.unlink(full)
      }
    }
    await fs.promises.rmdir(path)
  } catch {
    // directory might not exist
  }
}

export const useWorkspaceVersioningStore = create<WorkspaceVersioningState>((set, get) => ({
  workspaceId: null,
  commits: [],
  loading: false,
  initialized: false,
  fileChanges: { modified: 0, added: 0, deleted: 0 },
  remoteConfig: null,

  ensureRepo: async (workspaceId) => {
    if (get().initialized && get().workspaceId === workspaceId) return
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    await ensureDirExists(fs, dir)
    try {
      await git.init({ fs, dir })
    } catch {
      // already initialized
    }
    await ensureDirExists(fs, `${dir}/wiki`)
    await ensureDirExists(fs, `${dir}/plugins`)
    await ensureDirExists(fs, `${dir}/schemas`)
    await ensureDirExists(fs, `${dir}/databases`)
    set({ workspaceId, initialized: true })
  },

  syncWorkspaceToGit: async (workspaceId) => {
    const { useWikiStore } = await import('@/stores/wiki-store')
    const { useWorkspaceStore } = await import('@/stores/workspace-store')
    const { getStorage } = await import('@/lib/storage')
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)

    // --- Write workspace.json ---
    const workspace = useWorkspaceStore.getState()._workspacesRaw.find((ws) => ws.id === workspaceId)
    if (workspace) {
      const { id, name, description, organizationId, badges, createdAt, updatedAt } = workspace
      await fs.promises.writeFile(
        `${dir}/workspace.json`,
        JSON.stringify({ id, name, description, organizationId, badges, createdAt, updatedAt }, null, 2),
      )
    }

    // --- Write wiki pages ---
    const pages = useWikiStore.getState().pages.filter((p) => p.workspaceId === workspaceId)
    await ensureDirExists(fs, `${dir}/wiki`)

    for (const page of pages) {
      await fs.promises.writeFile(`${dir}/wiki/${page.id}.md`, page.content)
    }

    const index = pages.map(pageToMeta)
    await fs.promises.writeFile(`${dir}/wiki/_index.json`, JSON.stringify(index, null, 2))

    // Clean up deleted wiki pages
    const pageIds = new Set(pages.map((p) => p.id))
    try {
      const entries = await fs.promises.readdir(`${dir}/wiki`)
      for (const entry of entries) {
        if (entry === '_index.json') continue
        if (entry.endsWith('.md')) {
          const fileId = entry.slice(0, -3)
          if (!pageIds.has(fileId)) {
            await fs.promises.unlink(`${dir}/wiki/${entry}`)
          }
        }
      }
    } catch {
      // wiki dir might not exist yet
    }

    // --- Write plugins ---
    await ensureDirExists(fs, `${dir}/plugins`)
    const allPlugins = await getStorage().userPlugins.getByWorkspace(workspaceId)
    const pluginIds = new Set<string>()
    for (const plugin of allPlugins) {
      pluginIds.add(plugin.id)
      await ensureDirExists(fs, `${dir}/plugins/${plugin.id}`)
      for (const [filename, content] of Object.entries(plugin.files)) {
        await fs.promises.writeFile(`${dir}/plugins/${plugin.id}/${filename}`, content)
      }
    }

    // Clean up deleted plugins
    try {
      const pluginDirs = await fs.promises.readdir(`${dir}/plugins`)
      for (const entry of pluginDirs) {
        if (!pluginIds.has(entry)) {
          await removeDirRecursive(fs, `${dir}/plugins/${entry}`)
        }
      }
    } catch {
      // plugins dir might not exist yet
    }

    // --- Write schema presets ---
    await ensureDirExists(fs, `${dir}/schemas`)
    const allPresets = await getStorage().schemaPresets.getByWorkspace(workspaceId)
    const presetIds = new Set<string>()
    for (const preset of allPresets) {
      presetIds.add(preset.presetId)
      const { presetId, mapping, createdAt, updatedAt } = preset
      await fs.promises.writeFile(
        `${dir}/schemas/${preset.presetId}.json`,
        JSON.stringify({ presetId, mapping, createdAt, updatedAt }, null, 2),
      )
    }

    // Clean up deleted presets
    try {
      const presetFiles = await fs.promises.readdir(`${dir}/schemas`)
      for (const entry of presetFiles) {
        if (entry.endsWith('.json')) {
          const id = entry.slice(0, -5)
          if (!presetIds.has(id)) {
            await fs.promises.unlink(`${dir}/schemas/${entry}`)
          }
        }
      }
    } catch {
      // schemas dir might not exist yet
    }

    // --- Write data sources (config only, no binary data) ---
    await ensureDirExists(fs, `${dir}/databases`)
    const allSources = await getStorage().dataSources.getByWorkspace(workspaceId)
    const sourceIds = new Set<string>()
    for (const ds of allSources) {
      sourceIds.add(ds.id)
      const { id, alias, name, description, sourceType, connectionConfig, schemaMapping, status, createdAt, updatedAt } = ds
      await fs.promises.writeFile(
        `${dir}/databases/${ds.id}.json`,
        JSON.stringify({ id, alias, name, description, sourceType, connectionConfig, schemaMapping, status, createdAt, updatedAt }, null, 2),
      )
    }

    // Clean up deleted data sources
    try {
      const dbFiles = await fs.promises.readdir(`${dir}/databases`)
      for (const entry of dbFiles) {
        if (entry.endsWith('.json')) {
          const id = entry.slice(0, -5)
          if (!sourceIds.has(id)) {
            await fs.promises.unlink(`${dir}/databases/${entry}`)
          }
        }
      }
    } catch {
      // databases dir might not exist yet
    }
  },

  loadCommits: async (workspaceId) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
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
      set({ commits: [] })
    }
  },

  refreshStatus: async (workspaceId) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    try {
      await get().syncWorkspaceToGit(workspaceId)
      const matrix = await git.statusMatrix({ fs, dir })
      let modified = 0
      let added = 0
      let deleted = 0
      for (const row of matrix) {
        const [, head, workdir] = row as [string, number, number, number]
        if (head === 0 && workdir === 2) added++
        else if (head === 1 && workdir === 0) deleted++
        else if (head === 1 && workdir === 2) modified++
      }
      set({ fileChanges: { modified, added, deleted } })
    } catch {
      set({ fileChanges: { modified: 0, added: 0, deleted: 0 } })
    }
  },

  createCommit: async (workspaceId, message) => {
    set({ loading: true })
    try {
      await enqueue(async () => {
        const fs = getFs(workspaceId)
        const dir = getDir(workspaceId)

        await get().syncWorkspaceToGit(workspaceId)

        const matrix = await git.statusMatrix({ fs, dir })
        for (const row of matrix) {
          const [filepath, , workdir] = row as [string, number, number, number]
          if (workdir === 0) {
            await git.remove({ fs, dir, filepath })
          } else {
            await git.add({ fs, dir, filepath })
          }
        }

        await git.commit({ fs, dir, message, author: GIT_AUTHOR })
      })
      await get().loadCommits(workspaceId)
      set({ fileChanges: { modified: 0, added: 0, deleted: 0 } })
    } finally {
      set({ loading: false })
    }
  },

  commitPluginChange: async (workspaceId, pluginId, pluginName, changeType) => {
    await enqueue(async () => {
      const { getStorage } = await import('@/lib/storage')
      const fs = getFs(workspaceId)
      const dir = getDir(workspaceId)

      await get().ensureRepo(workspaceId)
      await ensureDirExists(fs, `${dir}/plugins`)

      if (changeType === 'delete') {
        await removeDirRecursive(fs, `${dir}/plugins/${pluginId}`)
        try {
          // Stage all removed files in the plugin dir
          const matrix = await git.statusMatrix({ fs, dir })
          for (const row of matrix) {
            const [filepath, , workdir] = row as [string, number, number, number]
            if (filepath.startsWith(`plugins/${pluginId}/`)) {
              if (workdir === 0) await git.remove({ fs, dir, filepath })
            }
          }
        } catch {
          // ignore
        }
      } else {
        const plugin = await getStorage().userPlugins.getById(pluginId)
        if (!plugin) return
        await ensureDirExists(fs, `${dir}/plugins/${pluginId}`)
        for (const [filename, content] of Object.entries(plugin.files)) {
          await fs.promises.writeFile(`${dir}/plugins/${pluginId}/${filename}`, content)
          await git.add({ fs, dir, filepath: `plugins/${pluginId}/${filename}` })
        }
      }

      const messages: Record<string, string> = {
        create: `Create plugin: ${pluginName}`,
        update: `Update plugin: ${pluginName}`,
        delete: `Delete plugin: ${pluginName}`,
      }

      await git.commit({
        fs,
        dir,
        message: messages[changeType],
        author: GIT_AUTHOR,
      })
    })
  },

  commitWikiPageChange: async (workspaceId, page, changeType) => {
    await enqueue(async () => {
      const { useWikiStore } = await import('@/stores/wiki-store')
      const fs = getFs(workspaceId)
      const dir = getDir(workspaceId)

      await get().ensureRepo(workspaceId)
      await ensureDirExists(fs, `${dir}/wiki`)

      const filePath = `wiki/${page.id}.md`

      if (changeType === 'delete') {
        // Remove the file
        try {
          await fs.promises.unlink(`${dir}/${filePath}`)
        } catch {
          // file might not exist in git yet
        }
        try {
          await git.remove({ fs, dir, filepath: filePath })
        } catch {
          // file might not be tracked
        }
      } else {
        // Write the page content
        await fs.promises.writeFile(`${dir}/${filePath}`, page.content)
        await git.add({ fs, dir, filepath: filePath })
      }

      // Update _index.json
      const pages = useWikiStore.getState().pages.filter((p) => p.workspaceId === workspaceId)
      const index = pages.map(pageToMeta)
      await fs.promises.writeFile(`${dir}/wiki/_index.json`, JSON.stringify(index, null, 2))
      await git.add({ fs, dir, filepath: 'wiki/_index.json' })

      // Build commit message
      const messages: Record<string, string> = {
        create: `Create wiki page: ${page.title}`,
        update: `Update wiki page: ${page.title}`,
        delete: `Delete wiki page: ${page.title}`,
      }

      await git.commit({
        fs,
        dir,
        message: messages[changeType],
        author: GIT_AUTHOR,
      })
    })
  },

  getFileCommits: async (workspaceId, pageId) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    try {
      const log = await git.log({ fs, dir, depth: 50, filepath: `wiki/${pageId}.md` })
      return log.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message,
        author: {
          name: entry.commit.author.name,
          email: entry.commit.author.email,
          timestamp: entry.commit.author.timestamp,
        },
        parents: entry.commit.parent,
      }))
    } catch {
      return []
    }
  },

  readFileAtCommit: async (workspaceId, oid, pageId) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    try {
      const { blob } = await git.readBlob({ fs, dir, oid, filepath: `wiki/${pageId}.md` })
      return new TextDecoder().decode(blob)
    } catch {
      return null
    }
  },

  restoreWikiPage: async (workspaceId, pageId, oid) => {
    const content = await get().readFileAtCommit(workspaceId, oid, pageId)
    if (content === null) return
    const { useWikiStore } = await import('@/stores/wiki-store')
    await useWikiStore.getState().savePage(pageId, content)
  },

  setRemoteConfig: (config) => set({ remoteConfig: config }),
  clearRemoteConfig: () => set({ remoteConfig: null }),

  exportZip: async (workspaceId) => {
    // Ensure all workspace content is written to LightningFS before export
    await get().ensureRepo(workspaceId)
    await get().syncWorkspaceToGit(workspaceId)

    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    const zip = new JSZip()

    async function addDir(fsPath: string, zipPath: string) {
      const entries = await fs.promises.readdir(fsPath)
      for (const entry of entries) {
        if (entry === '.git') continue
        const full = `${fsPath}/${entry}`
        const stat = await fs.promises.stat(full)
        if (stat.isDirectory()) {
          await addDir(full, zipPath ? `${zipPath}/${entry}` : entry)
        } else {
          const content = await fs.promises.readFile(full, { encoding: 'utf8' })
          zip.file(zipPath ? `${zipPath}/${entry}` : entry, content as string)
        }
      }
    }

    await addDir(dir, '')

    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `workspace-export.zip`
    a.click()
    URL.revokeObjectURL(url)
  },
}))
