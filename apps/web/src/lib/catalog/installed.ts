/**
 * Match catalog entries against what is already installed locally.
 *
 * Identity is `lineageId` — the cross-instance id an export carries verbatim, so the same
 * published work stays recognizable even though its local PK was regenerated on import.
 * The git remote URL is the fallback, tried whenever lineage matched nothing: an entry
 * published before lineage stamping carries none, and a repo can publish none while the
 * catalog entry does — the install then mints a local lineage that matches no one, and
 * only the URL identifies what it came from.
 *
 * Staleness compares the entry's published `version` against the installed entity's own
 * `version`. When either side declares none it is treated as up to date: the cloned
 * commit is NOT persisted on the entity (`GitRemoteConfig.syncedOid` is stripped before
 * storage, the real sync state lives server-side), so there is no second signal to fall
 * back on, and a permanent Update button no click could clear would be worse than none.
 */

import { getStorage } from '@/lib/storage'
import type { Storage } from '@/lib/storage'
import type { CatalogEntry, CatalogEntryType } from './types'

export type InstalledState = 'not-installed' | 'installed' | 'outdated'

export interface InstalledEntity {
  /** Local PK (project.uid for a project). */
  id: string
  workspaceId?: string
  version?: string
}

/** What the catalog page needs to know about one entry, per workspace. */
export interface InstalledInfo extends InstalledEntity {
  state: Exclude<InstalledState, 'not-installed'>
}

/** The subset of a stored entity this module reads. */
interface LocalRow {
  id?: string
  uid?: string
  workspaceId?: string
  lineageId?: string
  version?: string
  gitRemoteConfig?: { url?: string }
}

async function rowsOf(type: CatalogEntryType, storage: Storage): Promise<LocalRow[]> {
  const all = async (): Promise<unknown[]> => {
    switch (type) {
      case 'sql-collection': return storage.sqlScriptCollections.getAll()
      case 'etl-pipeline': return storage.etlPipelines.getAll()
      case 'data-catalog': return storage.dataCatalogs.getAll()
      case 'dq-rule-set': return storage.dqRuleSets.getAll()
      case 'mapping-project': return storage.mappingProjects.getAll()
      case 'project': return storage.projects.getAll()
      case 'schema-preset': return storage.schemaPresets.getAll()
      case 'database': return storage.dataSources.getAll()
      case 'workspace': return storage.workspaces.getAll()
    }
  }
  try {
    return ((await all()) as LocalRow[]) ?? []
  } catch {
    return []
  }
}

/** Normalize a git URL so `.git`, a trailing slash and case don't defeat the match. */
export function normalizeGitUrl(url: string | undefined): string {
  if (!url) return ''
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '')
}

/** The row's local key: `uid` for a project, `id` for everything else. */
function pkOf(row: LocalRow): string {
  return row.uid ?? row.id ?? ''
}

/**
 * Is the local copy behind the catalog entry?
 *
 * Deliberately conservative: a version missing on either side means "not outdated",
 * since an unversioned entry would otherwise show an Update button no click could clear.
 */
export function isOutdated(entry: CatalogEntry, local: InstalledEntity): boolean {
  return !!entry.version && !!local.version && entry.version !== local.version
}

/**
 * Index the installed copies of every catalog entry, keyed by entry id.
 *
 * Scoped to one workspace: the same entry installed in *another* workspace must still
 * read as installable here, since installing targets the selected workspace.
 */
export async function findInstalled(
  entries: CatalogEntry[],
  workspaceId: string,
  storage: Storage = getStorage(),
): Promise<Record<string, InstalledInfo>> {
  const types = [...new Set(entries.map((e) => e.type))]
  const byType = new Map<CatalogEntryType, LocalRow[]>()
  await Promise.all(
    types.map(async (type) => {
      const rows = await rowsOf(type, storage)
      // A workspace has no parent workspace to be scoped to — it IS the scope, so
      // filtering it by workspaceId would discard every row and always read as
      // "not installed".
      const scoped = type === 'workspace'
        ? rows
        : rows.filter((r) => !workspaceId || r.workspaceId === workspaceId)
      byType.set(type, scoped)
    }),
  )

  const result: Record<string, InstalledInfo> = {}
  for (const entry of entries) {
    const rows = byType.get(entry.type) ?? []
    const entryUrl = normalizeGitUrl(entry.git.url)
    // Lineage first, then the remote URL — not one OR the other. When both sides
    // carry a lineage they used to be compared and that was the end of it, so an
    // entity whose REPO publishes no lineage (the app then mints a local one)
    // never matched its own catalog entry, even though both name the same
    // remote: the entry stayed "Install" no matter how many times it was
    // installed. The URL is the weaker identity — a fork shares it — so it only
    // gets a say once lineage has failed to answer.
    const match =
      rows.find((r) => !!entry.lineageId && !!r.lineageId && r.lineageId === entry.lineageId) ??
      rows.find((r) => !!entryUrl && normalizeGitUrl(r.gitRemoteConfig?.url) === entryUrl)
    if (!match) continue
    const local: InstalledEntity = {
      id: pkOf(match),
      workspaceId: match.workspaceId,
      version: match.version,
    }
    result[entry.id] = { ...local, state: isOutdated(entry, local) ? 'outdated' : 'installed' }
  }
  return result
}
