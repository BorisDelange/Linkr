/**
 * Per-file versioning marks, kept in project.config and keyed by export tree path
 * (`scripts/<idePath>`, `datasets/<dsPath>`):
 * - versionedDataFiles: data files (gitignored by default) explicitly INCLUDED
 * - excludedFiles:      code files (versioned by default) explicitly EXCLUDED
 */

export const MARK_LISTS = ['versionedDataFiles', 'excludedFiles'] as const
export type MarkList = (typeof MARK_LISTS)[number]
export type RemovedMarks = Partial<Record<MarkList, string[]>>

interface PathNode {
  id: string
  name: string
  parentId?: string | null
  type: string
}

function nodePath(files: readonly PathNode[], nodeId: string, stopAtScriptsRoot: boolean): string {
  const parts: string[] = []
  let current = files.find((f) => f.id === nodeId)
  while (current) {
    if (stopAtScriptsRoot && current.parentId == null && current.type === 'folder' && current.name === 'scripts') break
    parts.unshift(current.name)
    const parentId = current.parentId
    current = parentId ? files.find((f) => f.id === parentId) : undefined
  }
  return parts.join('/')
}

/** Path of an IDE node relative to the scripts root. Front-only keeps a synthetic
 *  root-level `scripts` folder that the export drops (reparenting its children),
 *  so the walk stops AT it — else the key would read `scripts/scripts/foo` and the
 *  `.gitignore` exception would never match the exported file. */
export function scriptsNodePath(files: readonly PathNode[], nodeId: string): string {
  return nodePath(files, nodeId, true)
}

export function datasetsNodePath(files: readonly PathNode[], nodeId: string): string {
  return nodePath(files, nodeId, false)
}

/**
 * Drop every mark on `key` or below it (a deleted folder takes its files' marks
 * along), so a file recreated at the same path starts from the default state
 * instead of inheriting a stale mark. Returns null when nothing was marked.
 */
export function dropMarksUnder(
  config: Record<string, unknown>,
  key: string,
): { config: Record<string, unknown>; removed: RemovedMarks } | null {
  const isUnder = (p: string) => p === key || p.startsWith(`${key}/`)
  const next = { ...config }
  const removed: RemovedMarks = {}
  for (const list of MARK_LISTS) {
    const raw = config[list]
    if (!Array.isArray(raw)) continue
    const gone = raw.filter((p): p is string => typeof p === 'string' && isUnder(p))
    if (gone.length === 0) continue
    next[list] = raw.filter((p) => !(typeof p === 'string' && isUnder(p)))
    removed[list] = gone
  }
  return Object.keys(removed).length > 0 ? { config: next, removed } : null
}

/** Put back marks taken by dropMarksUnder (undo of a delete), without duplicates. */
export function restoreMarks(config: Record<string, unknown>, removed: RemovedMarks): Record<string, unknown> {
  const next = { ...config }
  for (const list of MARK_LISTS) {
    const back = removed[list]
    if (!back?.length) continue
    const current = Array.isArray(config[list]) ? (config[list] as unknown[]).filter((p): p is string => typeof p === 'string') : []
    next[list] = [...current, ...back.filter((p) => !current.includes(p))]
  }
  return next
}
