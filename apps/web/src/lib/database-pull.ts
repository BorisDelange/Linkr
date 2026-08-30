/**
 * The database pull: all or nothing, data included.
 *
 * Every other scope resolves a pull item by item. This one cannot, and the reason
 * is the asymmetry the database format is built on: the app publishes metadata
 * only (`buildDataSourceFolder`), while a repo authored outside it may ship the
 * tables themselves under `data/`. Pulling is therefore the ONE path by which
 * rows enter, and `applyClonedDatabase` takes the tree whole — it drops the
 * source's files, writes the ones the repo carries, remounts and recomputes the
 * stats. There is no partial state in between: a mapping accepted without its
 * matching Parquet describes tables that are not there.
 *
 * So the plan carries a single whole-repo row. Accepting it replaces the local
 * database with the remote one, local data included; declining keeps everything.
 */
import JSZip from 'jszip'
import { CONTENT_FILE, ENTITY_MANIFEST, MANIFEST } from '@linkr/format'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import { applyClonedEntity } from '@/lib/entity-io'
import { getStorage, type Storage } from '@/lib/storage'

/** What the remote holds, read once so the panel can describe the pull before
 *  the user commits to it. */
export interface PreparedDatabasePull {
  /** The cloned tree, kept for the apply — re-cloning to write it would fetch
   *  the (LFS-resolved, possibly large) data a second time. */
  zip: JSZip
  /** Table names the remote declares in `tables[]`. */
  tables: string[]
  /** Of those, the ones whose `data/<table>.parquet` is actually in the tree —
   *  what a pull would really write. A repo that gitignores its data declares
   *  tables it does not ship, and pulling it brings no rows. */
  dataTables: string[]
  /** Total bytes of the data files that would be written. */
  dataBytes: number
  /** Localized name the remote gives the database, for the row label. */
  remoteName: string | null
  clonedOid: string | null
  branch: string
}

/** Files the pull would write, other than the data. Named so the row can say what
 *  it replaces rather than only what it adds. */
export const DATABASE_PULL_METADATA_FILES = [
  ENTITY_MANIFEST,
  CONTENT_FILE.schemaMapping,
  CONTENT_FILE.schemaDdl,
]

/** Clone the database's linked remote and read what a pull would bring in. */
export async function prepareDatabasePull(
  sourceId: string,
  branch: string,
  storage: Storage = getStorage(),
): Promise<PreparedDatabasePull> {
  const source = await storage.dataSources.getById(sourceId)
  const url = source?.gitRemoteConfig?.url
  if (!url) throw new Error('Database is not linked to a git remote')

  const cloned = await gitCloneToZip(cleanGitUrl(url), branch)
  // Not parseImportZip: it decodes every entry as text, which would corrupt the
  // Parquet. The apply reads the same JSZip, so the tree is loaded once.
  const zip = await JSZip.loadAsync(cloned.blob)

  const metaEntry = zip.files[ENTITY_MANIFEST] ?? zip.files[MANIFEST.database]
  if (!metaEntry) throw new Error('Cloned repository is not a valid database export')
  const meta = JSON.parse(await metaEntry.async('string')) as {
    tables?: string[]
    name?: Record<string, string> | string
  }

  const tables = Array.isArray(meta.tables) ? meta.tables : []
  const dataTables: string[] = []
  let dataBytes = 0
  for (const table of tables) {
    const entry = zip.files[`data/${table}.parquet`]
    if (!entry || entry.dir) continue
    dataTables.push(table)
    // `_data.uncompressedSize` is JSZip's own record of the entry size; reading
    // each file just to measure it would load the whole database into memory.
    dataBytes += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
  }

  const name = meta.name
  return {
    zip,
    tables,
    dataTables,
    dataBytes,
    remoteName: typeof name === 'string' ? name : (name?.en ?? Object.values(name ?? {})[0] ?? null),
    clonedOid: cloned.oid,
    branch,
  }
}

/**
 * Replace the local database with the remote one — metadata, mapping, docs and
 * whatever rows the repo carries. Local data files are dropped first, so the
 * result is the repo's content and nothing of what was there before.
 *
 * `accepted` false records a deliberate refusal: nothing is written, but the
 * review cursor still advances so the banner clears and the push unblocks.
 *
 * Throws when the write fails, so a failed apply cannot read as a pull.
 */
export async function applyDatabasePull(
  sourceId: string,
  prepared: PreparedDatabasePull,
  accepted: boolean,
  storage: Storage = getStorage(),
): Promise<void> {
  const { zip, branch, clonedOid } = prepared

  if (accepted) {
    const source = await storage.dataSources.getById(sourceId)
    if (!source) throw new Error('database-pull: database no longer exists')
    // Keep the link: applyClonedEntity rebuilds the row, and a database that
    // forgot its own remote mid-pull would lose the panel that ran the pull.
    const ok = await applyClonedEntity(
      zip,
      'database',
      sourceId,
      storage,
      source.workspaceId,
      source.gitRemoteConfig,
    )
    if (!ok) throw new Error('database-pull: changes could not be written')
  }

  // Two cursors, two meanings (see etl-pull.ts). Taking the repo whole IS the
  // complete pull, so the content anchor may advance; a refusal moves only the
  // review cursor, which is what unblocks the push without claiming we hold the
  // commit's content. (Server mode only.)
  if (clonedOid) {
    await gitSetSyncState('databases', sourceId, branch, clonedOid, !accepted)
  }
}
