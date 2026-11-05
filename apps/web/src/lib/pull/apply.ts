/**
 * Writing a pull: the merged tree (the local export with the decisions applied)
 * is re-imported in place by the entity's own importer (plan §9.2). Declined
 * items are in the tree as they are locally, so they simply stay.
 *
 * Safe on a server, where every pull runs: re-importing rebuilds the entity's
 * rows (dashboards, cohorts, analyses…) at ids derived from their keys, and
 * never touches what the export does not carry — the IDE folder's other files,
 * dataset data not marked for versioning — which live on disk, not in rows.
 */
import JSZip from 'jszip'
import type { GitScope } from '@/lib/api/git'
import { settingsImportFile } from '@/lib/api/settings-versioning'
import { createShell, deleteExisting, freshId } from '@/lib/catalog/install'
import { applyClonedEntity, readUserPluginFolder, slugify, type GitLinkedEntity } from '@/lib/entity-io'
import { readEntityDocsFrom } from '@/lib/entity-docs-pull'
import { getStorage, type Storage } from '@/lib/storage'
import { localized, toLocalized } from '@/lib/localized'
import i18n from '@/lib/i18n'
import { readWikiSnapshot } from '@/lib/wiki/wiki-pull'
import {
  clonedDictionaryFiles, DICTIONARIES_DIR, DICTIONARIES_INDEX, landDictionaries, readDictionaryLinks,
} from '@/lib/data-dictionary/dictionary-links'
import { readWikiTree, wikiPageFolder, wikiPageId, WIKI_TREE_FILE } from '@/lib/wiki/wiki-tree'
import type { ConceptSet, LocalizedString, ServiceMapping, SourceConceptIdRange, Workspace, WikiPage } from '@/types'
import type { Override, PreparedFile, ThreeWayPreview } from './three-way'

/** The entity kind `applyClonedEntity` rebuilds, per git scope. */
export const ENTITY_TYPE: Partial<Record<GitScope, GitLinkedEntity['type']>> = {
  projects: 'project',
  'mapping-projects': 'mapping-project',
  'sql-script-collections': 'sql-collection',
  'etl-pipelines': 'etl-pipeline',
  'data-catalogs': 'data-catalog',
  'dq-rule-sets': 'dq-rule-set',
  'schema-presets': 'schema-preset',
  databases: 'database',
}

type InlineKind = GitLinkedEntity['type'] | 'user-plugin'

/** Workspace folders holding one inline entity each, and its kind. */
const WORKSPACE_SECTIONS: Record<string, InlineKind> = {
  projects: 'project',
  'sql-scripts': 'sql-collection',
  etl: 'etl-pipeline',
  'data-quality': 'dq-rule-set',
  'mapping-projects': 'mapping-project',
  catalogs: 'data-catalog',
  schemas: 'schema-preset',
  databases: 'database',
  plugins: 'user-plugin',
}

export class PullApplyError extends Error {}

async function applyEntity(zip: JSZip, type: GitLinkedEntity['type'], id: string, storage: Storage, workspaceId?: string) {
  // A database's data is in the tree only when marked for versioning; without it
  // the pull must leave the stored files alone.
  const keepData = type === 'database' && !Object.keys(zip.files).some((p) => p.startsWith('data/') && !zip.files[p].dir)
  const result = await applyClonedEntity(zip, type, id, storage, workspaceId, undefined, { keepData })
  if (!result.ok) throw new PullApplyError(`${result.reason ?? 'apply failed'}${result.context ? `: ${result.context}` : ''}`)
}

/** A plugin is its files and docs: written over the row, which keeps its id,
 *  workspace and git link. */
async function applyUserPlugin(zip: JSZip, prefix: string, id: string, storage: Storage) {
  const plugin = await readUserPluginFolder(zip, prefix)
  if (!plugin) throw new PullApplyError(`no plugin manifest in ${prefix || 'the tree'}`)
  await storage.userPlugins.update(id, {
    files: plugin.files,
    readme: plugin.readme,
    license: plugin.license,
    ...(plugin.version ? { version: plugin.version } : {}),
    updatedAt: new Date().toISOString(),
  })
}

