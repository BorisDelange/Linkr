/**
 * The wiki half of the workspace pull: a 3-way merge per page between BASE (the
 * sync anchor), REMOTE (the remote head) and LOCAL (the database).
 *
 * A page is identified by its `id`, which `_tree.json` carries across instances.
 * Its metadata merges field by field, its content per language through the
 * paragraph merge (`markdown-merge.ts`). One pull row per page, one item per
 * field or language that the remote changed — so the user decides on exactly
 * what would be written.
 */
import type { LocalizedString, WikiPage } from '@/types'
import { toLocalized } from '@/lib/localized'
import { readWikiPageMeta } from '@/lib/wiki-page-meta'
import { buildPullFiles, itemIdFor, type PullDecision, type PullItem, type PullPlan } from '@/lib/pull-plan'
import type { GitTreePreview } from '@/lib/api/git'
import { mergeMarkdown, resolveMerge, type MarkdownMerge } from './markdown-merge'

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

/** null and undefined, absent and empty-string: all "no value". */
function norm(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'null'
  if (typeof v === 'object') {
    return JSON.stringify(Object.fromEntries(Object.entries(v as object).filter(([, x]) => x).sort(([a], [b]) => a.localeCompare(b))))
  }
  return JSON.stringify(v)
}

type FieldVerdict = 'none' | 'update' | 'conflict'

function threeWay(base: unknown, local: unknown, remote: unknown): FieldVerdict {
  const [b, l, r] = [norm(base), norm(local), norm(remote)]
  if (r === l || r === b) return 'none'
  return l === b ? 'update' : 'conflict'
}

export interface WikiContentMerge {
  lang: string
  base: string
  local: string
  remote: string
  merge: MarkdownMerge
}

export interface WikiPagePull {
  id: string
  path: string
  /** What the pull does to the page as a whole. */
  kind: 'add' | 'delete' | 'delete-conflict' | 'update'
  base?: WikiSnapshotPage
  remote?: WikiSnapshotPage
  local?: WikiPage
  fields: { field: WikiMergedField; state: 'update' | 'conflict' }[]
  contents: (WikiContentMerge & { state: 'update' | 'conflict' })[]
}

export interface PreparedWikiPull {
  remoteHead: string | null
  pages: WikiPagePull[]
  /** Files outside the wiki that the remote changed since BASE — not handled yet. */
  otherChanges: string[]
}

function changedOutside(preview: GitTreePreview): string[] {
  const paths = new Set([...Object.keys(preview.baseOids), ...Object.keys(preview.remoteOids)])
  return [...paths].filter((p) => !p.startsWith(WIKI_PREFIX) && preview.baseOids[p] !== preview.remoteOids[p]).sort()
}

export function prepareWikiPull(preview: GitTreePreview, localPages: WikiPage[]): PreparedWikiPull {
  const base = readWikiSnapshot(preview.base)
  const remote = readWikiSnapshot(preview.remote)
  const local = new Map(localPages.map((p) => [p.id, p]))
  const pages: WikiPagePull[] = []

  for (const id of new Set([...base.keys(), ...remote.keys()])) {
    const b = base.get(id)
    const r = remote.get(id)
    const l = local.get(id)
    if (!r) {
      // Removed upstream. Gone here too: nothing to do. Edited here since: conflict.
      if (!l || !b) continue
      const edited = WIKI_MERGED_FIELDS.some((f) => norm(b.meta[f]) !== norm(l[f]))
        || norm(b.content) !== norm(toLocalized(l.content))
      pages.push({ id, path: b.path, kind: edited ? 'delete-conflict' : 'delete', base: b, local: l, fields: [], contents: [] })
      continue
    }
    if (!l) {
      // Deleted here after BASE and untouched upstream → our deletion stands.
      if (b && norm(b.content) === norm(r.content) && WIKI_MERGED_FIELDS.every((f) => norm(b.meta[f]) === norm(r.meta[f]))) continue
      pages.push({ id, path: r.path, kind: 'add', base: b, remote: r, fields: [], contents: [] })
      continue
    }

    const fields: WikiPagePull['fields'] = []
    for (const field of WIKI_MERGED_FIELDS) {
      const verdict = threeWay(b?.meta[field], l[field], r.meta[field])
      if (verdict !== 'none') fields.push({ field, state: verdict })
    }
    const lc = toLocalized(l.content)
    const contents: WikiPagePull['contents'] = []
    for (const lang of new Set([...Object.keys(r.content), ...Object.keys(lc)])) {
      const bt = b?.content[lang] ?? ''
      const lt = lc[lang] ?? ''
      const rt = r.content[lang] ?? ''
      if (rt === lt || rt === bt) continue
      const merge = mergeMarkdown(bt, lt, rt)
      contents.push({ lang, base: bt, local: lt, remote: rt, merge, state: merge.conflicts ? 'conflict' : 'update' })
    }
    if (fields.length || contents.length) {
      pages.push({ id, path: r.path, kind: 'update', base: b, remote: r, local: l, fields, contents })
    }
  }
  pages.sort((a, b) => a.path.localeCompare(b.path))
  return { remoteHead: preview.remoteHead, pages, otherChanges: changedOutside(preview) }
}

