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
import { applyClonedEntity, type GitLinkedEntity } from '@/lib/entity-io'
import { readEntityDocsFrom } from '@/lib/entity-docs-pull'
import { getStorage, type Storage } from '@/lib/storage'
import { toLocalized } from '@/lib/localized'
import { readWikiSnapshot } from '@/lib/wiki/wiki-pull'
import type { Workspace, WikiPage } from '@/types'
import type { Override } from './three-way'

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

/** Workspace folders holding one inline entity each, and its kind. */
const WORKSPACE_SECTIONS: Record<string, GitLinkedEntity['type']> = {
  projects: 'project',
  'sql-scripts': 'sql-collection',
  etl: 'etl-pipeline',
  'data-quality': 'dq-rule-set',
  'mapping-projects': 'mapping-project',
  catalogs: 'data-catalog',
  schemas: 'schema-preset',
  databases: 'database',
}

export class PullApplyError extends Error {}

async function applyEntity(zip: JSZip, type: GitLinkedEntity['type'], id: string, storage: Storage, workspaceId?: string) {
  const result = await applyClonedEntity(zip, type, id, storage, workspaceId)
  if (!result.ok) throw new PullApplyError(`${result.reason ?? 'apply failed'}${result.context ? `: ${result.context}` : ''}`)
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

// --- workspace -----------------------------------------------------------------

async function textFiles(zip: JSZip, prefix: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.startsWith(prefix) && /\.(md|json)$/i.test(path)) out[path] = await entry.async('string')
  }
  return out
}

/** The wiki as the merged tree has it, written page by page. */
async function applyWiki(zip: JSZip, workspaceId: string, storage: Storage) {
  const pages = readWikiSnapshot(await textFiles(zip, 'wiki/'))
  const local = await storage.wikiPages.getByWorkspace(workspaceId)
  const now = new Date().toISOString()
  for (const [id, page] of pages) {
    const row = { ...page.meta, title: toLocalized(page.meta.title), content: page.content, workspaceId } as WikiPage
    if (local.some((p) => p.id === id)) await storage.wikiPages.update(id, { ...row, updatedAt: now })
    else await storage.wikiPages.create({ ...row, updatedAt: now })
  }
  for (const p of local) {
    if (pages.has(p.id)) continue
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

interface Portable { id?: string; uid?: string; entityId?: string; lineageId?: string }

async function inlineEntities(type: GitLinkedEntity['type'], workspaceId: string, storage: Storage): Promise<Portable[]> {
  switch (type) {
    case 'project': return (await storage.projects.getAll()).filter((p) => p.workspaceId === workspaceId) as Portable[]
    case 'sql-collection': return storage.sqlScriptCollections.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'etl-pipeline': return storage.etlPipelines.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'dq-rule-set': return storage.dqRuleSets.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'mapping-project': return storage.mappingProjects.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'data-catalog': return storage.dataCatalogs.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'schema-preset': return storage.schemaPresets.getByWorkspace(workspaceId) as Promise<Portable[]>
    case 'database': return storage.dataSources.getByWorkspace(workspaceId) as Promise<Portable[]>
  }
}

/** The inline folder an override path belongs to, as `section/folder`, or null. */
export function inlineFolderOf(path: string): { section: string; folder: string } | null {
  const [section, folder, ...rest] = path.split('/')
  return WORKSPACE_SECTIONS[section] && folder && rest.length ? { section, folder } : null
}

/**
 * Paths of a workspace pull this version cannot write yet: an inline entity the
 * remote added or removed (the pull updates entities this workspace holds), and
 * the sections with no importer in place (dictionaries, plugins, service mappings).
 */
export async function unsupportedWorkspacePaths(
  paths: string[], manifests: Map<string, Portable | null>, workspaceId: string, storage: Storage = getStorage(),
): Promise<string[]> {
  const out: string[] = []
  const cache = new Map<string, Portable[]>()
  for (const path of paths) {
    if (/^(concept-sets|service-mappings|plugins|source-concept-ids)\//.test(path)) { out.push(path); continue }
    const at = inlineFolderOf(path)
    if (!at) continue
    const type = WORKSPACE_SECTIONS[at.section]
    if (!cache.has(type)) cache.set(type, await inlineEntities(type, workspaceId, storage))
    const manifest = manifests.get(`${at.section}/${at.folder}`)
    if (!manifest || !matchEntity(cache.get(type)!, manifest)) out.push(path)
  }
  return out
}

function matchEntity(candidates: Portable[], manifest: Portable): Portable | undefined {
  return (manifest.lineageId && candidates.find((c) => c.lineageId === manifest.lineageId))
    || (manifest.entityId && candidates.find((c) => c.entityId === manifest.entityId))
    || undefined
}

export async function applyWorkspacePull(
  workspaceId: string, zip: JSZip, overrides: Record<string, Override>, storage: Storage = getStorage(),
): Promise<void> {
  const paths = Object.keys(overrides)
  if (paths.some((p) => p.startsWith('wiki/'))) await applyWiki(zip, workspaceId, storage)
  if (paths.some((p) => !p.includes('/'))) await applyWorkspaceInfo(zip, workspaceId, storage)

  const folders = new Set(paths.map(inlineFolderOf).filter((f) => f !== null).map((f) => `${f!.section}/${f!.folder}`))
  for (const key of folders) {
    const [section, folder] = key.split('/')
    const type = WORKSPACE_SECTIONS[section]
    const prefix = `${section}/${folder}/`
    const manifestEntry = zip.files[`${prefix}entity.json`]
    if (!manifestEntry) continue
    const manifest = JSON.parse(await manifestEntry.async('string')) as Portable
    const local = matchEntity(await inlineEntities(type, workspaceId, storage), manifest)
    if (!local) continue
    const sub = new JSZip()
    for (const [path, entry] of Object.entries(zip.files)) {
      if (!entry.dir && path.startsWith(prefix)) sub.file(path.slice(prefix.length), await entry.async('uint8array'))
    }
    await applyEntity(sub, type, (local.uid ?? local.id)!, storage, workspaceId)
  }
}
