import { createContext } from 'react'
import type { CriteriaGroupNode } from '@/types'

/** The criteria a cohort had when its builder opened: they start collapsed, a
 *  summary line each. A criterion added since starts open, to be configured. */
export const InitiallyCollapsedContext = createContext<ReadonlySet<string>>(new Set())

export function criterionIds(group: CriteriaGroupNode, into = new Set<string>()): Set<string> {
  for (const child of group.children) {
    if (child.kind === 'group') criterionIds(child, into)
    else into.add(child.id)
  }
  return into
}
