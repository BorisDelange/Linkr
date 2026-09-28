/**
 * Workspace data dictionaries — the operations the settings tab and the pickers
 * share. Storage does the writing (the server applies a sync in server mode);
 * this module fetches the content and keeps the concept-set store fresh.
 */
import type { ConceptSet, DataDictionary, MappingProject } from '@/types'
import { getStorage } from '@/lib/storage'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { readDictionaryTree, planDictionarySync, zipPathsToTree, type DictionaryContent, type DictionarySyncPlan } from './content'
import { fetchDictionary, repoName } from './repo'

export type DictionarySource =
  | { kind: 'repo'; url: string; branch: string }
  | { kind: 'zip'; file: File }

/** Read a dictionary's content from its source: a repository, or a ZIP of one
 *  (as a forge's "Download ZIP" gives it). */
export async function readDictionarySource(source: DictionarySource, lang: string): Promise<DictionaryContent> {
  if (source.kind === 'repo') return fetchDictionary(source.url, source.branch, lang)
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(source.file)
  const entries: Record<string, string> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.toLowerCase().endsWith('.json')) entries[path] = await entry.async('string')
  }
  const content = readDictionaryTree(zipPathsToTree(entries), null, lang)
  if (content.conceptSets.length === 0) throw new Error('No concept_sets/ folder with concept sets found in this ZIP.')
  return content
}

export function dictionarySets(conceptSets: readonly ConceptSet[], dictionaryId: string): ConceptSet[] {
  return conceptSets.filter((s) => s.dictionaryId === dictionaryId)
}

/** What syncing `content` into `dictionary` would change (a new dictionary has
 *  no sets yet: everything is added). */
export function previewSync(conceptSets: readonly ConceptSet[], dictionary: DataDictionary | null, content: DictionaryContent): DictionarySyncPlan {
  return planDictionarySync(dictionary ? dictionarySets(conceptSets, dictionary.id) : [], content.conceptSets)
}

async function reloadConceptSets(): Promise<void> {
  await useConceptMappingStore.getState().loadConceptSets()
}

export async function createDictionary(
  workspaceId: string,
  source: DictionarySource,
  content: DictionaryContent,
  name?: string,
): Promise<DataDictionary> {
  const now = new Date().toISOString()
  const dictionary: DataDictionary = {
    id: crypto.randomUUID(),
    workspaceId,
    name: name?.trim() || content.title || (source.kind === 'repo' ? repoName(source.url) : 'Concept sets'),
    ...(source.kind === 'repo' ? { sourceRepo: source.url.trim(), branch: source.branch } : {}),
    createdAt: now,
    updatedAt: now,
  }
  const storage = getStorage()
  await storage.dataDictionaries.create(dictionary)
  await storage.dataDictionaries.sync(dictionary.id, content)
  await reloadConceptSets()
  return dictionary
}

export async function syncDictionary(dictionary: DataDictionary, content: DictionaryContent) {
  const result = await getStorage().dataDictionaries.sync(dictionary.id, content)
  await reloadConceptSets()
  return result
}

export async function deleteDictionary(dictionary: DataDictionary): Promise<void> {
  await getStorage().dataDictionaries.delete(dictionary.id)
  await reloadConceptSets()
}

/** The mapping projects using at least one of `sets`. */
export function projectsUsing(projects: readonly MappingProject[], sets: readonly ConceptSet[]): MappingProject[] {
  const ids = new Set(sets.map((s) => s.id))
  return projects.filter((p) => (p.conceptSetIds ?? []).some((id) => ids.has(id)))
}

/**
 * Put the workspace's concept sets imported before dictionaries existed into
 * dictionaries: one per source repository they name, the rest in a local one.
 * Their ids do not change, so the projects using them keep them.
 */
export async function organizeLooseConceptSets(workspaceId: string, loose: readonly ConceptSet[], localName: string): Promise<void> {
  const byRepo = new Map<string, ConceptSet[]>()
  for (const set of loose) {
    const key = set.sourceRepo?.trim() ?? ''
    byRepo.set(key, [...(byRepo.get(key) ?? []), set])
  }
  const storage = getStorage()
  const now = new Date().toISOString()
  for (const [repo, sets] of byRepo) {
    const dictionary: DataDictionary = {
      id: crypto.randomUUID(),
      workspaceId,
      name: repo ? repoName(repo) : localName,
      ...(repo ? { sourceRepo: repo, branch: 'main' } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await storage.dataDictionaries.create(dictionary)
    for (const set of sets) await storage.conceptSets.update(set.id, { dictionaryId: dictionary.id })
  }
  await reloadConceptSets()
}
