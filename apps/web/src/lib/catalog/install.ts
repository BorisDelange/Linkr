/**
 * Install a catalog entry into a workspace.
 *
 * Reuses the git-linked-entity path rather than the per-page ZIP importers:
 *   gitCloneToZip → create a minimal record → applyClonedEntity
 *
 * That is the same sequence `WorkspacesPage.cloneEntityContent` runs for git-linked
 * entities. Both read the **git repo layout**, which is now the only layout: every
 * per-page ZIP export goes through the same `build*Folder` builders as the git sync,
 * so an exported ZIP and a cloned repo are the same tree. (They were not: the DQ
 * export wrote `ruleset.json` where the repo writes `rule-set.json`, and the schema
 * export wrote a bare mapping JSON with no `schema.ddl` at all.)
 *
 * `applyClonedEntity` only ever *updates* a row (it assumes the workspace import already
 * created one from a pointer), hence the minimal-record step below.
 */

import type JSZip from 'jszip'
import { CONTENT_FILE, ENTITY_MANIFEST, MANIFEST } from '@linkr/format'
import { applyClonedEntity, collectGitLinkedEntities, parseWorkspaceZip } from '@/lib/entity-io'
import type { GitLinkedEntity, ParsedWorkspaceZip } from '@/lib/entity-io'
import { findLineageMatch, type ImportTarget } from '@/lib/import-identity'
import { importWorkspaceTree } from '@/lib/workspace-import'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { anchorClonedEntity } from '@/lib/git-clone-anchor'
import { normalizeGitUrl } from '@/lib/git-clone'
import { isServerMode } from '@/lib/api-client'
import { getStorage } from '@/lib/storage'
import { localized, setLocalized } from '@/lib/localized'
import { mintEntityId } from '@/components/ui/entity-id-field'
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
  /** The install succeeded, but part of it did not arrive — shown, not swallowed. */
  warning?: string
  /**
   * Name of the publishing organization the import had to skip (no
   * `organizations:write`), so the caller can say so in its own language. Raw
   * rather than folded into `warning`, which is pre-rendered text.
   */
  skippedOrgName?: string
}

/**
 * Root metadata file carrying the entity's own id, per type (git repo layout).
 *
 * Names come from the shared layout table so this can't drift from what the
 * exporter writes. A mapping project is the one type with two candidates: the
 * exporter writes `project.json` (its metadata) alongside `mappings.json`, but
 * older trees used `_project.json` — try both, or a freshly published repo
 * installs with no id at all.
 */
export const META_FILE: Record<CatalogEntry['type'], string[]> = {
  'workspace': [MANIFEST.workspace],
  'sql-collection': [MANIFEST['sql-collection']],
  'etl-pipeline': [MANIFEST['etl-pipeline']],
  'mapping-project': [MANIFEST.project, '_project.json'],
  'project': [MANIFEST.project],
  'data-catalog': [MANIFEST['data-catalog']],
  'dq-rule-set': [MANIFEST['dq-rule-set']],
  'schema-preset': [MANIFEST['schema-preset']],
  'database': [MANIFEST.database],
}

/**
 * Why a cloned tree could not be read, in one sentence the user can act on.
 *
 * `applyClonedEntity` returns a bare `false` for every unreadable tree, so this
 * re-inspects the archive to say WHICH file is missing. The common cause is a
 * repo whose layout predates — or, after a half-finished migration, no longer
 * matches — what its type expects: the manifest was renamed away and its
 * replacement never written, leaving a repo with content but no identity.
 */