export interface WikiPullLabels {
  page: string
  field: (field: WikiMergedField) => string
  content: (lang: string) => string
  autoMerged: string
}

export function buildWikiPullPlan(prepared: PreparedWikiPull, branch: string, labels: WikiPullLabels): PullPlan {
  const rows = prepared.pages.map((p) => {
    const items: PullItem[] = []
    if (p.kind === 'add') items.push({ key: 'page', label: labels.page, state: 'add' })
    else if (p.kind === 'delete') items.push({ key: 'page', label: labels.page, state: 'delete' })
    else if (p.kind === 'delete-conflict') items.push({ key: 'page', label: labels.page, state: 'conflict' })
    else {
      for (const f of p.fields) items.push({ key: `field:${f.field}`, label: labels.field(f.field), state: f.state })
      for (const c of p.contents) {
        items.push({
          key: `content:${c.lang}`,
          label: labels.content(c.lang),
          state: c.state,
          detail: c.state === 'update' && c.local !== c.base ? labels.autoMerged : undefined,
        })
      }
    }
    return { path: p.path, items }
  })
  return { scope: 'workspaces', branch, remoteHead: prepared.remoteHead, files: buildPullFiles('workspaces', rows) }
}

/** What accepting a content item writes: the merge, conflicts settled on the remote. */
export function acceptedContent(c: WikiContentMerge): string {
  return resolveMerge(c.merge, 'remote', { local: c.local, remote: c.remote })
}

/** The page as it would stand with every remote change accepted — the diff's right side. */
export function pageAfterPull(p: WikiPagePull): { meta: Partial<WikiPage>; content: LocalizedString } | null {
  if (p.kind === 'delete' || p.kind === 'delete-conflict') return null
  if (p.kind === 'add') return { meta: p.remote!.meta, content: p.remote!.content }
  const meta: Partial<WikiPage> = { ...p.local! }
  for (const f of p.fields) (meta as Record<string, unknown>)[f.field] = p.remote!.meta[f.field]
  const content = { ...toLocalized(p.local!.content) }
  for (const c of p.contents) content[c.lang] = acceptedContent(c)
  return { meta, content }
}

export interface WikiPullWriter {
  create(page: WikiPage): Promise<void>
  update(id: string, changes: Partial<WikiPage>): Promise<void>
  delete(id: string): Promise<void>
}

/** Write the accepted items. Declined ones leave the local value, which then
 *  shows as a change to push. */
export async function applyWikiPull(
  prepared: PreparedWikiPull,
  decisions: Map<string, PullDecision>,
  workspaceId: string,
  writer: WikiPullWriter,
): Promise<void> {
  const accepted = (p: WikiPagePull, key: string) => decisions.get(itemIdFor(p.path, key)) === 'accept'
  const now = new Date().toISOString()
  for (const p of prepared.pages) {
    if (p.kind === 'add') {
      if (accepted(p, 'page')) {
        await writer.create({ ...p.remote!.meta, content: p.remote!.content, workspaceId, updatedAt: now } as WikiPage)
      }
      continue
    }
    if (p.kind === 'delete' || p.kind === 'delete-conflict') {
      if (accepted(p, 'page')) await writer.delete(p.id)
      continue
    }
    const changes: Partial<WikiPage> = {}
    for (const f of p.fields) {
      if (accepted(p, `field:${f.field}`)) (changes as Record<string, unknown>)[f.field] = p.remote!.meta[f.field] ?? null
    }
    const content = { ...toLocalized(p.local!.content) }
    let contentChanged = false
    for (const c of p.contents) {
      if (!accepted(p, `content:${c.lang}`)) continue
      content[c.lang] = acceptedContent(c)
      contentChanged = true
    }
    if (contentChanged) changes.content = content
    if (Object.keys(changes).length) await writer.update(p.id, { ...changes, updatedAt: now })
  }
}
