import { apiRequest } from '@/lib/api-client'
import type { IdeFileStorage } from '@/lib/storage'
import type { IdeFile } from '@/types'

/**
 * Server-mode IDE file storage. The backend treats projects/<uid>/scripts/ as the
 * single source of truth (see project_fs.py): the tree is scanned from disk and
 * files are addressed by their relative PATH. To fit the store's id-keyed
 * IdeFileStorage interface without a uuid mapping table, server-mode nodes use
 * their relative path AS the id (parentId = parent's path, or null at the root).
 * Renames/moves therefore change ids — the store reloads the tree after each
 * mutation (loadProjectFiles), which also surfaces files added outside the app.
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

// Track the project a given node id belongs to (needed for id-keyed update/delete,
// which don't carry the projectUid). Rebuilt on every getByProject.
const _projectByPath = new Map<string, string>()

function toIdeFile(projectUid: string, n: ServerNode): IdeFile {
  // Use the relative path as the stable id so parentId chains resolve in the store.
  const parentPath = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : null
  _projectByPath.set(n.path, projectUid)
  return {
    id: n.path,
    projectUid,
    name: n.name,
    type: n.type,
    parentId: parentPath,
    content: n.content ?? undefined,
    language: n.language ?? undefined,
    createdAt: '',
  }
}

/** Build a file's relative path from its parent path (id) + name. */
function pathFor(parentId: string | null, name: string): string {
  return parentId ? `${parentId}/${name}` : name
}

export const apiIdeFileStorage: IdeFileStorage = {
  getByProject: async (projectUid) => {
    const nodes = await apiRequest<ServerNode[]>(
      `${BASE}?projectUid=${encodeURIComponent(projectUid)}`,
    )
    return nodes.map((n) => toIdeFile(projectUid, n))
  },

  getById: async () => {
    // Callers resolve files via getByProject (the store holds the tree in memory).
    return undefined
  },

  create: async (file) => {
    const path = pathFor(file.parentId, file.name)
    _projectByPath.set(path, file.projectUid)
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
    // id is the current relative path. Content saves write in place; a name change
    // is a move to a sibling path (the store reloads the tree afterwards).
    const projectUid = _projectByPath.get(id)
    if (!projectUid) return
    if (changes.content !== undefined) {
      await apiRequest(`${BASE}/content`, {
        method: 'PUT',
        body: JSON.stringify({ projectUid, path: id, content: changes.content }),
      })
    }
    if (changes.name !== undefined) {
      const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null
      const newPath = pathFor(parent, changes.name)
      await apiRequest(`${BASE}/move`, {
        method: 'POST',
        body: JSON.stringify({ projectUid, path: id, newPath }),
      })
    }
    if (changes.parentId !== undefined) {
      const name = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
      const newPath = pathFor(changes.parentId ?? null, name)
      await apiRequest(`${BASE}/move`, {
        method: 'POST',
        body: JSON.stringify({ projectUid, path: id, newPath }),
      })
    }
  },

  delete: async (id) => {
    const projectUid = _projectByPath.get(id)
    if (!projectUid) return
    await apiRequest(`${BASE}/delete`, {
      method: 'POST',
      body: JSON.stringify({ projectUid, path: id }),
    })
  },

  deleteByProject: async () => {
    // The whole project dir is removed with the project on the server; no-op here.
  },
}
