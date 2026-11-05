/**
 * The versioned form of a workspace wiki: `wiki/_tree.json` and
 * `wiki/_attachments/_meta.json`.
 *
 * A page is identified in the repo by its `entityId` — the readable name of its
 * `<entityId>.md` — and across instances by its `lineageId`, as every other
 * entity is. The local `id`/`parentId` (and an attachment's `id`/`pageId`) are
 * instance-local keys: carried in the file, every instance that re-minted them
 * rewrote the whole tree on its next push. The hierarchy travels as
 * `parentEntityId`, an attachment as `pageEntityId` + `fileName` (what page
 * content links to), stored at `wiki/_attachments/<pageEntityId>/<fileName>`.
 *
 * Local ids are derived back at import: `wikiPageId(<workspace id>, entityId)`.
 * Twin of `_build_wiki_section` (apps/api/app/services/workspace_export.py).
 */
import type { WikiAttachment, WikiPage } from '@/types'
import { deterministicId } from '@/lib/deterministic-id'
import { localized } from '@/lib/localized'
import { slugify } from '@linkr/format'

export const WIKI_TREE_FILE = 'wiki/_tree.json'
export const WIKI_ATTACHMENTS_META_FILE = 'wiki/_attachments/_meta.json'

/** Fields of a page that never reach `_tree.json`: local keys and the content,
 *  which lives in the page's own `.md` files. */
const LOCAL_PAGE_FIELDS = new Set(['id', 'parentId', 'content', 'history'])

/** The page's name in the repo. A page predating entityIds keeps the name its
 *  files were always written under. */
export function wikiPageFolder(page: Pick<WikiPage, 'id' | 'entityId' | 'title'>): string {
  return page.entityId || `${slugify(localized(page.title, 'en') || page.id)}--${page.id}`
}

/** A page's local id, from its workspace and its name in the repo: the same
 *  tree imported into the same workspace lands on the same ids. */
export function wikiPageId(workspaceId: string, entityId: string): string {
  return deterministicId(workspaceId, `wiki/${entityId}`)
}

export function wikiAttachmentId(pageId: string, fileName: string): string {
  return deterministicId(pageId, fileName)
}