/** A script removed upstream: the re-import writes what the tree has, and does
 *  not delete what it lacks, so an accepted deletion is carried out here. */
async function deleteScripts(projectUid: string, paths: string[], storage: Storage) {
  if (!paths.length) return
  const files = await storage.ideFiles.getByProject(projectUid)
  for (const rel of paths) {
    const file = files.find((f) => (f as { path?: string }).path === rel)
    if (file) await storage.ideFiles.delete(file.id)
  }
}

export async function applyEntityPull(
  scope: GitScope, id: string, zip: JSZip, overrides: Record<string, Override>, workspaceId?: string,
  storage: Storage = getStorage(),
): Promise<void> {
  if (scope === 'user-plugins') return applyUserPlugin(zip, '', id, storage)
  // Users, roles and organizations go through the settings import, which only
  // ever adds and updates: an account is never removed by a pull.
  if (scope === 'settings') {
    await settingsImportFile(await zip.generateAsync({ type: 'blob' }))
    return
  }
  const type = ENTITY_TYPE[scope]
  if (!type) throw new PullApplyError(`no pull for ${scope}`)
  await applyEntity(zip, type, id, storage, workspaceId)
  if (scope === 'projects') {
    const removed = Object.entries(overrides)
      .filter(([path, o]) => 'delete' in o && path.startsWith('scripts/') && !path.endsWith('_tree.json'))
      .map(([path]) => path.slice('scripts/'.length))
    await deleteScripts(id, removed, storage)
  }
}

/**
 * What a pull cannot write, taken off the plan and reported instead (it keeps
 * the pull partial, so the content anchor stays). Only the settings have such
 * changes, both on purpose in the settings import: a user, role or organization
 * the remote deleted stays (a pull never removes an account), and the signed-in
 * user's own account is never rewritten from a file (no self-lockout).
 */
export function splitUnwritable(
  scope: GitScope, prepared: PreparedFile[], ownUsername?: string,
): { prepared: PreparedFile[]; unsupported: string[] } {
  if (scope !== 'settings') return { prepared, unsupported: [] }
  const unsupported: string[] = []
  const kept: PreparedFile[] = []
  for (const p of prepared) {
    if (p.merge.kind !== 'elements') { kept.push(p); continue }
    const own = (key: string) => p.file.path === 'users.json' && key === ownUsername
    const unwritable = (e: { key: string; state: string }) => e.state === 'delete' || own(e.key)
    for (const e of p.merge.elements.filter(unwritable)) unsupported.push(`${p.file.path} › ${e.key}`)
    const elements = p.merge.elements.filter((e) => !unwritable(e))
    if (elements.length) kept.push({ ...p, merge: { ...p.merge, elements } })
  }
  return { prepared: kept, unsupported }
}

// --- workspace -----------------------------------------------------------------

async function textFiles(zip: JSZip, prefix: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.startsWith(prefix) && /\.(md|json)$/i.test(path)) out[path] = await entry.async('string')
  }
  return out
}

/** The pages (by entityId) the local export had when the pull was prepared, or
 *  none when the preview does not carry the tree — the remote left it as is. */
function previewWikiNames(preview: ThreeWayPreview | undefined): Set<string> {
  const text = preview?.files.find((f) => f.path === WIKI_TREE_FILE)?.local
  try {
    return new Set(readWikiTree(text ? JSON.parse(text) : []).map((p) => p.id))
  } catch {
    return new Set()
  }
}

/** The wiki as the merged tree has it, written page by page. A page is matched
 *  on its entityId and keeps its local id; a new one takes the derived id. A page
 *  is removed only when the preview had it: one created since is not the
 *  remote's to delete. */
