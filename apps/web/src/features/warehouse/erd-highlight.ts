import { createContext, useContext, useMemo, useState } from 'react'
import type { Edge } from '@xyflow/react'

/** A connection point, as React Flow names it: the node and its handle id. */
export interface HandleRef {
  node: string
  handle: string
}

interface ErdHighlight {
  /** The table clicked, whose links are shown. */
  selected: string | null
  /** The tables linked to the selected one: they stay lit while the rest fade. */
  related: ReadonlySet<string>
  hovered: HandleRef | null
  setHovered: (h: HandleRef | null) => void
}

const ErdHighlightContext = createContext<ErdHighlight>({ selected: null, related: new Set(), hovered: null, setHovered: () => {} })

export const ErdHighlightProvider = ErdHighlightContext.Provider

export function useErdHighlight(): ErdHighlight {
  return useContext(ErdHighlightContext)
}

/** Props that make a handle report hovering, so its links light up. */
export function useHandleHover(node: string, handle: string) {
  const { setHovered } = useErdHighlight()
  return {
    onMouseEnter: () => setHovered({ node, handle }),
    onMouseLeave: () => setHovered(null),
  }
}

const touchesNode = (e: Edge, node: string) => e.source === node || e.target === node
const touchesHandle = (e: Edge, h: HandleRef) =>
  (e.source === h.node && e.sourceHandle === h.handle) || (e.target === h.node && e.targetHandle === h.handle)

const BASE = { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5, opacity: 0.35 }
const ON = { stroke: 'var(--color-muted-foreground)', strokeWidth: 2, opacity: 0.9 }
const SELECTED = { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5, opacity: 0.7 }

/**
 * Selection and hover state for a diagram, and the edges to draw from it —
 * always under the tables. `showAll` draws every edge (the mapping diagram, a
 * handful of links); without it only the clicked table's and the hovered
 * point's links show, and the tables they do not touch fade, so a link running
 * under them stays visible through them.
 */
export function useErdHighlightState(edges: Edge[], showAll: boolean) {
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<HandleRef | null>(null)

  const shown = useMemo(
    () =>
      edges.flatMap((e): Edge[] => {
        const hot = !!hovered && touchesHandle(e, hovered)
        const picked = !!selected && touchesNode(e, selected)
        if (!showAll && !hot && !picked) return []
        return [{ ...e, style: hot ? ON : picked ? SELECTED : BASE, animated: hot }]
      }),
    [edges, hovered, selected, showAll],
  )

  const related = useMemo(
    () => new Set(selected ? edges.filter((e) => touchesNode(e, selected)).flatMap((e) => [e.source, e.target]) : []),
    [edges, selected],
  )
  const context = useMemo<ErdHighlight>(() => ({ selected, related, hovered, setHovered }), [selected, related, hovered])
  const toggle = (node: string) => setSelected((cur) => (cur === node ? null : node))
  return { shown, context, toggle, clear: () => setSelected(null) }
}
