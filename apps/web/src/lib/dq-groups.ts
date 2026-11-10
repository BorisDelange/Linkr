/**
 * The categories a rule set files its checks under: a tree of named groups
 * (`DqRuleSet.checkGroups`, by `parentKey`) plus the keys checks name without a
 * declaration — a check generated from a schema names its table, and that table
 * is a top-level category until someone renames or moves it.
 *
 * A key is set once and never changes: renaming a category rewrites its name
 * only, moving it rewrites its `parentKey` only, so no check is touched.
 */
import { slugify } from '@linkr/format'
import { localized } from '@/lib/localized'
import type { DqCheckGroup, DqCustomCheck, LocalizedString } from '@/types'

/** One step of a check's category path, root first: what a run snapshots. */
export interface DqGroupStep {
  key: string
  name: LocalizedString
}

export interface DqGroupNode<C> {
  key: string
  name: LocalizedString
  /** Not in `checkGroups`: only named by its checks. */
  implicit: boolean
  children: DqGroupNode<C>[]
  checks: C[]
}

/**
 * The categories as stored, legacy shapes included: before categories had names
 * the list held the bare keys of the empty ones.
 */
export function readCheckGroups(raw: unknown): DqCheckGroup[] {
  if (!Array.isArray(raw)) return []
  const out: DqCheckGroup[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const group: DqCheckGroup | null = typeof item === 'string'
      ? { key: item, name: { en: item }, parentKey: null }
      : item && typeof item === 'object' && typeof (item as DqCheckGroup).key === 'string'
        ? {
            key: (item as DqCheckGroup).key,
            name: (item as DqCheckGroup).name ?? {},
            parentKey: (item as DqCheckGroup).parentKey ?? null,
          }
        : null
    if (group?.key && !seen.has(group.key)) {
      seen.add(group.key)
      out.push(group)
    }
  }
  return out
}

/** A category's name, or its key when it was never given one. */
export function groupLabel(group: { key: string; name?: LocalizedString | null }, lang: string): string {
  return localized(group.name, lang) || group.key
}

/** Every category: the declared ones, then the keys only checks name, in list order. */
export function allGroups(groups: DqCheckGroup[], checks: Pick<DqCustomCheck, 'groupKey'>[]): DqCheckGroup[] {
  const declared = new Set(groups.map((g) => g.key))
  const out = [...groups]
  for (const c of checks) {
    if (c.groupKey && !declared.has(c.groupKey)) {
      declared.add(c.groupKey)
      out.push({ key: c.groupKey, name: { en: c.groupKey }, parentKey: null })
    }
  }
  return out
}

/** The parent of `key`, or null when it is at the top or its parent is gone. */
function parentOf(byKey: Map<string, DqCheckGroup>, key: string): string | null {
  const parent = byKey.get(key)?.parentKey ?? null
  return parent && byKey.has(parent) && parent !== key ? parent : null
}

/** A category's path, root first. A cycle (a hand-edited export) stops where it loops. */
export function groupPath(groups: DqCheckGroup[], key: string | null): DqGroupStep[] {
  if (!key) return []
  const byKey = new Map(groups.map((g) => [g.key, g]))
  const path: DqGroupStep[] = []
  const seen = new Set<string>()
  let current: string | null = key
  while (current && !seen.has(current)) {
    seen.add(current)
    const group = byKey.get(current)
    path.unshift({ key: current, name: group?.name ?? { en: current } })
    current = parentOf(byKey, current)
  }
  return path
}

/** `key` and every category under it. */
export function subtreeKeys(groups: DqCheckGroup[], key: string): Set<string> {
  const out = new Set([key])
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) {
      if (g.parentKey && out.has(g.parentKey) && !out.has(g.key)) {
        out.add(g.key)
        grew = true
      }
    }
  }
  return out
}