async function applyWiki(zip: JSZip, workspaceId: string, storage: Storage, preview?: ThreeWayPreview) {
  const pages = readWikiSnapshot(await textFiles(zip, 'wiki/'))
  const known = previewWikiNames(preview)
  const local = await storage.wikiPages.getByWorkspace(workspaceId)
  const localId = new Map(local.map((p) => [wikiPageFolder(p), p.id]))
  const idOf = (name: string) => localId.get(name) ?? wikiPageId(workspaceId, name)
  const now = new Date().toISOString()
  for (const [name, page] of pages) {
    const id = idOf(name)
    const row = {
      ...page.meta, id, parentId: page.meta.parentId ? idOf(page.meta.parentId) : null,
      title: toLocalized(page.meta.title), content: page.content, workspaceId,
    } as WikiPage
    if (localId.has(name)) await storage.wikiPages.update(id, { ...row, updatedAt: now })
    else await storage.wikiPages.create({ ...row, updatedAt: now })
  }
  for (const p of local) {
    const name = wikiPageFolder(p)
    if (pages.has(name) || !known.has(name)) continue
    await storage.wikiAttachments.deleteByPage(p.id).catch(() => {})
    await storage.wikiPages.delete(p.id)
  }
}

/** The workspace's own information: name, description, badges, licence, README. */
async function applyWorkspaceInfo(zip: JSZip, workspaceId: string, storage: Storage) {
  const texts = await textFiles(zip, '')
  const rootTexts = Object.fromEntries(Object.entries(texts).filter(([p]) => !p.includes('/')))
  const manifest = rootTexts['entity.json'] ? JSON.parse(rootTexts['entity.json']) as Partial<Workspace> & { readmeLang?: string } : null
  const docs = readEntityDocsFrom(rootTexts, manifest)
  const changes: Partial<Workspace> = {}
  if (manifest) {
    for (const key of ['name', 'description', 'badges'] as const) {
      if (key in manifest) (changes as Record<string, unknown>)[key] = manifest[key]
    }
  }
  if (docs.readme) (changes as Record<string, unknown>).readme = docs.readme
  if (docs.license) (changes as Record<string, unknown>).license = docs.license
  if (Object.keys(changes).length) await storage.workspaces.update(workspaceId, changes)
}

/**
 * One JSON file per row (`concept-sets/<slug>.json`, `service-mappings/<slug>.json`):
 * a file in the merged tree is written over the row it names, a file gone from it
 * removes that row. Local-only fields the export never carries (a concept set's
 * dictionary) are kept by updating in place.
 */
async function applyFlatSection<T extends { id: string; name?: string }>(
  zip: JSZip, paths: string[], workspaceId: string,
  rows: { getByWorkspace(ws: string): Promise<T[]>; create(row: T): Promise<void>; update(id: string, c: Partial<T>): Promise<void>; delete(id: string): Promise<void> },
  /** Rows the section does not hold, whatever its files say. */
  isElsewhere: (row: T) => boolean = () => false,
) {
  const local = (await rows.getByWorkspace(workspaceId)).filter((r) => !isElsewhere(r))
  const slugOf = (r: T) => slugify(r.name || r.id)
  const now = new Date().toISOString()
  for (const path of paths) {
    const slug = path.split('/')[1].replace(/\.json$/, '')
    const entry = zip.files[path]
    if (!entry) {
      const gone = local.find((r) => slugOf(r) === slug)
      if (gone) await rows.delete(gone.id)
      continue
    }
    const row = JSON.parse(await entry.async('string')) as T
    const existing = local.find((r) => r.id === row.id) ?? local.find((r) => slugOf(r) === slug)
    if (existing) await rows.update(existing.id, { ...row, id: existing.id, workspaceId, updatedAt: now })
    else await rows.create({ ...row, id: row.id ?? crypto.randomUUID(), workspaceId, createdAt: (row as { createdAt?: string }).createdAt ?? now, updatedAt: now })
  }
}

/** The linked dictionaries the merged tree lists: a new one is created and
 *  synced from its repository. One the tree no longer lists is left in place —
 *  removing a dictionary removes its sets, which the mapping projects may use. */
async function applyDictionaries(zip: JSZip, workspaceId: string, storage: Storage) {
  const entry = zip.files[DICTIONARIES_INDEX]
  const links = readDictionaryLinks(entry ? JSON.parse(await entry.async('string')) : [])
  const texts = await textFiles(zip, `${DICTIONARIES_DIR}/`)
  const clones = new Map(links.map((l) => [l.entityId, clonedDictionaryFiles(texts, l.entityId)]))
  const known = await storage.dataDictionaries.getByWorkspace(workspaceId)
  const added = links.filter((l) => !known.some((d) => d.sourceRepo?.trim() === l.git.url && (d.branch || 'main') === l.git.branch))
  await landDictionaries(added, clones, workspaceId, i18n.language, storage)
}

