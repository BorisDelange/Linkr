/**
 * Install a catalog entry into a workspace.
 *
 * Reuses the git-linked-entity path rather than the per-page ZIP importers:
 *   gitCloneToZip → create a minimal record → applyClonedEntity
 *
 * That is the same sequence `WorkspacesPage.cloneEntityContent` runs for git-linked
 * entities, and it reads the **git repo layout**. The standalone per-page importers read
 * the *standalone export* layout, which differs for dq-rule-sets (`ruleset.json` vs the
 * repo's `rule-set.json`) and schema-presets (which rebuild version/createdAt) — so
 * routing a clone through them would silently fail or lose fields.
 *
 * `applyClonedEntity` only ever *updates* a row (it assumes the workspace import already
 * created one from a pointer), hence the minimal-record step below.
 */

import type JSZip from 'jszip'
import { applyClonedEntity } from '@/lib/entity-io'
import { gitCloneToZip, gitSetSyncState, scopeForLinkedType } from '@/lib/api/git'
import { normalizeGitUrl } from '@/lib/git-clone'
import { isServerMode } from '@/lib/api-client'
import { getStorage } from '@/lib/storage'
import { localized, setLocalized } from '@/lib/localized'
import { stampAuthored } from '@/stores/app-store'
import type { Storage } from '@/lib/storage'
import type { GitRemoteConfig, LocalizedString } from '@/types'
import type { CatalogEntry } from './types'

// A published entity is small (metadata + scripts). This is a guard against a
// hostile/oversized catalog repo, not a real content limit.
const MAX_CLONE_BYTES = 200 * 1024 * 1024

export type InstallFailure =
  | 'server-mode-required'
  | 'clone-failed'
  | 'apply-failed'
  | 'unsupported-type'

export interface InstallResult {
  ok: boolean
  failure?: InstallFailure
  /** Local id of the created entity (project.uid for a project). */
  id?: string
  /** Raw error text, for the inline git-error tooltip. */
  error?: string
}

/** Root metadata file carrying the entity's own id, per type (git repo layout). */
const META_FILE: Record<CatalogEntry['type'], string> = {
  'sql-collection': '_collection.json',
  'etl-pipeline': '_pipeline.json',
  'mapping-project': '_project.json',
  'project': 'project.json',
  'data-catalog': 'catalog.json',
  'dq-rule-set': 'rule-set.json',
  'schema-preset': 'preset.json',
}

/**
 * The portable id declared by that metadata file.
 *
 * A project publishes it as `projectId`: `buildProjectZip` drops `uid` on purpose (the
 * local PK is regenerated on import, so writing it would churn the git diff). Reading
 * only `uid` meant every project install minted a fresh random id, so a second install
 * of the same entry collided with nothing and silently created a duplicate. `uid` is
 * still accepted for repos exported before the switch.
 */
