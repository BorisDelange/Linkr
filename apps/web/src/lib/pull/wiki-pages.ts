/**
 * A wiki page in the pull, as one row: its text (`wiki/<page>.md`, one file per
 * language) and its entry in `wiki/_tree.json` (title, status, place in the
 * tree…) are stored apart, but a person edits one page. The entry becomes an
 * item of the page's main text row; decisions on it are translated back to the
 * `_tree.json` element before the merged tree is built.
 */
import { itemIdFor, type PullDecision, type PullFile, type PullPlan } from '@/lib/pull-plan'
import { WIKI_MERGED_FIELDS, WIKI_PREFIX } from '@/lib/wiki/wiki-pull'
import type { ThreeWayFile } from './three-way'

const TREE = `${WIKI_PREFIX}_tree.json`
const META_KEY = 'page-settings:'

interface TreeEntry { id: string; entityId?: string; [field: string]: unknown }

function entries(text: string | null | undefined): Map<string, TreeEntry> {
  try {
    return new Map((text ? JSON.parse(text) as TreeEntry[] : []).map((e) => [e.id, e]))
  } catch {
    return new Map()
  }
}

/** The page a wiki text file belongs to: `<entityId>.md`, or `<slug>--<id>.md`. */
function pageOf(path: string, pages: Map<string, TreeEntry>): { id: string; main: boolean } | null {
  if (!path.startsWith(WIKI_PREFIX) || !path.endsWith('.md') || path.includes('/_attachments/')) return null
  const rel = path.slice(WIKI_PREFIX.length, -'.md'.length)
  const lang = /\.([a-z]{2})$/.exec(rel)
  const name = lang ? rel.slice(0, -3) : rel
  for (const page of pages.values()) {
    if (page.entityId ? name === page.entityId : name.endsWith(`--${page.id}`)) return { id: page.id, main: !lang }
  }
  return null
}

export interface GroupedWiki {
  plan: PullPlan
  /** The decisions as the merged tree reads them (page settings → `_tree.json`). */
  toReal: (decisions: Map<string, PullDecision>) => Map<string, PullDecision>
}

/**
 * `fieldLabel` names a changed field (title, status…) for the item's detail;
 * `settingsLabel` is the item's label.
 */
export function groupWikiPages(
  plan: PullPlan, files: ThreeWayFile[], settingsLabel: string, fieldLabel: (field: string) => string,
): GroupedWiki {
  const identity: GroupedWiki = { plan, toReal: (d) => d }
  const treeRow = plan.files.find((f) => f.path === TREE)
  const tree = files.find((f) => f.path === TREE)
  if (!treeRow || !tree) return identity

  const [base, local, remote] = [entries(tree.base), entries(tree.local), entries(tree.remote)]
  const pages = new Map([...base, ...local, ...remote])
  // Each page's text row: its main language when that changed, else the first.
  const rowOf = new Map<string, PullFile>()
  for (const f of plan.files) {
    const page = pageOf(f.path, pages)
    if (page && (page.main || !rowOf.has(page.id))) rowOf.set(page.id, f)
  }

  const moved = new Map<string, { row: PullFile; detail: string }>()
  for (const item of treeRow.items) {
    const id = item.key.replace(/^el:/, '')
    const row = rowOf.get(id)
    if (!row) continue
    const [b, r] = [base.get(id), remote.get(id)]
    const changed = WIKI_MERGED_FIELDS.filter((k) => JSON.stringify(b?.[k]) !== JSON.stringify(r?.[k]))
    moved.set(item.key, { row, detail: changed.map(fieldLabel).join(', ') })
  }
  if (moved.size === 0) return identity

  const viewToReal = new Map<string, string>()
  const rows = plan.files.flatMap((f) => {
    if (f === treeRow) {
      const items = f.items.filter((i) => !moved.has(i.key))
      return items.length ? [{ ...f, items }] : []
    }
    const extra = treeRow.items.filter((i) => moved.get(i.key)?.row === f).map((i) => {
      const key = `${META_KEY}${i.key.replace(/^el:/, '')}`
      viewToReal.set(itemIdFor(f.path, key), itemIdFor(TREE, i.key))
      return { ...i, key, label: settingsLabel, detail: moved.get(i.key)!.detail || undefined }
    })
    return [extra.length ? { ...f, items: [...f.items, ...extra] } : f]
  })

  return {
    plan: { ...plan, files: rows },
    toReal: (decisions) => new Map([...decisions].map(([id, d]) => [viewToReal.get(id) ?? id, d])),
  }
}
