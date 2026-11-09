import { useState } from 'react'

// Up to this many checks every group starts open; beyond, they start folded.
export const OPEN_GROUPS_UP_TO = 40

export interface FoldNode {
  key: string
  /** The group this one sits in, absent at the top level. */
  parent?: string
}

/**
 * What the fold button does next on a tree given level by level, top first:
 * `expand` is the shallowest level with a shown group still folded, `collapse`
 * the deepest with a shown group open. A group is shown when every group above
 * it is open.
 */
export function foldSteps(levels: FoldNode[][], isOpen: (key: string) => boolean) {
  const parentOf = new Map(levels.flat().map((n) => [n.key, n.parent]))
  const shown = (key: string) => {
    for (let p = parentOf.get(key); p; p = parentOf.get(p)) if (!isOpen(p)) return false
    return true
  }
  const expandAt = levels.findIndex((level) => level.some((n) => shown(n.key) && !isOpen(n.key)))
  let collapseAt = levels.length - 1
  while (collapseAt >= 0 && !levels[collapseAt].some((n) => shown(n.key) && isOpen(n.key))) collapseAt--
  return {
    expand: expandAt < 0 ? null : levels[expandAt].map((n) => n.key),
    collapse: collapseAt < 0 ? null : levels[collapseAt].map((n) => n.key),
  }
}

/**
 * Which groups of a checks sidebar are open. Each key starts open or folded by
 * `defaultOpen`; the state holds only the keys the user flipped, so a group
 * that appears later takes its default.
 */
export function useFoldState(defaultOpen: (key: string) => boolean) {
  const [flipped, setFlipped] = useState<Set<string>>(new Set())

  const isOpen = (key: string) => defaultOpen(key) !== flipped.has(key)

  const toggle = (key: string) => setFlipped((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const setOpen = (keys: string[], open: boolean) => setFlipped((prev) => {
    const next = new Set(prev)
    for (const key of keys) {
      if (defaultOpen(key) !== open) next.add(key)
      else next.delete(key)
    }
    return next
  })

  const rename = (from: string, to: string) => setFlipped((prev) => {
    if (!prev.has(from)) return prev
    const next = new Set(prev)
    next.delete(from)
    next.add(to)
    return next
  })

  return { isOpen, toggle, setOpen, rename }
}
