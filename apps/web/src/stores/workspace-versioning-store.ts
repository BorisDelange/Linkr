import { Buffer } from 'buffer'
// isomorphic-git requires a global Buffer polyfill in browser environments
if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
}

import { create } from 'zustand'
import git from 'isomorphic-git'
import LightningFS from '@isomorphic-git/lightning-fs'
import JSZip from 'jszip'
import type { GitCommit, GitRemoteConfig, WikiPage, CommitFileChange, FileChangeType, RestoreResult } from '@/types'

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

const COMMITS_PAGE_SIZE = 50

export type VersionedEntityType = 'plugin' | 'schema' | 'database'

function getEntityGitPath(entityType: VersionedEntityType, entityId: string): string {
  switch (entityType) {
    case 'plugin':   return `plugins/${entityId}`
    case 'schema':   return `schemas/${entityId}.json`
    case 'database': return `databases/${entityId}.json`
  }
}

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

  getFileCommits: (workspaceId: string, pageId: string) => Promise<GitCommit[]>
  readFileAtCommit: (workspaceId: string, oid: string, pageId: string) => Promise<string | null>
  restoreWikiPage: (workspaceId: string, pageId: string, oid: string) => Promise<void>
  getCommitFiles: (workspaceId: string, oid: string) => Promise<CommitFileChange[]>
  getFileDiff: (workspaceId: string, oid: string, filepath: string) => Promise<{ filepath: string; changeType: FileChangeType; oldContent: string; newContent: string; changes: import('diff').Change[] } | null>
  getEntityCommits: (workspaceId: string, entityType: VersionedEntityType, entityId: string) => Promise<GitCommit[]>
  restoreEntity: (workspaceId: string, entityType: VersionedEntityType, entityId: string, oid: string) => Promise<RestoreResult>
  restoreToCommit: (workspaceId: string, oid: string) => Promise<RestoreResult>

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
  hasMoreCommits: false,
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
      const log = await git.log({ fs, dir, depth: COMMITS_PAGE_SIZE + 1 })
      const hasMore = log.length > COMMITS_PAGE_SIZE
      const entries = hasMore ? log.slice(0, COMMITS_PAGE_SIZE) : log
      const commits: GitCommit[] = entries.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message,
        author: {
          name: entry.commit.author.name,
          email: entry.commit.author.email,
          timestamp: entry.commit.author.timestamp,
        },
        parents: entry.commit.parent,
      }))
      set({ commits, hasMoreCommits: hasMore })
    } catch {
      set({ commits: [], hasMoreCommits: false })
    }
  },

  loadMoreCommits: async (workspaceId) => {
    const { commits: existing } = get()
    if (existing.length === 0) return
    const lastOid = existing[existing.length - 1].oid
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    try {
      // Fetch from last known commit onward (depth includes the ref commit itself)
      const log = await git.log({ fs, dir, depth: COMMITS_PAGE_SIZE + 2, ref: lastOid })
      // Skip the first entry (it's the lastOid itself, already loaded)
      const newEntries = log.slice(1)
      const hasMore = newEntries.length > COMMITS_PAGE_SIZE
      const entries = hasMore ? newEntries.slice(0, COMMITS_PAGE_SIZE) : newEntries
      const newCommits: GitCommit[] = entries.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message,
        author: {
          name: entry.commit.author.name,
          email: entry.commit.author.email,
          timestamp: entry.commit.author.timestamp,
        },
        parents: entry.commit.parent,
      }))
      set({ commits: [...existing, ...newCommits], hasMoreCommits: hasMore })
    } catch {
      set({ hasMoreCommits: false })
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

  commitSchemaPresetChange: async (workspaceId, presetId, presetName, changeType) => {
    await enqueue(async () => {
      const { getStorage } = await import('@/lib/storage')
      const fs = getFs(workspaceId)
      const dir = getDir(workspaceId)

      await get().ensureRepo(workspaceId)
      await ensureDirExists(fs, `${dir}/schemas`)

      const filepath = `schemas/${presetId}.json`

      if (changeType === 'delete') {
        try { await fs.promises.unlink(`${dir}/${filepath}`) } catch { /* may not exist */ }
        try { await git.remove({ fs, dir, filepath }) } catch { /* may not be tracked */ }
      } else {
        const preset = await getStorage().schemaPresets.getById(presetId)
        if (!preset) return
        const { presetId: pid, mapping, createdAt, updatedAt } = preset
        await fs.promises.writeFile(
          `${dir}/${filepath}`,
          JSON.stringify({ presetId: pid, mapping, createdAt, updatedAt }, null, 2),
        )
        await git.add({ fs, dir, filepath })
      }

      const messages: Record<string, string> = {
        create: `Create schema preset: ${presetName}`,
        update: `Update schema preset: ${presetName}`,
        delete: `Delete schema preset: ${presetName}`,
      }

      await git.commit({ fs, dir, message: messages[changeType], author: GIT_AUTHOR })
    })
  },

  commitDataSourceChange: async (workspaceId, sourceId, sourceName, changeType) => {
    await enqueue(async () => {
      const { getStorage } = await import('@/lib/storage')
      const fs = getFs(workspaceId)
      const dir = getDir(workspaceId)

      await get().ensureRepo(workspaceId)
      await ensureDirExists(fs, `${dir}/databases`)

      const filepath = `databases/${sourceId}.json`

      if (changeType === 'delete') {
        try { await fs.promises.unlink(`${dir}/${filepath}`) } catch { /* may not exist */ }
        try { await git.remove({ fs, dir, filepath }) } catch { /* may not be tracked */ }
      } else {
        const ds = await getStorage().dataSources.getById(sourceId)
        if (!ds) return
        const { id, alias, name, description, sourceType, connectionConfig, schemaMapping, status, createdAt, updatedAt } = ds
        await fs.promises.writeFile(
          `${dir}/${filepath}`,
          JSON.stringify({ id, alias, name, description, sourceType, connectionConfig, schemaMapping, status, createdAt, updatedAt }, null, 2),
        )
        await git.add({ fs, dir, filepath })
      }

      const messages: Record<string, string> = {
        create: `Create database: ${sourceName}`,
        update: `Update database: ${sourceName}`,
        delete: `Delete database: ${sourceName}`,
      }

      await git.commit({ fs, dir, message: messages[changeType], author: GIT_AUTHOR })
    })
  },

  getCommitFiles: async (workspaceId, oid) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)

    // Recursively collect all blob paths and their oids from a tree
    async function collectFiles(treeOid: string, prefix: string): Promise<Map<string, string>> {
      const result = new Map<string, string>()
      const { tree } = await git.readTree({ fs, dir, oid: treeOid })
      for (const entry of tree) {
        const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path
        if (entry.type === 'tree') {
          const sub = await collectFiles(entry.oid, fullPath)
          for (const [k, v] of sub) result.set(k, v)
        } else if (entry.type === 'blob') {
          result.set(fullPath, entry.oid)
        }
      }
      return result
    }

    try {
      const { commit: commitObj } = await git.readCommit({ fs, dir, oid })
      const parentOid = commitObj.parent[0]

      const commitFiles = await collectFiles(commitObj.tree, '')
      const parentFiles = parentOid
        ? await collectFiles((await git.readCommit({ fs, dir, oid: parentOid })).commit.tree, '')
        : new Map<string, string>()

      const changes: CommitFileChange[] = []

      // Find added and modified files
      for (const [filepath, blobOid] of commitFiles) {
        const parentBlobOid = parentFiles.get(filepath)
        if (!parentBlobOid) {
          changes.push({ filepath, changeType: 'added', parentBlobOid: null, commitBlobOid: blobOid })
        } else if (parentBlobOid !== blobOid) {
          changes.push({ filepath, changeType: 'modified', parentBlobOid, commitBlobOid: blobOid })
        }
      }

      // Find deleted files
      for (const [filepath, blobOid] of parentFiles) {
        if (!commitFiles.has(filepath)) {
          changes.push({ filepath, changeType: 'deleted', parentBlobOid: blobOid, commitBlobOid: null })
        }
      }

      return changes
    } catch {
      return []
    }
  },

  getFileDiff: async (workspaceId, oid, filepath) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)

    try {
      const [entry] = await git.log({ fs, dir, depth: 1, ref: oid })
      if (!entry) return null
      const parentOid = entry.commit.parent[0]

      let oldContent = ''
      let newContent = ''

      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath })
        newContent = new TextDecoder().decode(blob)
      } catch {
        // File deleted in this commit
      }

      if (parentOid) {
        try {
          const { blob } = await git.readBlob({ fs, dir, oid: parentOid, filepath })
          oldContent = new TextDecoder().decode(blob)
        } catch {
          // File didn't exist in parent
        }
      }

      const { diffLines } = await import('diff')
      const changes = diffLines(oldContent, newContent)

      const changeType: FileChangeType = !oldContent && newContent ? 'added'
        : oldContent && !newContent ? 'deleted'
        : 'modified'

      return { filepath, changeType, oldContent, newContent, changes }
    } catch {
      return null
    }
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

  getEntityCommits: async (workspaceId, entityType, entityId) => {
    const fs = getFs(workspaceId)
    const dir = getDir(workspaceId)
    const filepath = getEntityGitPath(entityType, entityId)
    try {
      const log = await git.log({ fs, dir, depth: 100, filepath })
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

  restoreEntity: async (workspaceId, entityType, entityId, oid) => {
    return enqueue(async () => {
      const { getStorage } = await import('@/lib/storage')
      const fs = getFs(workspaceId)
      const dir = getDir(workspaceId)
      const storage = getStorage()
      const restoredFiles: string[] = []
      const pathPrefix = getEntityGitPath(entityType, entityId)

      await get().ensureRepo(workspaceId)

      // Read entity files from the target commit tree
      const { commit: targetCommit } = await git.readCommit({ fs, dir, oid })
      const fileContents: Record<string, string> = {}

      async function readTreeRecursive(treeOid: string, prefix: string) {
        const { tree } = await git.readTree({ fs, dir, oid: treeOid })
        for (const entry of tree) {
          const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path
          if (entry.type === 'tree') {
            // For plugins (directory), recurse into the matching subtree
            if (fullPath.startsWith(pathPrefix) || pathPrefix.startsWith(fullPath)) {
              await readTreeRecursive(entry.oid, fullPath)
            }
          } else if (entry.type === 'blob') {
            if (fullPath === pathPrefix || fullPath.startsWith(pathPrefix + '/')) {
              const { blob } = await git.readBlob({ fs, dir, oid: entry.oid })
              fileContents[fullPath] = new TextDecoder().decode(blob)
            }
          }
        }
      }
      await readTreeRecursive(targetCommit.tree, '')

      // Apply restore to IndexedDB
      let entityName = entityId
      switch (entityType) {
        case 'plugin': {
          const pluginFiles: Record<string, string> = {}
          for (const [filepath, content] of Object.entries(fileContents)) {
            const relativePath = filepath.substring(`plugins/${entityId}/`.length)
            pluginFiles[relativePath] = content
          }
          // Try to extract plugin name from manifest
          try {
            const manifest = JSON.parse(pluginFiles['plugin.json'] ?? '{}')
            entityName = manifest.name?.en ?? entityId
          } catch { /* use entityId */ }
          const existing = await storage.userPlugins.getById(entityId)
          if (existing) {
            await storage.userPlugins.update(entityId, { files: pluginFiles, updatedAt: new Date().toISOString() })
          } else {
            await storage.userPlugins.create({
              id: entityId,
              workspaceId,
              files: pluginFiles,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
          }
          break
        }
        case 'schema': {
          const content = fileContents[pathPrefix]
          if (content) {
            const data = JSON.parse(content)
            entityName = data.mapping?.presetLabel ?? entityId
            await storage.schemaPresets.save({ ...data, workspaceId })
          }
          break
        }
        case 'database': {
          const content = fileContents[pathPrefix]
          if (content) {
            const data = JSON.parse(content)
            entityName = data.name ?? entityId
            const existing = await storage.dataSources.getById(entityId)
            if (existing) {
              await storage.dataSources.update(entityId, {
                alias: data.alias,
                name: data.name,
                description: data.description,
                schemaMapping: data.schemaMapping,
                status: data.status,
              })
            } else {
              await storage.dataSources.create({ ...data, workspaceId })
            }
          }
          break
        }
      }

      // Write restored files to LightningFS and create restore commit
      for (const [filepath, content] of Object.entries(fileContents)) {
        const parts = filepath.split('/')
        for (let i = 1; i < parts.length; i++) {
          const parentPath = `${dir}/${parts.slice(0, i).join('/')}`
          await ensureDirExists(fs, parentPath)
        }
        await fs.promises.writeFile(`${dir}/${filepath}`, content)
        await git.add({ fs, dir, filepath })
        restoredFiles.push(filepath)
      }

      const commitOid = await git.commit({
        fs, dir,
        message: `Restore ${entityType}: ${entityName} to ${oid.slice(0, 7)}`,
        author: GIT_AUTHOR,
      })

      await get().loadCommits(workspaceId)
      return { success: true, restoredFiles, commitOid } as RestoreResult
    }) as Promise<RestoreResult>
  },

  restoreToCommit: async (workspaceId, oid) => {
    return enqueue(async () => {
      const { getStorage } = await import('@/lib/storage')
      const { useWikiStore } = await import('@/stores/wiki-store')
      const fs = getFs(workspaceId)
      const dir = getDir(workspaceId)
      const restoredFiles: string[] = []

      await get().ensureRepo(workspaceId)

      // Read all files at the target commit using readCommit + readTree
      const fileContents: Record<string, string> = {}
      async function readTreeRecursive(treeOid: string, prefix: string) {
        const { tree } = await git.readTree({ fs, dir, oid: treeOid })
        for (const entry of tree) {
          const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path
          if (entry.type === 'tree') {
            await readTreeRecursive(entry.oid, fullPath)
          } else if (entry.type === 'blob') {
            const { blob } = await git.readBlob({ fs, dir, oid: entry.oid })
            fileContents[fullPath] = new TextDecoder().decode(blob)
          }
        }
      }
      const { commit: targetCommit } = await git.readCommit({ fs, dir, oid })
      await readTreeRecursive(targetCommit.tree, '')

      // Restore wiki pages from wiki/_index.json + wiki/*.md
      if (fileContents['wiki/_index.json']) {
        const index = JSON.parse(fileContents['wiki/_index.json']) as WikiPageMeta[]
        const wikiStore = useWikiStore.getState()
        const existingPages = wikiStore.pages.filter(p => p.workspaceId === workspaceId)
        const restoredIds = new Set(index.map(m => m.id))

        // Delete pages not in the target commit
        for (const page of existingPages) {
          if (!restoredIds.has(page.id)) {
            await wikiStore.deletePage(page.id)
            restoredFiles.push(`wiki/${page.id}.md (deleted)`)
          }
        }

        // Create or update pages from the target commit
        for (const meta of index) {
          const content = fileContents[`wiki/${meta.id}.md`] ?? ''
          const existing = existingPages.find(p => p.id === meta.id)
          if (existing) {
            await wikiStore.savePage(meta.id, content)
          } else {
            await wikiStore.createPage({
              id: meta.id,
              title: meta.title,
              slug: meta.slug,
              icon: meta.icon,
              parentId: meta.parentId,
              sortOrder: meta.sortOrder,
              template: meta.template,
              owner: meta.owner,
              verified: meta.verified,
              verifiedAt: meta.verifiedAt,
              reviewDueAt: meta.reviewDueAt,
              content,
              workspaceId,
            })
          }
          restoredFiles.push(`wiki/${meta.id}.md`)
        }
      }

      // Restore plugins
      const pluginFiles = Object.entries(fileContents).filter(([p]) => p.startsWith('plugins/'))
      const pluginMap = new Map<string, Record<string, string>>()
      for (const [filepath, content] of pluginFiles) {
        const parts = filepath.split('/')
        if (parts.length >= 3) {
          const pluginId = parts[1]
          const fileName = parts.slice(2).join('/')
          if (!pluginMap.has(pluginId)) pluginMap.set(pluginId, {})
          pluginMap.get(pluginId)![fileName] = content
        }
      }

      const storage = getStorage()
      const existingPlugins = await storage.userPlugins.getByWorkspace(workspaceId)
      const restoredPluginIds = new Set(pluginMap.keys())

      // Delete plugins not in target commit
      for (const plugin of existingPlugins) {
        if (!restoredPluginIds.has(plugin.id)) {
          await storage.userPlugins.delete(plugin.id)
          restoredFiles.push(`plugins/${plugin.id} (deleted)`)
        }
      }

      // Update or create plugins from target commit
      for (const [pluginId, files] of pluginMap) {
        const existing = existingPlugins.find(p => p.id === pluginId)
        if (existing) {
          await storage.userPlugins.update(pluginId, { files })
        } else {
          // Recreate deleted plugin from git snapshot
          const now = new Date().toISOString()
          await storage.userPlugins.create({
            id: pluginId,
            workspaceId,
            files,
            createdAt: now,
            updatedAt: now,
          })
        }
        restoredFiles.push(`plugins/${pluginId}`)
      }

      // Restore schema presets
      const presetFiles = Object.entries(fileContents).filter(([p]) => p.startsWith('schemas/') && p.endsWith('.json'))
      const restoredPresetIds = new Set<string>()

      // Delete presets not in target commit
      const existingPresets = await storage.schemaPresets.getByWorkspace(workspaceId)
      for (const [filepath, content] of presetFiles) {
        const data = JSON.parse(content)
        restoredPresetIds.add(data.presetId)
        // schemaPresets.save does upsert (create or update)
        await storage.schemaPresets.save({ ...data, workspaceId })
        restoredFiles.push(filepath)
      }
      for (const preset of existingPresets) {
        if (!restoredPresetIds.has(preset.presetId)) {
          await storage.schemaPresets.delete(preset.presetId)
          restoredFiles.push(`schemas/${preset.presetId}.json (deleted)`)
        }
      }

      // Restore database configs
      const dbFiles = Object.entries(fileContents).filter(([p]) => p.startsWith('databases/') && p.endsWith('.json'))
      const restoredDbIds = new Set<string>()

      const existingSources = await storage.dataSources.getByWorkspace(workspaceId)
      for (const [filepath, content] of dbFiles) {
        const data = JSON.parse(content)
        restoredDbIds.add(data.id)
        const existing = existingSources.find(s => s.id === data.id)
        if (existing) {
          await storage.dataSources.update(data.id, {
            alias: data.alias,
            name: data.name,
            description: data.description,
            schemaMapping: data.schemaMapping,
            status: data.status,
          })
        } else {
          await storage.dataSources.create({ ...data, workspaceId })
        }
        restoredFiles.push(filepath)
      }
      for (const source of existingSources) {
        if (!restoredDbIds.has(source.id)) {
          await storage.dataSources.delete(source.id)
          restoredFiles.push(`databases/${source.id}.json (deleted)`)
        }
      }

      // Write all restored files to LightningFS and create a restore commit
      for (const [filepath, content] of Object.entries(fileContents)) {
        // Ensure parent directories exist
        const parts = filepath.split('/')
        for (let i = 1; i < parts.length; i++) {
          const parentPath = `${dir}/${parts.slice(0, i).join('/')}`
          await ensureDirExists(fs, parentPath)
        }
        await fs.promises.writeFile(`${dir}/${filepath}`, content)
        await git.add({ fs, dir, filepath })
      }

      const commitOid = await git.commit({
        fs, dir,
        message: `Restore to commit ${oid.slice(0, 7)}`,
        author: GIT_AUTHOR,
      })

      await get().loadCommits(workspaceId)

      return { success: true, restoredFiles, commitOid } as RestoreResult
    }) as Promise<RestoreResult>
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
