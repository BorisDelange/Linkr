/**
 * Git-linked data dictionaries in a workspace export.
 *
 * A dictionary synced from a repository travels as a pointer, like every other
 * git-linked entity: one entry in `data-dictionaries/_dictionaries.json` (name,
 * repo, branch) and one in `git-links.json`, whose clone lands the repository —
 * INDICATE layout, not a Linkr tree — at `data-dictionaries/<entityId>/`. Its
 * concept sets, unit conversions and recommended units come back from there, or
 * from the repository itself when the tree holds no clone. A hand-imported
 * concept set has no repository to point at and still travels as its own
 * `concept-sets/<slug>.json`.
 *
 * Twin of `_build_data_dictionaries_section` (apps/api/app/services/workspace_export.py).
 */
import type { ConceptSet, DataDictionary } from '@/types'
import type { Storage } from '@/lib/storage'
import { DICTIONARIES_DIR, DICTIONARIES_INDEX, isDictionaryFile, slugify } from '@linkr/format'
import { readDictionaryTree, repoName, setKey, type DictionaryContent } from './content'

export { DICTIONARIES_DIR, DICTIONARIES_INDEX }

export interface DictionaryLink {
  entityId: string
  name: string
  createdAt?: string
  git: { url: string; branch: string }
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The workspace's git-linked dictionaries as index entries, sorted by entityId.
 * The entityId is the name's slug, suffixed `-2`, `-3`… when two share it — in
 * repo-then-branch order, so the same dictionaries always get the same names.
 */
export function buildDictionaryLinks(dictionaries: readonly DataDictionary[]): (Omit<DictionaryLink, 'name'> & { id: string; name?: string })[] {
  const linked = dictionaries
    .filter((d) => d.sourceRepo?.trim())
    .map((d) => ({ d, url: d.sourceRepo!.trim(), branch: d.branch || 'main' }))
    .map((x) => ({ ...x, slug: slugify(x.d.name || repoName(x.url)) || 'dictionary' }))
    .sort((a, b) => byKey(a.slug, b.slug) || byKey(a.url, b.url) || byKey(a.branch, b.branch))
  const taken = new Map<string, number>()
  return linked.map(({ d, url, branch, slug }) => {
    const n = (taken.get(slug) ?? 0) + 1
    taken.set(slug, n)
    return {
      id: d.id,
      entityId: n === 1 ? slug : `${slug}-${n}`,
      ...(d.name ? { name: d.name } : {}),
      ...(d.createdAt ? { createdAt: d.createdAt } : {}),
      git: { url, branch },
    }
  }).sort((a, b) => byKey(a.entityId, b.entityId))
}

/** The concept sets the export still writes one by one: those of no linked
 *  dictionary (their repository holds the others). */
export function unlinkedConceptSets(sets: readonly ConceptSet[], dictionaries: readonly DataDictionary[]): ConceptSet[] {
  const linked = new Set(dictionaries.filter((d) => d.sourceRepo?.trim()).map((d) => d.id))
  return sets.filter((s) => !s.dictionaryId || !linked.has(s.dictionaryId))
}

export function readDictionaryLinks(raw: unknown): DictionaryLink[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((e): DictionaryLink[] => {
    if (!e || typeof e !== 'object') return []
    const { entityId, name, createdAt, git } = e as Record<string, unknown>
    const g = git as { url?: unknown; branch?: unknown } | undefined
    if (typeof entityId !== 'string' || !entityId || typeof g?.url !== 'string' || !g.url) return []
    return [{
      entityId,
      name: typeof name === 'string' ? name : '',
      ...(typeof createdAt === 'string' ? { createdAt } : {}),
      git: { url: g.url, branch: typeof g.branch === 'string' && g.branch ? g.branch : 'main' },
    }]
  })
}

/** The clone of one dictionary inside a tree (`{path: text}` from the tree
 *  root), as paths from the repository root — empty when the tree holds none. */
export function clonedDictionaryFiles(files: Readonly<Record<string, string>>, entityId: string): Record<string, string> {
  const prefix = `${DICTIONARIES_DIR}/${entityId}/`
  const out: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue
    const rel = path.slice(prefix.length)
    if (isDictionaryFile(rel)) out[rel] = text
  }
  return out
}