export function idOf(type: CatalogEntry['type'], meta: Record<string, unknown>): string | null {
  const keys = type === 'project'
    ? ['projectId', 'uid']
    : type === 'schema-preset' ? ['presetId'] : ['id']
  for (const key of keys) {
    const value = meta[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

export interface ExistingRow {
  name?: unknown
  lineageId?: string
  gitRemoteConfig?: { url?: string } | null
  workspaceId?: string
}

/** Look up an existing row of this type by id. */
async function findExisting(
  type: CatalogEntry['type'],
  id: string,
  storage: Storage,
): Promise<ExistingRow | null> {
  const get = async (): Promise<unknown> => {
    switch (type) {
      case 'sql-collection': return storage.sqlScriptCollections.getById(id)
      case 'etl-pipeline': return storage.etlPipelines.getById(id)
      case 'data-catalog': return storage.dataCatalogs.getById(id)
      case 'dq-rule-set': return storage.dqRuleSets.getById(id)
      case 'mapping-project': return storage.mappingProjects.getById(id)
      // Projects are keyed by uid, and getById IS that lookup (see ProjectStorage).
      case 'project': return storage.projects.getById(id)
      case 'schema-preset': return storage.schemaPresets.getById(id)
    }
  }
  try {
    return ((await get()) as ExistingRow | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Whether an existing local row is genuinely the SAME published entity as `entry`
 * (so overwriting it is an update), rather than an unrelated entity that merely
 * shares the id the catalog declares. A hostile or careless catalog entry must
 * never be able to destroy a local entity by id-collision: only a matching
 * lineage or git remote counts as identity.
 */
export function isSameEntity(row: ExistingRow, entry: CatalogEntry): boolean {
  if (entry.lineageId && row.lineageId && row.lineageId === entry.lineageId) return true
  const rowUrl = row.gitRemoteConfig?.url
  if (rowUrl && entry.git.url && normalizeGitUrl(rowUrl) === normalizeGitUrl(entry.git.url)) {
    return true
  }
  return false
}

/** Remove the parent row before an overwrite. Child rows are cleared by applyClonedEntity. */
async function deleteExisting(
  type: CatalogEntry['type'],
  id: string,
  storage: Storage,
): Promise<void> {
  const del = async (): Promise<unknown> => {
    switch (type) {
      case 'sql-collection': return storage.sqlScriptCollections.delete(id)
      case 'etl-pipeline': return storage.etlPipelines.delete(id)
      case 'data-catalog': return storage.dataCatalogs.delete(id)
      case 'dq-rule-set': return storage.dqRuleSets.delete(id)
      case 'mapping-project': return storage.mappingProjects.delete(id)
      case 'project': return storage.projects.delete(id)
      // schemaPresets.save is an upsert keyed by presetId — nothing to delete.
      case 'schema-preset': return undefined
    }
  }
  await del().catch(() => {})
}

/** A cloned repo, held between the conflict check and the actual write. */
export interface PreparedInstall {
  entry: CatalogEntry
  zip: JSZip
  /** Id declared by the repo — the id an overwrite would replace. */
  repoId: string
  oid: string | null
  /** Some local row of this type already uses `repoId` (same OR unrelated entity). */
  idCollision: boolean
  /** Set only when the collision is genuinely the SAME published entity (safe to overwrite). */
  existingName?: string
}

export type PrepareResult =
  | { ok: true; prepared: PreparedInstall }
  | { ok: false; failure: InstallFailure; error?: string }

/**
 * Clone the entry's repo and report whether it collides with an existing entity.
 *
 * Split from the write so the UI can ask duplicate-or-overwrite first — the same
 * question the per-page ZIP importers ask, and keyed the same way: on the id the repo
 * declares, not on the name.
 *
 * No credentials: a catalog entry must be publicly clonable, since every instance
 * reading the index has to be able to install it. CI in the index repo rejects an entry
 * whose repo it can't reach anonymously.
 */
export async function prepareCatalogInstall(entry: CatalogEntry): Promise<PrepareResult> {
  if (!isServerMode()) return { ok: false, failure: 'server-mode-required' }

  const branch = entry.git.branch || 'main'
  try {
    const JSZipMod = (await import('jszip')).default
    const cloned = await gitCloneToZip(entry.git.url, branch)
    // The catalog is untrusted: cap the archive before decompressing so an entry
    // pointing at a huge or zip-bomb repo can't hang or OOM the tab.
    if (cloned.blob.size > MAX_CLONE_BYTES) {
      return { ok: false, failure: 'clone-failed', error: 'The entity archive is too large to install.' }
    }
    const zip = await JSZipMod.loadAsync(cloned.blob)

    const metaEntry = zip.files[META_FILE[entry.type]]
    const meta = metaEntry
      ? (JSON.parse(await metaEntry.async('string')) as Record<string, unknown>)
      : {}
    // No id in the repo (or no metadata file at all): fall back to a fresh id, which
    // can't collide — better than refusing the install outright.
    const repoId = idOf(entry.type, meta) ?? crypto.randomUUID()

    // A collision is a conflict ONLY when the local row is the same published
    // entity (matching lineage / git remote). Otherwise the ids just happen to
    // coincide and we must install as a fresh copy, never offer to overwrite an
    // unrelated entity the user owns.
    const existing = await findExisting(entry.type, repoId, getStorage())
    const sameEntity = existing ? isSameEntity(existing, entry) : false
    return {
      ok: true,
      prepared: {
        entry,
        zip,
        repoId,
        oid: cloned.oid,
        idCollision: existing != null,
        existingName: sameEntity ? (localizedName(existing?.name) ?? repoId) : undefined,
      },
    }
  } catch (err) {
    return { ok: false, failure: 'clone-failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Append " (copy)" to a duplicated entity's name, in the active language. */
async function renameAsCopy(
  type: CatalogEntry['type'],
  id: string,
  storage: Storage,
  language: string,
): Promise<void> {
  const row = (await findExisting(type, id, storage)) as { name?: LocalizedString | string } | null
  if (!row?.name) return
  const current = localized(row.name, language)
  if (!current) return
  const next = setLocalized(
    typeof row.name === 'string' ? { [language]: row.name } : row.name,
    language,
    `${current} (copy)`,
  )
  switch (type) {
    case 'sql-collection': await storage.sqlScriptCollections.update(id, { name: next }); break
    case 'etl-pipeline': await storage.etlPipelines.update(id, { name: next }); break
    case 'data-catalog': await storage.dataCatalogs.update(id, { name: next }); break
    case 'dq-rule-set': await storage.dqRuleSets.update(id, { name: next }); break
    case 'mapping-project': await storage.mappingProjects.update(id, { name: next }); break
    case 'project': await storage.projects.update(id, { name: next }); break
    // A preset's label lives inside `mapping`, not a `name` field — left as-is.
    case 'schema-preset': break
  }
}

/** Best-effort readable name from a LocalizedString-or-string, for the conflict prompt. */
function localizedName(name: unknown): string | null {
  if (typeof name === 'string') return name || null
  if (name && typeof name === 'object') {
    const m = name as Record<string, string>
    return m.en || Object.values(m).find(Boolean) || null
  }
  return null
}

/**
 * Create the row `applyClonedEntity` will fill in.
 *
 * Only identity fields are set here (id, workspace, a provisional name from the catalog
 * entry): everything else is overwritten from the repo a moment later. The provisional
 * name matters only if the clone fails midway — the row then reads as the catalog
 * entry rather than as "Untitled".
 */
async function createShell(
  entry: CatalogEntry,
  id: string,
  workspaceId: string,
  storage: Storage,
  git: GitRemoteConfig,
  language: string,
): Promise<boolean> {
  const now = new Date().toISOString()
  const name = entry.name
  const plainName = localized(entry.name, language) || entry.id
  const base = { workspaceId, createdAt: now, updatedAt: now, gitRemoteConfig: git, ...stampAuthored() }

  switch (entry.type) {
    case 'sql-collection':
      await storage.sqlScriptCollections.create({ id, name, ...base } as never)
      return true
    case 'etl-pipeline':
      await storage.etlPipelines.create({ id, name, ...base } as never)
      return true
    case 'data-catalog':
      await storage.dataCatalogs.create({ id, name, ...base } as never)
      return true
    case 'dq-rule-set':
      await storage.dqRuleSets.create({ id, name, ...base } as never)
      return true
    case 'mapping-project':
      await storage.mappingProjects.create({ id, name, ...base } as never)
      return true
    case 'project':
      // uid is the project PK; name/description are LocalizedString.
      await storage.projects.create({
        uid: id,
        name,
        description: entry.description ?? {},
        shortDescription: {},
        config: {},
        ownerId: 0,
        ...base,
      } as never)
      return true
    case 'schema-preset':
      // The preset branch of applyClonedEntity uses storage.schemaPresets.save (an
      // upsert keyed by presetId), so no shell row is needed.
      void plainName
      return true
    default:
      return false
  }
}

/**
 * Materialise a prepared install.
 *
 * `duplicate: true` mints a fresh id, leaving the existing entity untouched (an
 * independent copy); `false` reuses the repo's id, replacing what's there. Same two
 * options the per-page ZIP importers offer.
 */
export async function commitCatalogInstall(
  prepared: PreparedInstall,
  workspaceId: string,
  language: string,
  duplicate: boolean,
): Promise<InstallResult> {
  const { entry, zip, oid } = prepared
  const branch = entry.git.branch || 'main'
  const url = entry.git.url
  // Reusing the repo id (overwrite) is only ever allowed for the SAME published
  // entity. If the repo id collides with an UNRELATED local row, force a fresh id
  // so the install can never destroy an entity the user owns by id-collision —
  // whatever the caller passed for `duplicate`.
  const unrelatedCollision = prepared.idCollision && !prepared.existingName
  const reuseId = !duplicate && !unrelatedCollision
  const id = reuseId ? prepared.repoId : crypto.randomUUID()
  const storage = getStorage()
  const git: GitRemoteConfig = { url, branch }

  // Overwrite: drop the existing row first so the shell insert below doesn't collide.
  // applyClonedEntity's per-type branches already delete child rows (files, checks,
  // project sub-entities), so only the parent needs clearing here.
  if (reuseId && prepared.existingName) {
    await deleteExisting(entry.type, id, storage)
  }

  try {
    if (!(await createShell(entry, id, workspaceId, storage, git, language))) {
      return { ok: false, failure: 'unsupported-type' }
    }
  } catch (err) {
    return { ok: false, failure: 'apply-failed', error: err instanceof Error ? err.message : String(err) }
  }

  let ok = false
  let applyError: string | undefined
  try {
    ok = await applyClonedEntity(zip, entry.type, id, storage, workspaceId, git)
  } catch (err) {
    ok = false
    applyError = err instanceof Error ? err.message : String(err)
  }
  if (!ok) {
    // createShell inserted a parent row above; a failed apply must not leave it
    // orphaned. (schema-preset has no shell row — deleteExisting is a no-op there.)
    await deleteExisting(entry.type, id, storage).catch(() => {})
    return { ok: false, failure: 'apply-failed', id, error: applyError }
  }

  // Mark the copy AFTER applyClonedEntity: it rewrites `name` from the repo, so a
  // suffix set on the shell row would be overwritten. Matches the per-page importers,
  // which append "(copy)" on duplicate so the two rows are tellable apart. A forced
  // fresh id (unrelated collision) is a copy too.
  if (!reuseId) {
    await renameAsCopy(entry.type, id, storage, language).catch(() => {})
  }

  // Anchor sync state to the cloned commit so the Versioning page can detect "behind"
  // later — same as the workspace-import clone loop.
  const scope = scopeForLinkedType[entry.type]
  if (oid && scope) {
    try {
      await gitSetSyncState(scope, id, branch, oid)
    } catch {
      /* leave unanchored — Versioning adopts lazily */
    }
  }

  return { ok: true, id }
}