/** The workspace's badge ranges (`source-concept-ids/ranges.json`), as one list. */
async function applySourceIdRanges(zip: JSZip, workspaceId: string, storage: Storage) {
  const entry = zip.files['source-concept-ids/ranges.json']
  const ranges = entry ? JSON.parse(await entry.async('string')) as SourceConceptIdRange[] : []
  const now = new Date().toISOString()
  // Saved before anything is removed: a failure midway leaves ranges, never none.
  for (const range of ranges) {
    await storage.sourceConceptIdRanges.save({ ...range, workspaceId, createdAt: range.createdAt ?? now, updatedAt: now })
  }
  const kept = new Set(ranges.map((r) => r.badgeLabel))
  for (const range of await storage.sourceConceptIdRanges.getByWorkspace(workspaceId)) {
    if (!kept.has(range.badgeLabel)) await storage.sourceConceptIdRanges.delete(workspaceId, range.badgeLabel)
  }
}

interface Portable {
  id?: string
  uid?: string
  entityId?: string
  lineageId?: string
  projectId?: string
  name?: unknown
  description?: unknown
  presetId?: string
  mapping?: { presetLabel?: unknown }
}

/** Every folder name the workspace export may give this entity (buildWorkspaceZip:
 *  its entityId, else a project's projectId, else the slug of its English name). */
function folderNames(c: Portable): string[] {
  const name = typeof c.name === 'string' ? c.name : localized((c.name ?? c.mapping?.presetLabel ?? {}) as LocalizedString, 'en')
  return [c.entityId, c.projectId, c.presetId, name ? slugify(name) : undefined, c.id, c.uid]
    .filter((v): v is string => !!v)
}

async function inlineEntities(type: InlineKind, workspaceId: string, storage: Storage): Promise<Portable[]> {
  switch (type) {
    case 'project': return (await storage.projects.getAll()).filter((p) => p.workspaceId === workspaceId) as Portable[]
    case 'sql-collection': return storage.sqlScriptCollections.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'etl-pipeline': return storage.etlPipelines.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'dq-rule-set': return storage.dqRuleSets.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'mapping-project': return storage.mappingProjects.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'data-catalog': return storage.dataCatalogs.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'schema-preset': return storage.schemaPresets.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'database': return storage.dataSources.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'user-plugin': return storage.userPlugins.getByWorkspace(workspaceId) as Promise<Portable[]>
  }
}

async function removeInline(type: InlineKind, id: string, storage: Storage) {
  if (type === 'user-plugin') return storage.userPlugins.delete(id)
  if (type === 'database') return storage.dataSources.delete(id)
  if (type === 'schema-preset') return storage.schemaPresets.delete(id)
  return deleteExisting(type, id, storage)
}

/** The inline folder an override path belongs to, as `section/folder`, or null. */
export function inlineFolderOf(path: string): { section: string; folder: string } | null {
  const [section, folder, ...rest] = path.split('/')
  return WORKSPACE_SECTIONS[section] && folder && rest.length ? { section, folder } : null
}

/** A lineageId names one entity across instances: a local entity carrying
 *  another one is never matched by folder or slug — the manifest's is new here.
 *  One carrying none (exported before it had one) still may be. */
function matchEntity(candidates: Portable[], manifest: Portable | null, folder: string): Portable | undefined {
  const lineage = manifest?.lineageId
  if (lineage) {
    const same = candidates.find((c) => c.lineageId === lineage)
    if (same) return same
    candidates = candidates.filter((c) => !c.lineageId)
  }
  return (manifest?.entityId && candidates.find((c) => c.entityId === manifest.entityId))
    || candidates.find((c) => folderNames(c).includes(folder))
    || undefined
}

/** The manifest of an inline folder as this instance exported it, from the preview
 *  (the merged tree no longer has it when the folder's removal was taken). */
