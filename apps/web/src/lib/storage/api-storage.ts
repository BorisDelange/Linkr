import { apiOrganizationStorage } from '@/lib/api/organizations'
import { apiProjectStorage } from '@/lib/api/projects'
import { apiRoleStorage } from '@/lib/api/roles'
import { apiSchemaPresetStorage } from '@/lib/api/schema-presets'
import { apiUserStorage } from '@/lib/api/users'
import { apiWikiPageStorage } from '@/lib/api/wiki-pages'
import { apiWorkspaceStorage } from '@/lib/api/workspaces'
import type { Storage } from '@/lib/storage'
import { createIDBStorage } from '@/lib/storage/idb-storage'

/**
 * Server-mode Storage: API-backed where an adapter exists, IndexedDB otherwise.
 *
 * As each entity is migrated to the backend, add its API adapter to the override
 * list below; the IDB fallback shrinks until it only serves local (front-only) mode.
 */
export function createAPIStorage(): Storage {
  const idb = createIDBStorage()
  return {
    ...idb,
    workspaces: apiWorkspaceStorage,
    users: apiUserStorage,
    roles: apiRoleStorage,
    projects: apiProjectStorage,
    organizations: apiOrganizationStorage,
    schemaPresets: apiSchemaPresetStorage,
    wikiPages: apiWikiPageStorage,
  }
}