export function wikiAttachmentPath(pageEntityId: string, fileName: string): string {
  return `wiki/_attachments/${pageEntityId}/${fileName}`
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * `_tree.json` entries, sorted by entityId. Each takes the page's fields in their
 * stored order, with `parentId` replaced in place by `parentEntityId`. `strip`
 * removes the instance fields (workspaceId, updatedAt…), as for every entity.
 */
export function buildWikiTree<T extends Record<string, unknown>>(
  pages: (Omit<WikiPage, 'content'> & Partial<Pick<WikiPage, 'content'>>)[],
  strip: (meta: Record<string, unknown>) => T,
): Record<string, unknown>[] {
  const folderOf = new Map(pages.map((p) => [p.id, wikiPageFolder(p)]))
  return pages
    .map((page) => {
      const entityId = folderOf.get(page.id)!
      const out: Record<string, unknown> = page.entityId ? {} : { entityId }
      for (const [key, value] of Object.entries(strip(page as unknown as Record<string, unknown>))) {
        if (key === 'parentId') out.parentEntityId = (page.parentId && folderOf.get(page.parentId)) || null
        else if (key === 'entityId') out.entityId = entityId
        // A page with no lineage omits it, whether the row has the key or not.
        else if ((key === 'lineageId' || key === 'parentLineageId') && value == null) continue
        else if (!LOCAL_PAGE_FIELDS.has(key)) out[key] = value
      }
      if (!('parentEntityId' in out)) out.parentEntityId = (page.parentId && folderOf.get(page.parentId)) || null
      return out
    })
    .sort((a, b) => byKey(a.entityId as string, b.entityId as string))
}

/** `_attachments/_meta.json` entries, sorted by page then file name. An
 *  attachment whose page is gone is left out — nothing could show it. */
export function buildWikiAttachmentMeta(
  attachments: Omit<WikiAttachment, 'data'>[],
  pages: Pick<WikiPage, 'id' | 'entityId' | 'title'>[],
): { pageEntityId: string; fileName: string; mimeType: string; fileSize: number; createdAt?: string }[] {
  const folderOf = new Map(pages.map((p) => [p.id, wikiPageFolder(p)]))
  return attachments
    .filter((a) => folderOf.has(a.pageId))
    .map((a) => ({
      pageEntityId: folderOf.get(a.pageId)!,
      fileName: a.fileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      ...(a.createdAt ? { createdAt: a.createdAt } : {}),
    }))
    .sort((a, b) => byKey(a.pageEntityId, b.pageEntityId) || byKey(a.fileName, b.fileName))
}

/** A page read from `_tree.json`, keyed within the tree by its entityId: `id` IS
 *  the entityId and `parentId` the parent's, until the import lands it. */
export type WikiTreePage = Omit<WikiPage, 'content'>

/**
 * `_tree.json` back into pages keyed by entityId (see `WikiTreePage`).
 *
 * Reads the format before entityIds were the identity too: an entry carrying its
 * `id` resolves `parentId` through the tree, and one without an entityId takes
 * the `<slug>--<id>` name its files were written under.
 */
export function readWikiTree(raw: unknown): WikiTreePage[] {
  if (!Array.isArray(raw)) return []
  const entries = raw.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
  const legacyName = (e: Record<string, unknown>): string | null => {
    if (typeof e.entityId === 'string' && e.entityId) return e.entityId
    if (typeof e.id !== 'string' || !e.id) return null
    return wikiPageFolder({ id: e.id, title: (e.title ?? {}) as WikiPage['title'] })
  }
  const nameOfId = new Map<string, string>()
  for (const e of entries) {
    const name = legacyName(e)
    if (name && typeof e.id === 'string') nameOfId.set(e.id, name)
  }
  const pages: WikiTreePage[] = []
  for (const e of entries) {
    const entityId = legacyName(e)
    if (!entityId) continue
    const { id: _id, parentId, parentEntityId, ...rest } = e
    const parent = typeof parentEntityId === 'string' ? parentEntityId
      : typeof parentId === 'string' ? nameOfId.get(parentId) ?? null
      : null
    pages.push({ ...(rest as unknown as WikiTreePage), id: entityId, entityId, parentId: parent })
  }
  return pages
}

/** An attachment read from `_meta.json`: `pageId` is the page's entityId and
 *  `path` where its bytes sit in the tree. */
export interface WikiTreeAttachment extends Omit<WikiAttachment, 'id' | 'data' | 'workspaceId'> {
  path: string
}

/** `_meta.json` back into attachments. Reads the older layout too, where an
 *  entry named its page by id and its bytes sat at `<id>-<fileName>`. */
export function readWikiAttachmentMeta(raw: unknown, pages: WikiTreePage[], rawTree: unknown): WikiTreeAttachment[] {
  if (!Array.isArray(raw)) return []
  const nameOfId = new Map<string, string>()
  if (Array.isArray(rawTree)) {
    for (const e of rawTree as Record<string, unknown>[]) {
      if (e && typeof e.id === 'string') {
        nameOfId.set(e.id, typeof e.entityId === 'string' && e.entityId ? e.entityId : wikiPageFolder({ id: e.id, title: (e.title ?? {}) as WikiPage['title'] }))
      }
    }
  }
  const known = new Set(pages.map((p) => p.entityId))
  const out: WikiTreeAttachment[] = []
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e.fileName !== 'string') continue
    const legacy = typeof e.pageEntityId !== 'string'
    const page = legacy ? nameOfId.get(String(e.pageId)) : (e.pageEntityId as string)
    if (!page || !known.has(page)) continue
    out.push({
      pageId: page,
      fileName: e.fileName,
      mimeType: typeof e.mimeType === 'string' ? e.mimeType : '',
      fileSize: typeof e.fileSize === 'number' ? e.fileSize : 0,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
      path: legacy ? `wiki/_attachments/${e.id}-${e.fileName}` : wikiAttachmentPath(page, e.fileName),
    })
  }
  return out
}
