import { apiRequest } from '@/lib/api-client'
import type { IdeFileStorage } from '@/lib/storage'
import type { IdeFile } from '@/types'

/**
 * Server-mode IDE file storage. The backend treats projects/<uid>/scripts/ as the
 * single source of truth (see project_fs.py): the tree is scanned from disk. The
 * scripts/ directory itself is surfaced as a synthetic root folder named "scripts"
 * (path ""), so the IDE shows exactly one scripts folder and never doubles it.
 *
 * Nodes keep the backend's derived id; this adapter caches id→(projectUid, path)
 * from the last scan so id-keyed create/update/delete can resolve the on-disk path.
 * Renames/moves change ids — the store reloads the tree after each mutation
 * (reloadFromDisk), which also surfaces files added outside the app.
 */

const BASE = '/ide-files'

interface ServerNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  path: string
  language: string | null
  order: number
  content: string | null
}

// id → { projectUid, path } from the last getByProject scan (path is relative to
// scripts/; the synthetic root's path is "").
const _meta = new Map<string, { projectUid: string; path: string }>()

function toIdeFile(projectUid: string, n: ServerNode): IdeFile {
  _meta.set(n.id, { projectUid, path: n.path })
  return {
    id: n.id,
    projectUid,
    name: n.name,
    type: n.type,
    parentId: n.parentId,
    content: n.content ?? undefined,
    language: n.language ?? undefined,
    createdAt: '',
  }
}

/** Relative path of a new child = parent's path + name (parent "" = scripts root). */
function childPath(parentId: string | null, name: string): string {
  if (!parentId) return name
  const parent = _meta.get(parentId)
  const prefix = parent && parent.path ? `${parent.path}/` : ''
  return `${prefix}${name}`
}

export const apiIdeFileStorage: IdeFileStorage = {
  getByProject: async (projectUid) => {
    const nodes = await apiRequest<ServerNode[]>(
      `${BASE}?projectUid=${encodeURIComponent(projectUid)}`,
    )
    return nodes.map((n) => toIdeFile(projectUid, n))
  },

  getById: async () => undefined,

  create: async (file) => {
    // The synthetic "scripts" root already exists on disk as scripts/ — skip it.
    if (file.name === 'scripts' && file.parentId === null && file.type === 'folder') return
    const path = childPath(file.parentId, file.name)
    await apiRequest(BASE, {
      method: 'POST',
      body: JSON.stringify({
        projectUid: file.projectUid,
        path,
        type: file.type,
        content: file.content ?? '',
      }),
    })
  },

  update: async (id, changes) => {
    const meta = _meta.get(id)
    if (!meta) return
    const { projectUid, path } = meta
    if (changes.content !== undefined) {
      await apiRequest(`${BASE}/content`, {
        method: 'PUT',
        body: JSON.stringify({ projectUid, path, content: changes.content }),
      })
    }
    if (changes.name !== undefined) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const newPath = parent ? `${parent}/${changes.name}` : changes.name
      await apiRequest(`${BASE}/move`, {
        method: 'POST',
        body: JSON.stringify({ projectUid, path, newPath }),
      })
    }
    if (changes.parentId !== undefined) {
      const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
      const newPath = childPath(changes.parentId ?? null, name)
      await apiRequest(`${BASE}/move`, {
        method: 'POST',
        body: JSON.stringify({ projectUid, path, newPath }),
      })
    }
  },

  delete: async (id) => {
    const meta = _meta.get(id)
    if (!meta) return
    await apiRequest(`${BASE}/delete`, {
      method: 'POST',
      body: JSON.stringify({ projectUid: meta.projectUid, path: meta.path }),
    })
  },

  deleteByProject: async () => {
    // The whole project dir is removed with the project on the server; no-op here.
  },
}