/** A key for a new category named `name`, unique among `taken`. */
export function newGroupKey(name: LocalizedString, taken: Iterable<string>): string {
  const used = new Set(taken)
  const text = localized(name, 'en').trim()
  const base = (text && slugify(text)) || 'group'
  let key = base
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`
  return key
}

/**
 * The categories with `key` renamed. A category only its checks named is
 * declared here, keeping its key, so the checks stay where they are.
 */
export function renameGroup(groups: DqCheckGroup[], key: string, name: LocalizedString): DqCheckGroup[] {
  return groups.some((g) => g.key === key)
    ? groups.map((g) => (g.key === key ? { ...g, name } : g))
    : [...groups, { key, name, parentKey: null }]
}

/** Whether `key` may go under `parentKey`: not under itself or one of its own. */
export function canMoveGroup(groups: DqCheckGroup[], key: string, parentKey: string | null): boolean {
  return parentKey === null || !subtreeKeys(groups, key).has(parentKey)
}

/**
 * The categories with `key` moved under `parentKey` (null: to the top), placed
 * last among its new siblings. Refused (unchanged) when it would sit inside itself.
 */
export function moveGroup(groups: DqCheckGroup[], key: string, parentKey: string | null): DqCheckGroup[] {
  if (!canMoveGroup(groups, key, parentKey)) return groups
  const existing = groups.find((g) => g.key === key)
  const moved: DqCheckGroup = { key, name: existing?.name ?? { en: key }, parentKey }
  return [...groups.filter((g) => g.key !== key), moved]
}

/** The categories without `key`; its sub-categories move up to its parent. */
export function removeGroup(groups: DqCheckGroup[], key: string): DqCheckGroup[] {
  const parent = groups.find((g) => g.key === key)?.parentKey ?? null
  return groups
    .filter((g) => g.key !== key)
    .map((g) => (g.parentKey === key ? { ...g, parentKey: parent } : g))
}

/** The categories without `key` and everything under it. */
export function removeSubtree(groups: DqCheckGroup[], key: string): DqCheckGroup[] {
  const gone = subtreeKeys(groups, key)
  return groups.filter((g) => !gone.has(g.key))
}

/**
 * The category tree with its checks, in list order, and the checks filed under
 * no category (or under one that no longer resolves) apart. `keepEmpty` keeps
 * the categories with no check anywhere under them, which a filtered list hides.
 */
export function groupTree<C extends { groupKey: string | null }>(
  groups: DqCheckGroup[],
  checks: C[],
  { keepEmpty = true }: { keepEmpty?: boolean } = {},
): { roots: DqGroupNode<C>[]; ungrouped: C[] } {
  const every = allGroups(groups, checks)
  const byKey = new Map(every.map((g) => [g.key, g]))
  const nodes = new Map<string, DqGroupNode<C>>(every.map((g) => [
    g.key, { key: g.key, name: g.name, implicit: !groups.some((d) => d.key === g.key), children: [], checks: [] },
  ]))
  const ungrouped: C[] = []
  for (const c of checks) {
    const node = c.groupKey ? nodes.get(c.groupKey) : undefined
    if (node) node.checks.push(c)
    else ungrouped.push(c)
  }
  const roots: DqGroupNode<C>[] = []
  for (const g of every) {
    const node = nodes.get(g.key)!
    // A parent that loops back to this category files it at the top instead.
    const parent = parentOf(byKey, g.key)
    const parentNode = parent && !subtreeKeys(every, g.key).has(parent) ? nodes.get(parent) : undefined
    if (parentNode) parentNode.children.push(node)
    else roots.push(node)
  }
  if (keepEmpty) return { roots, ungrouped }
  const prune = (list: DqGroupNode<C>[]): DqGroupNode<C>[] => list
    .map((n) => ({ ...n, children: prune(n.children) }))
    .filter((n) => n.checks.length > 0 || n.children.length > 0)
  return { roots: prune(roots), ungrouped }
}

/** Every check in a node and under it. */
export function nodeChecks<C>(node: DqGroupNode<C>): C[] {
  return [...node.checks, ...node.children.flatMap(nodeChecks)]
}
