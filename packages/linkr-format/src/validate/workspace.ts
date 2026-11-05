/**
 * The workspace-level indexes a workspace export writes beside its entities:
 * `wiki/_tree.json`, `wiki/_attachments/_meta.json` and
 * `data-dictionaries/_dictionaries.json` (twins: lib/wiki/wiki-tree.ts and
 * lib/data-dictionary/dictionary-links.ts in apps/web, workspace_export.py).
 *
 * Each is read tolerantly by the app, which drops an entry it cannot place — so
 * a malformed one imports as a page, an image or a dictionary that is silently
 * missing. A tree written before entityIds named pages (entries with `id` /
 * `parentId`, attachments with `pageId`) still reads, and is reported as legacy.
 */
import { isObject } from '../check.js'
import { DICTIONARIES_INDEX } from '../data-dictionary.js'
import { IssueBag, type Issue } from '../issue.js'
import { ENTITY_MANIFEST, MANIFEST } from '../layout.js'
import { readJson, type EntityTree } from '../tree.js'

export const WIKI_TREE_FILE = 'wiki/_tree.json'
export const WIKI_ATTACHMENTS_META_FILE = 'wiki/_attachments/_meta.json'

/** Does the tree hold a workspace export (its manifest says so, or it carries
 *  the historical `workspace.json`)? */
export function isWorkspaceTree(tree: EntityTree): boolean {
  const raw = tree.read(ENTITY_MANIFEST)
  if (raw != null) {
    try {
      if ((JSON.parse(raw) as { type?: unknown })?.type === 'workspace') return true
    } catch {
      // An unparseable manifest says nothing; the historical name may still.
    }
  }
  return tree.read(MANIFEST.workspace) != null
}

function readArray(tree: EntityTree, path: string, bag: IssueBag): unknown[] | null {
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    if (parsed.error !== 'missing') bag.error(path, '', 'invalid-json', `Not valid JSON: ${parsed.error}`)
    return null
  }
  if (!Array.isArray(parsed.value)) {
    bag.error(path, '', 'wrong-type', 'Expected an array of entries.')
    return null
  }
  return parsed.value
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The page names `_tree.json` declares (entityIds; a legacy entry's `id`). */
function validateWikiTree(tree: EntityTree, bag: IssueBag): Set<string> | null {
  const entries = readArray(tree, WIKI_TREE_FILE, bag)
  if (!entries) return null
  const names = new Set<string>()
  const parents: [number, string][] = []
  entries.forEach((e, i) => {
    const at = `/${i}`
    if (!isObject(e)) {
      bag.error(WIKI_TREE_FILE, at, 'wrong-type', 'A page entry is an object.')
      return
    }
    if (!nonEmpty(e.entityId)) {
      if (nonEmpty(e.id)) {
        bag.warn(WIKI_TREE_FILE, at, 'legacy-format', 'The page is named by its local `id`; the current format names it by `entityId`.')
        names.add(e.id)
      } else {
        bag.error(WIKI_TREE_FILE, `${at}/entityId`, 'missing-field', 'A page needs an `entityId` — the name of its `.md` file.')
      }
      return
    }
    if (names.has(e.entityId)) {
      bag.error(WIKI_TREE_FILE, `${at}/entityId`, 'duplicate-key', `Two pages are named "${e.entityId}".`)
    }
    names.add(e.entityId)
    if (e.parentEntityId != null) {
      if (typeof e.parentEntityId !== 'string') {
        bag.error(WIKI_TREE_FILE, `${at}/parentEntityId`, 'wrong-type', '`parentEntityId` is a page entityId or null.')
      } else parents.push([i, e.parentEntityId])
    }
  })
  for (const [i, parent] of parents) {
    if (!names.has(parent)) {
      bag.warn(WIKI_TREE_FILE, `/${i}/parentEntityId`, 'unknown-reference', `No page "${parent}" in the tree: the page lands at the top level.`)
    }
  }
  return names
}

function validateWikiAttachments(tree: EntityTree, pages: Set<string> | null, bag: IssueBag): void {
  const path = WIKI_ATTACHMENTS_META_FILE
  const entries = readArray(tree, path, bag)
  if (!entries) return
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    const at = `/${i}`
    if (!isObject(e)) {
      bag.error(path, at, 'wrong-type', 'An attachment entry is an object.')
      return
    }
    if (!nonEmpty(e.fileName)) {
      bag.error(path, `${at}/fileName`, 'missing-field', 'An attachment needs a `fileName`.')
      return
    }
    if (!nonEmpty(e.pageEntityId)) {
      if (e.pageId != null) bag.warn(path, at, 'legacy-format', 'The attachment names its page by local `pageId`; the current format uses `pageEntityId`.')
      else bag.error(path, `${at}/pageEntityId`, 'missing-field', 'An attachment needs the `pageEntityId` of its page.')
      return
    }
    const key = `${e.pageEntityId}/${e.fileName}`
    if (seen.has(key)) {
      bag.error(path, at, 'duplicate-key', `"${e.fileName}" is listed twice on page "${e.pageEntityId}"; both are stored at one path.`)
    }
    seen.add(key)
    if (pages && !pages.has(e.pageEntityId)) {
      bag.warn(path, `${at}/pageEntityId`, 'orphan-record', `No page "${e.pageEntityId}" in the tree: the attachment is skipped on import.`)
    }
    if (tree.read(`wiki/_attachments/${key}`) == null) {
      bag.error(path, at, 'missing-file', `wiki/_attachments/${key} is listed but absent.`)
    }
  })
}

function validateDictionaryIndex(tree: EntityTree, bag: IssueBag): void {
  const path = DICTIONARIES_INDEX
  const entries = readArray(tree, path, bag)
  if (!entries) return
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    const at = `/${i}`
    if (!isObject(e)) {
      bag.error(path, at, 'wrong-type', 'A dictionary entry is an object.')
      return
    }
    if (!nonEmpty(e.entityId)) {
      bag.error(path, `${at}/entityId`, 'missing-field', 'A dictionary needs an `entityId` — the folder its clone lands in.')
    } else {
      if (seen.has(e.entityId)) bag.error(path, `${at}/entityId`, 'duplicate-key', `Two dictionaries are named "${e.entityId}".`)
      seen.add(e.entityId)
    }
    if (e.name != null && typeof e.name !== 'string') bag.error(path, `${at}/name`, 'wrong-type', '`name` is a string.')
    const git = e.git
    if (!isObject(git) || !nonEmpty(git.url)) {
      bag.error(path, `${at}/git/url`, 'missing-field', 'A dictionary needs `git.url`, the repository it is synced from.')
    } else if (git.branch != null && typeof git.branch !== 'string') {
      bag.error(path, `${at}/git/branch`, 'wrong-type', '`git.branch` is a string.')
    }
  })
}

/** The workspace indexes of a workspace export; the entities inside it are
 *  validated as their own trees. */
export function validateWorkspace(tree: EntityTree): Issue[] {
  const bag = new IssueBag()
  const pages = tree.read(WIKI_TREE_FILE) != null ? validateWikiTree(tree, bag) : null
  if (tree.read(WIKI_ATTACHMENTS_META_FILE) != null) validateWikiAttachments(tree, pages, bag)
  if (tree.read(DICTIONARIES_INDEX) != null) validateDictionaryIndex(tree, bag)
  return bag.all()
}
