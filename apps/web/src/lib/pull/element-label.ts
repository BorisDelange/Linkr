/**
 * What a changed file is to a person: a dashboard's name, a wiki page's title,
 * a script's file name — shown on the quick-action cards instead of the path.
 */
import { localized } from '@/lib/localized'
import type { ThreeWayFile } from './three-way'

type Named = { name?: unknown; title?: unknown; label?: unknown; dashboard?: { name?: unknown } }

function nameIn(text: string | null | undefined, language: string): string | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Named
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const raw = value.dashboard?.name ?? value.name ?? value.title ?? value.label
    if (typeof raw === 'string') return raw || null
    if (raw && typeof raw === 'object') return localized(raw as Record<string, string>, language) || null
  } catch { /* not JSON */ }
  return null
}

/** Page id and entityId → title, from the wiki trees the preview carries. */
export function wikiTitles(files: ThreeWayFile[], language: string): Map<string, string> {
  const titles = new Map<string, string>()
  const tree = files.find((f) => f.path === 'wiki/_tree.json')
  for (const text of [tree?.base, tree?.local, tree?.remote]) {
    if (!text) continue
    try {
      for (const page of JSON.parse(text) as { id: string; entityId?: string; title?: Record<string, string> }[]) {
        const title = localized(page.title ?? {}, language)
        if (!title) continue
        if (page.entityId) titles.set(page.entityId, title)
        titles.set(page.id, title)
      }
    } catch { /* unreadable tree */ }
  }
  return titles
}

/** Structural files, named for what they hold rather than how they are stored. */
const STRUCTURAL: Record<string, string> = {
  'wiki/_tree.json': 'versioning.label_wiki_tree',
  'scripts/_tree.json': 'versioning.label_scripts_tree',
  'datasets/_tree.json': 'versioning.label_datasets_tree',
  'entity.json': 'versioning.label_manifest',
  'tasks.json': 'versioning.label_tasks',
}

export function elementLabels(files: ThreeWayFile[], language: string, t?: (key: string) => string): Map<string, string> {
  const wiki = wikiTitles(files, language)
  const labels = new Map<string, string>()
  for (const f of files) {
    const structural = STRUCTURAL[f.path] ?? STRUCTURAL[f.path.split('/').slice(-2).join('/')] ?? STRUCTURAL[f.path.split('/').pop() ?? '']
    if (structural && t) {
      labels.set(f.path, t(structural))
      continue
    }
    const wikiPage = /^wiki\/([^/]+?)(?:\.[a-z]{2})?\.md$/.exec(f.path)
    if (wikiPage) {
      const stem = wikiPage[1]
      const title = wiki.get(stem) ?? wiki.get(stem.split('--').pop() ?? stem)
      if (title) labels.set(f.path, title)
      continue
    }
    const named = /\.json$/.test(f.path) ? nameIn(f.remote, language) ?? nameIn(f.local, language) : null
    if (named && !/(^|\/)(entity|_tree|_meta)\.json$/.test(f.path)) labels.set(f.path, named)
    else labels.set(f.path, f.path.split('/').pop() ?? f.path)
  }
  return labels
}