function localManifest(preview: ThreeWayPreview | undefined, prefix: string): Portable | null {
  const text = preview?.files.find((f) => f.path === `${prefix}entity.json`)?.local
  try { return text ? JSON.parse(text) as Portable : null } catch { return null }
}

/**
 * An inline entity of the merged tree: written over the local one it names, or
 * created when a colleague added it; removed when its folder left the tree.
 */
async function applyInlineFolder(
  zip: JSZip, section: string, folder: string, workspaceId: string, storage: Storage, preview?: ThreeWayPreview,
) {
  const type = WORKSPACE_SECTIONS[section]
  const prefix = `${section}/${folder}/`
  const manifestEntry = zip.files[`${prefix}entity.json`]
  const manifest = manifestEntry ? JSON.parse(await manifestEntry.async('string')) as Portable : null
  const local = matchEntity(await inlineEntities(type, workspaceId, storage), manifest ?? localManifest(preview, prefix), folder)
  const localId = local ? (local.uid ?? local.id)! : null

  if (!manifest) {
    if (localId) await removeInline(type, localId, storage)
    return
  }
  const sub = new JSZip()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.startsWith(prefix)) sub.file(path.slice(prefix.length), await entry.async('uint8array'))
  }
  if (type === 'user-plugin') {
    if (localId) return applyUserPlugin(sub, '', localId, storage)
    const plugin = await readUserPluginFolder(sub, '')
    if (!plugin) throw new PullApplyError(`no plugin manifest in ${prefix}`)
    const now = new Date().toISOString()
    await storage.userPlugins.create({ ...plugin, id: crypto.randomUUID(), workspaceId, createdAt: plugin.createdAt ?? now, updatedAt: now })
    return
  }
  let id = localId
  if (!id) {
    id = freshId(type)
    const name = (manifest.name ?? folder) as LocalizedString
    await createShell({ type, id: folder, name, description: (manifest.description ?? {}) as LocalizedString }, id, workspaceId, storage, undefined, 'en')
  }
  try {
    await applyEntity(sub, type, id, storage, workspaceId)
  } catch (e) {
    // A shell this pull created must not stay behind, empty, when its import failed.
    if (!localId) await removeInline(type, id, storage).catch(() => {})
    throw e
  }
}

export async function applyWorkspacePull(
  workspaceId: string, zip: JSZip, overrides: Record<string, Override>, storage: Storage = getStorage(),
  preview?: ThreeWayPreview,
): Promise<void> {
  const paths = Object.keys(overrides)
  if (paths.some((p) => p.startsWith('wiki/'))) await applyWiki(zip, workspaceId, storage, preview)
  if (paths.some((p) => !p.includes('/'))) await applyWorkspaceInfo(zip, workspaceId, storage)

  // The linked dictionaries first: their sets are not in concept-sets/ (their
  // repository holds them), so a set file removed there must not delete one.
  if (paths.includes(DICTIONARIES_INDEX)) await applyDictionaries(zip, workspaceId, storage)
  const conceptSets = paths.filter((p) => /^concept-sets\/[^/]+\.json$/.test(p))
  if (conceptSets.length) {
    const linked = new Set((await storage.dataDictionaries.getByWorkspace(workspaceId)).filter((d) => d.sourceRepo?.trim()).map((d) => d.id))
    await applyFlatSection<ConceptSet>(zip, conceptSets, workspaceId, storage.conceptSets, (cs) => !!cs.dictionaryId && linked.has(cs.dictionaryId))
  }
  const serviceMappings = paths.filter((p) => /^service-mappings\/[^/]+\.json$/.test(p))
  if (serviceMappings.length) await applyFlatSection<ServiceMapping>(zip, serviceMappings, workspaceId, storage.serviceMappings)
  if (paths.includes('source-concept-ids/ranges.json')) await applySourceIdRanges(zip, workspaceId, storage)

  const folders = new Set(paths.map(inlineFolderOf).filter((f) => f !== null).map((f) => `${f!.section}/${f!.folder}`))
  for (const key of folders) {
    const [section, folder] = key.split('/')
    await applyInlineFolder(zip, section, folder, workspaceId, storage, preview)
  }
}
