/**
 * Reading an exported wiki tree back into pages — what the workspace pull writes
 * once the merged tree is built (lib/pull/apply.ts). A page is identified by its
 * `entityId`, which names its files; the local id is not in the tree
 * (lib/wiki/wiki-tree.ts).
 */
import type { LocalizedString } from '@/types'
import { toLocalized } from '@/lib/localized'
import { readWikiPageMeta } from '@/lib/wiki-page-meta'
import { readWikiTree, WIKI_TREE_FILE, type WikiTreePage } from './wiki-tree'

export const WIKI_PREFIX = 'wiki/'

/** Metadata a pull may write. Identity (entityId, lineage), the derived slug and
 *  the instance fields (workspaceId, timestamps, authorship) never travel. */
export const WIKI_MERGED_FIELDS = ['title', 'parentEntityId', 'sortOrder', 'icon', 'status', 'owner', 'reviewDueAt'] as const
export type WikiMergedField = (typeof WIKI_MERGED_FIELDS)[number]

export interface WikiSnapshotPage {
  /** Keyed by entityId: `id` is the entityId, `parentId` the parent's. */
  meta: WikiTreePage
  content: LocalizedString
  /** The page's main file in the exported tree — the pull row's path. */
  path: string
}

/** The pages an exported `wiki/` tree describes, keyed by entityId. */
export function readWikiSnapshot(files: Record<string, string>): Map<string, WikiSnapshotPage> {
  const pages = new Map<string, WikiSnapshotPage>()
  let raw: unknown
  try {
    raw = JSON.parse(files[WIKI_TREE_FILE] ?? '[]')
  } catch {
    return pages
  }
  for (const entry of readWikiTree(raw)) {
    const meta = { ...readWikiPageMeta(entry), title: toLocalized(entry.title) }
    const content: LocalizedString = {}
    let path = ''
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith(WIKI_PREFIX) || !file.endsWith('.md') || file.includes('/_attachments/')) continue
      const rel = file.slice(WIKI_PREFIX.length, -'.md'.length)
      const langMatch = /\.([a-z]{2})$/.exec(rel)
      const lang = langMatch ? langMatch[1] : 'en'
      const name = langMatch ? rel.slice(0, -3) : rel
      if (name !== meta.entityId) continue
      content[lang] = text
      if (!langMatch || !path) path = file
    }
    pages.set(meta.id, { meta, content, path: path || `${WIKI_PREFIX}${meta.id}.md` })
  }
  return pages
}
