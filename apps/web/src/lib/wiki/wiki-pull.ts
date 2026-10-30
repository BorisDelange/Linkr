/**
 * Reading an exported wiki tree back into pages — what the workspace pull writes
 * once the merged tree is built (lib/pull/apply.ts). A page is identified by its
 * `id`, which `_tree.json` carries across instances.
 */
import type { LocalizedString, WikiPage } from '@/types'
import { toLocalized } from '@/lib/localized'
import { readWikiPageMeta } from '@/lib/wiki-page-meta'

export const WIKI_PREFIX = 'wiki/'
const TREE_FILE = 'wiki/_tree.json'

/** Metadata a pull may write. Identity (id, entityId), the derived slug and the
 *  instance fields (workspaceId, timestamps, authorship) never travel. */
export const WIKI_MERGED_FIELDS = ['title', 'parentId', 'sortOrder', 'icon', 'status', 'owner', 'reviewDueAt'] as const
export type WikiMergedField = (typeof WIKI_MERGED_FIELDS)[number]

export interface WikiSnapshotPage {
  meta: Omit<WikiPage, 'content'>
  content: LocalizedString
  /** The page's main file in the exported tree — the pull row's path. */
  path: string
}

/** The pages an exported `wiki/` tree describes, keyed by id. */
export function readWikiSnapshot(files: Record<string, string>): Map<string, WikiSnapshotPage> {
  const pages = new Map<string, WikiSnapshotPage>()
  let tree: Omit<WikiPage, 'content'>[] = []
  try {
    tree = JSON.parse(files[TREE_FILE] ?? '[]')
  } catch {
    return pages
  }
  for (const raw of tree) {
    const meta = { ...readWikiPageMeta(raw), title: toLocalized(raw.title) }
    const content: LocalizedString = {}
    let path = ''
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith(WIKI_PREFIX) || !file.endsWith('.md') || file.includes('/_attachments/')) continue
      const rel = file.slice(WIKI_PREFIX.length, -'.md'.length)
      const langMatch = /\.([a-z]{2})$/.exec(rel)
      const lang = langMatch ? langMatch[1] : 'en'
      const name = langMatch ? rel.slice(0, -3) : rel
      const matches = meta.entityId ? name === meta.entityId : name.endsWith(`--${meta.id}`)
      if (!matches) continue
      content[lang] = text
      if (!langMatch || !path) path = file
    }
    pages.set(meta.id, { meta, content, path: path || `${WIKI_PREFIX}${meta.entityId ?? meta.id}.md` })
  }
  return pages
}