function describeUnreadableTree(zip: JSZip, type: CatalogEntry['type']): string {
  const has = (name: string) => zip.files[name] != null && !zip.files[name].dir
  const names = [ENTITY_MANIFEST, ...(META_FILE[type] ?? [])]
  if (!names.some(has)) {
    const present = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
    return `This repository has no ${ENTITY_MANIFEST}: nothing declares what it is `
      + `or what it is called.${present.length ? ` It contains: ${present.slice(0, 8).join(', ')}.` : ''}`
  }
  // A preset carries its payload in sibling files. The DDL is required: without
  // it the install would create every table with no columns, which is why the
  // reader refuses the tree rather than importing a schema that does nothing.
  // `mapping.json` is NOT checked — a pre-split repo keeps the mapping inline in
  // the manifest and reads fine.
  if (type === 'schema-preset' && !has(CONTENT_FILE.schemaDdl)) {
    return `This schema preset has no ${CONTENT_FILE.schemaDdl}, so it would install `
      + 'tables with no columns.'
  }
  return 'This repository could not be read as a ' + type + '. Its layout does not match '
    + 'what this entity type expects.'
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
    // `entityId` is the slug's name now; `projectId` is the same value under its
    // former one, still read so repos published before the rename install.
    ? ['entityId', 'projectId', 'uid']
    // A preset exported before the identity split has only `presetId`, which was
    // at once its key and its slug.
    : type === 'schema-preset' ? ['entityId', 'presetId']
    // `entityId` for everyone else, with `id` kept only as the fallback for a
    // repo published before exports stopped writing it. A local primary key is
    // the WRITING instance's, never an identity — `isSameEntity` says so
    // outright, matching on lineage or git remote and treating a shared id as a
    // hazard to defend against. So it is no longer read first, and no longer
    // written at all.
    : ['entityId', 'id']
  for (const key of keys) {
    const value = meta[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/**
 * A fresh local id for a duplicate install.
 *
 * A schema preset gets `custom-<8 hex>` because this id becomes its `entityId` —
 * the readable Identifier shown in the field and written to exports — while the
 * row's primary key is a uuid minted separately by the clone. Every other type
 * keys on an opaque uuid the user never sees, so a raw one is right for them.
 */
export function freshId(type: CatalogEntry['type']): string {
  return type === 'schema-preset' ? mintEntityId() : crypto.randomUUID()
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
      case 'workspace': return storage.workspaces.getById(id)
      case 'sql-collection': return storage.sqlScriptCollections.getById(id)
      case 'etl-pipeline': return storage.etlPipelines.getById(id)
      case 'data-catalog': return storage.dataCatalogs.getById(id)
      case 'dq-rule-set': return storage.dqRuleSets.getById(id)
      case 'mapping-project': return storage.mappingProjects.getById(id)
      // Projects are keyed by uid, and getById IS that lookup (see ProjectStorage).
      case 'project': return storage.projects.getById(id)
      case 'schema-preset': return storage.schemaPresets.getById(id)
      case 'database': return storage.dataSources.getById(id)
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
      // Never reached: a workspace install is offered as "keep both" only, because
      // deleting one takes every project, database and mapping inside it with it.
      // `commitCatalogInstall` refuses the overwrite before it gets here.
      case 'workspace': return undefined
    }
  }
  await del().catch(() => {})
}

/** A cloned repo, held between the conflict check and the actual write. */
export interface PreparedInstall {
  entry: CatalogEntry
  zip: JSZip
  /** The archive as fetched. Kept because the workspace import parses a File, not a JSZip. */
  blob: Blob
  /** Id declared by the repo — the id an overwrite would replace. */
  repoId: string
  oid: string | null
  /** Some local row of this type already uses `repoId` (same OR unrelated entity). */
  idCollision: boolean
  /**
   * The colliding row lives in ANOTHER workspace, so this install is that
   * workspace's first copy rather than a second one sitting beside an existing
   * row. It still needs a fresh local id (the other row holds `repoId`), but it
   * must not be labelled "(copy)": the user sees exactly one in this workspace.
   */
  collisionElsewhere?: boolean
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
export async function prepareCatalogInstall(
  entry: CatalogEntry,
  workspaceId?: string,
): Promise<PrepareResult> {
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

    // ENTITY_MANIFEST first: a repo published in the new format names its
    // manifest the same way whatever its type.
    const metaEntry = [ENTITY_MANIFEST, ...META_FILE[entry.type]].map((f) => zip.files[f]).find(Boolean)
    const meta = metaEntry
      ? (JSON.parse(await metaEntry.async('string')) as Record<string, unknown>)
      : {}
    // No id in the repo (or no metadata file at all): fall back to a fresh id, which
    // can't collide — better than refusing the install outright.
    const repoId = idOf(entry.type, meta) ?? crypto.randomUUID()

    // Two different questions, and conflating them broke both ways round.
    //
    // 1. Is this an UPDATE of something in the workspace being installed into?
    //    Only then may the install overwrite. An entity is offered per workspace,
    //    so the same schema installed in another workspace is a separate copy, not
    //    something to replace — hence the workspace scoping here.
    // 2. Is `repoId` still free as a local id? That is an instance-wide question:
    //    the row in the other workspace occupies it regardless of scope. Reusing
    //    it anyway made a project's shell insert violate the uid primary key (a
    //    409 "already exists"), and made a preset's upsert re-key the OTHER
    //    workspace's row — which is why installing MIMIC-III into a second
    //    workspace made it vanish from the first.
    const found = await findExisting(entry.type, repoId, getStorage())
    const inTargetWorkspace =
      found && (!workspaceId || !found.workspaceId || found.workspaceId === workspaceId)
    const existing = inTargetWorkspace ? found : null
    const sameEntity = existing ? isSameEntity(existing, entry) : false
    return {
      ok: true,
      prepared: {
        entry,
        zip,
        blob: cloned.blob,
        repoId,
        oid: cloned.oid,
        // Any row holding the id blocks reuse, wherever it lives.
        idCollision: found != null,
        collisionElsewhere: found != null && !inTargetWorkspace,
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
    case 'database': await storage.dataSources.update(id, { name: next }); break
    // A preset's label lives inside `mapping`, not a `name` field — left as-is.
    case 'schema-preset': break
    // The workspace import renames its own duplicate (it has to: every child is
    // re-minted at the same time), so doing it again here would say "(copy) (copy)".
    case 'workspace': break
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
    case 'database':
      // Same: the database branch creates or updates the row itself, because it
      // must set connectionConfig from the Parquet files it just stored — a
      // shell without those would be a source pointing at nothing.
      return true
    case 'workspace':
      // A workspace is created by the import itself, which resolves its own target
      // row by lineage and re-mints every child with it. A shell here would be a
      // second, empty workspace the import would then ignore.
      return true
    default:
      return false
  }
}

/**
 * Whether a local workspace already carries this lineage.
 *
 * The question `existingName` answers is a different one: it looks the repo id up
 * as a primary key, while `importWorkspaceTree` lands by lineage. The two diverge
 * (a workspace imported earlier holds a local uuid, not the repo's id), so the
 * landing decision has to ask the same way the import does.
 */
export async function workspaceLineageExists(lineageId: string | undefined): Promise<boolean> {
  if (!lineageId) return false
  const rows = await getStorage().workspaces.getAll().catch(() => [])
  return rows.some((w) => w.lineageId === lineageId)
}

/**
 * Install a workspace entry by running the workspace import on the cloned tree.
 *
 * A workspace is a container, not a leaf: its projects, databases and mappings —
 * and their own git links — arrive the way a ZIP or git import brings them.
 * `importWorkspaceTree` already resolves its target row by lineage, re-mints the
 * children and renames a duplicate, so none of the per-entity machinery above
 * (shell row, rename, overwrite) applies.
 *
 * `duplicate` is forwarded, but only once something is actually there to keep:
 * duplicate mints a fresh lineage and appends "(copy)" WHETHER OR NOT anything
 * exists, so passing it unconditionally made a FIRST install of a workspace land
 * as "Demo workspace (copy)" with a new identity, losing the lineage the repo
 * publishes. Hence `duplicate && (await workspaceLineageExists(...))`.
 *
 * It must not be dropped either. `importWorkspaceTree` with `duplicate: false`
 * resolves the target by lineage and then DELETES that workspace's projects
 * (`deleteProjectData` + `projects.delete`) to rebuild them from the tree — so
 * hardcoding it turned the re-install dialog's only non-cancel button, "keep
 * both", into an overwrite of the user's copy.
 */
async function installWorkspaceEntry(
  prepared: PreparedInstall,
  language: string,
  git: GitRemoteConfig,
  oid: string | null,
  duplicate: boolean,
): Promise<InstallResult> {
  const { entry, blob } = prepared
  const file = new File([blob], `${entry.id}.zip`, { type: 'application/zip' })
  let parsed: ParsedWorkspaceZip | null
  try {
    parsed = await parseWorkspaceZip(file)
  } catch (err) {
    return { ok: false, failure: 'apply-failed', error: err instanceof Error ? err.message : String(err) }
  }
  if (!parsed) {
    return { ok: false, failure: 'apply-failed', error: describeUnreadableTree(prepared.zip, 'workspace') }
  }
  // The remote comes from the catalog entry, not the tree: export strips
  // gitRemoteConfig, so a published workspace never carries one.
  parsed.workspace.gitRemoteConfig = git

  try {
    const { targetWsId, idMap, skippedOrgName } = await importWorkspaceTree(parsed, {
      // Only a real lineage match makes "keep both" meaningful — see the note above.
      duplicate: duplicate && (await workspaceLineageExists(parsed.workspace.lineageId)),
      language,
    })
    // The children are metadata-only pointers until their own repos are cloned;
    // without this a "demo workspace" entry installs as a shell of empty entities.
    // Best-effort, exactly like the page's loop: a child whose repo needs a token
    // (the catalog passes none) leaves its content behind rather than failing the
    // install.
    const failed = await cloneWorkspaceChildren(parsed, targetWsId, idMap)
    if (oid) {
      try {
        await gitSetSyncState('workspaces', targetWsId, git.branch || 'main', oid)
      } catch {
        /* leave unanchored — Versioning adopts lazily */
      }
    }
    return {
      ok: true,
      id: targetWsId,
      // The workspace is installed; these are the children that arrived empty.
      ...(failed.length
        ? { warning: failed.map((f) => `${f.name}: ${f.reason}`).join('\n') }
        : {}),
      ...(skippedOrgName ? { skippedOrgName } : {}),
    }
  } catch (err) {
    return { ok: false, failure: 'apply-failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Pull each git-linked child's content in. Returns the ones that did not make it. */
async function cloneWorkspaceChildren(
  parsed: ParsedWorkspaceZip,
  targetWsId: string,
  idMap: Map<string, string>,
): Promise<{ name: string; reason: string }[]> {
  const failed: { name: string; reason: string }[] = []
  const JSZipMod = (await import('jszip')).default
  const storage = getStorage()
  // Rows by type, for the lineage lookup below. Same set WorkspacesPage resolves
  // over; `project` is absent from both because projects key on uid, not lineage.
  const rowsFor: Partial<Record<GitLinkedEntity['type'], () => Promise<ImportTarget[]>>> = {
    'mapping-project': () => storage.mappingProjects.getAll(),
    'sql-collection': () => storage.sqlScriptCollections.getAll(),
    'etl-pipeline': () => storage.etlPipelines.getAll(),
    'data-catalog': () => storage.dataCatalogs.getAll(),
    'dq-rule-set': () => storage.dqRuleSets.getAll(),
    'schema-preset': () => storage.schemaPresets.getAll() as Promise<ImportTarget[]>,
    'database': () => storage.dataSources.getAll(),
  }
  for (const child of collectGitLinkedEntities(parsed)) {
    // The row the import actually wrote, answered the way the import decided it:
    // by lineage, falling back to the id map for a child whose manifest has none.
    let id = idMap.get(`${child.type}:${child.id}`) ?? child.id
    const load = child.lineageId ? rowsFor[child.type] : undefined
    if (load) {
      const match = findLineageMatch(await load().catch(() => []), { lineageId: child.lineageId! }, targetWsId)
      if (match) id = match.id
    }
    try {
      const cloned = await gitCloneToZip(child.url, child.branch)
      if (cloned.blob.size > MAX_CLONE_BYTES) {
        failed.push({ name: child.name, reason: 'The archive is too large to install.' })
        continue
      }
      const zip = await JSZipMod.loadAsync(cloned.blob)
      const ok = await applyClonedEntity(zip, child.type, id, storage, targetWsId, {
        url: child.url,
        branch: child.branch,
      })
      if (ok) await anchorClonedEntity(child.type, id, child.branch, cloned.oid)
      // The entity is in either way — as a pointer with no content. Say which
      // ones stayed empty instead of reporting a clean install over a half-built
      // workspace; a private repo the catalog cannot authenticate to is the
      // common case, and nothing on screen said so.
      if (!ok) failed.push({ name: child.name, reason: describeUnreadableTree(zip, child.type) })
    } catch (err) {
      failed.push({ name: child.name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return failed
}

/**
 * Whether the install may keep the repo's own id, and whether the result should
 * be labelled "(copy)". They are separate questions and were once one:
 *
 * - `reuseId` is about safety. The repo's id is reusable only for the SAME
 *   published entity sitting in the target workspace. Any other row holding it —
 *   an unrelated entity, or this entity's copy in another workspace — makes it
 *   taken, and reusing it either destroys that row or (for an upsert-keyed kind
 *   like a preset) drags it into this workspace.
 * - `renameAsCopy` is about legibility. A suffix earns its place only when a
 *   sibling row is visible beside it in THIS workspace. A first install into a
 *   second workspace has no sibling here, so "(copy)" described nothing.
 */
export function resolveInstallIdentity(
  prepared: Pick<PreparedInstall, 'idCollision' | 'collisionElsewhere' | 'existingName'>,
  duplicate: boolean,
): { reuseId: boolean; renameAsCopy: boolean } {
  const unrelatedCollision = prepared.idCollision && !prepared.existingName
  const reuseId = !duplicate && !unrelatedCollision
  const sideBySide = duplicate || !prepared.collisionElsewhere
  return { reuseId, renameAsCopy: !reuseId && sideBySide }
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
  const { reuseId, renameAsCopy: shouldRenameAsCopy } = resolveInstallIdentity(prepared, duplicate)
  const id = reuseId ? prepared.repoId : freshId(entry.type)
  const storage = getStorage()
  const git: GitRemoteConfig = { url, branch }

  // A workspace runs the workspace import instead of the per-entity path: it is a
  // container, so its children (and their own git links) have to come in the way a
  // ZIP or git import brings them, not through applyClonedEntity.
  if (entry.type === 'workspace') {
    return installWorkspaceEntry(prepared, language, git, oid, duplicate)
  }

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
    return {
      ok: false,
      failure: 'apply-failed',
      id,
      // applyClonedEntity signals a tree it cannot read with a bare `false`, so
      // without this the dialog had nothing to show but its own title — the same
      // six words three times over. Name what is missing instead: it is almost
      // always a repo whose layout does not match what this type expects.
      error: applyError ?? describeUnreadableTree(zip, entry.type),
    }
  }

  // Mark the copy AFTER applyClonedEntity: it rewrites `name` from the repo, so a
  // suffix set on the shell row would be overwritten. Matches the per-page importers,
  // which append "(copy)" on duplicate so the two rows are tellable apart.
  if (shouldRenameAsCopy) {
    await renameAsCopy(entry.type, id, storage, language).catch(() => {})
  }

  // Anchor sync state to the cloned commit so the Versioning page can detect "behind"
  // later — same as the workspace-import clone loop.
  await anchorClonedEntity(entry.type, id, branch, oid)

  return { ok: true, id }
}