export interface LandedDictionaries {
  /** The concept sets the dictionaries now hold. */
  conceptSetIds: string[]
  /** Dictionaries whose content could not be read: created, left empty. */
  unsynced: { name: string; reason: string }[]
}

/** Reads a dictionary repository when the tree holds no clone of it (`fetchDictionary`
 *  in ./repo, passed in: it reaches into the stores and the API client). */
export type DictionaryFetcher = (url: string, branch: string, language: string) => Promise<DictionaryContent>

const sameRepo = (a: string | undefined, b: string | undefined) => {
  const norm = (u: string | undefined) => (u ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
  return !!norm(a) && norm(a) === norm(b)
}

/**
 * The workspace's sets imported before dictionaries travelled as pointers: no
 * dictionary, but from this one's repository (and, when its content is known,
 * among its sets). Joining it before the sync lets the sync update them in place
 * — their ids, which the mapping projects hold, stay.
 */
async function adoptLooseSets(
  dictionary: DataDictionary, url: string, content: DictionaryContent | null, workspaceId: string, storage: Storage,
) {
  const incoming = content ? new Map(content.conceptSets.map((s) => [setKey(s), s])) : null
  for (const set of await storage.conceptSets.getByWorkspace(workspaceId)) {
    if (set.dictionaryId) continue
    const match = incoming?.get(setKey(set))
    const adopt = incoming
      ? !!match && (sameRepo(set.sourceRepo, url) || sameRepo(set.sourceRepo, match.sourceRepo))
      : sameRepo(set.sourceRepo, url)
    if (adopt) await storage.conceptSets.update(set.id, { dictionaryId: dictionary.id })
  }
}

/**
 * Create (or find, by repo and branch) each linked dictionary in the workspace
 * and sync it: from its clone in the tree when there is one, else from its
 * repository. A dictionary that cannot be read is still created, so a later
 * sync from the Vocabularies page fills it.
 */
export async function landDictionaries(
  links: readonly DictionaryLink[],
  clones: ReadonlyMap<string, Record<string, string>>,
  workspaceId: string,
  language: string,
  storage: Storage,
  fetchDictionary: DictionaryFetcher,
): Promise<LandedDictionaries> {
  const result: LandedDictionaries = { conceptSetIds: [], unsynced: [] }
  if (links.length === 0) return result
  const existing = await storage.dataDictionaries.getByWorkspace(workspaceId)
  const now = new Date().toISOString()
  const landed = new Set<string>()
  for (const link of links) {
    let dictionary = existing.find((d) => d.sourceRepo?.trim() === link.git.url && (d.branch || 'main') === link.git.branch)
    if (!dictionary) {
      dictionary = {
        id: crypto.randomUUID(),
        workspaceId,
        name: link.name || repoName(link.git.url),
        sourceRepo: link.git.url,
        branch: link.git.branch,
        createdAt: link.createdAt ?? now,
        updatedAt: now,
      }
      await storage.dataDictionaries.create(dictionary)
    }
    landed.add(dictionary.id)
    let content: DictionaryContent
    try {
      const clone = clones.get(link.entityId)
      content = clone && Object.keys(clone).length > 0
        ? readDictionaryTree(clone, null, language)
        : await fetchDictionary(link.git.url, link.git.branch, language)
    } catch (err) {
      await adoptLooseSets(dictionary, link.git.url, null, workspaceId, storage)
      result.unsynced.push({ name: dictionary.name, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    await adoptLooseSets(dictionary, link.git.url, content, workspaceId, storage)
    await storage.dataDictionaries.sync(dictionary.id, content)
  }
  for (const set of await storage.conceptSets.getByWorkspace(workspaceId)) {
    if (set.dictionaryId && landed.has(set.dictionaryId)) result.conceptSetIds.push(set.id)
  }
  return result
}
