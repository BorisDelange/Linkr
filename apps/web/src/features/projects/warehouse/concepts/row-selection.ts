/**
 * File-explorer selection for a concept table row click.
 *
 * Pulled out of the table because the three modifier paths are easy to get
 * subtly wrong — a Ctrl-click that clears the set, a Shift-range that forgets
 * its anchor — and none of it is observable from the rendered markup.
 */

export interface RowSelectionInput {
  /** The clicked row's concept id. */
  conceptId: number
  /** Concept ids in display order, used to resolve a Shift range. */
  order: number[]
  /** Currently selected ids. */
  selected: ReadonlySet<number>
  /** The last row clicked without Shift, or null. */
  anchor: number | null
  /** Cmd (mac) or Ctrl held. */
  toggle: boolean
  /** Shift held. */
  range: boolean
  /** In pick mode the set IS the result, so a plain click toggles too. */
  pickMode: boolean
}

export interface RowSelectionResult {
  /** The new selection, or null to leave it untouched. */
  selected: Set<number> | null
  /** The new anchor, or null to leave it untouched. */
  anchor: number | null
  /** Ids newly added, for callers that mirror names/colours alongside. */
  added: number[]
  /** True when the click means "show this one", not "collect it". */
  single: boolean
}

/**
 * Resolve one click into the next selection.
 *
 * Shift extends from the anchor; Cmd/Ctrl toggles one row and moves the anchor
 * there; a plain click selects a single row — except in pick mode, where it
 * toggles, since there is no detail panel for a single row to drive.
 *
 * Shift with Cmd/Ctrl adds the range to the selection rather than replacing it,
 * which is what a file explorer does.
 */
export function resolveRowSelection(input: RowSelectionInput): RowSelectionResult {
  const { conceptId, order, selected, anchor, range, pickMode } = input
  // Pick mode has no single-selection mode to fall back to, so every plain
  // click is a toggle — the same rule the table applied inline.
  const toggle = input.toggle || pickMode

  if (range && anchor != null) {
    const from = order.indexOf(anchor)
    const to = order.indexOf(conceptId)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      // Ctrl+Shift adds to what is already picked; Shift alone replaces it.
      const next = toggle ? new Set(selected) : new Set<number>()
      const added: number[] = []
      for (const id of order.slice(lo, hi + 1)) {
        if (!next.has(id)) added.push(id)
        next.add(id)
      }
      // The anchor deliberately stays put: dragging a range wider by shift
      // clicking again must extend from the same origin, not from the last edge.
      return { selected: next, anchor: null, added, single: false }
    }
  }

  if (toggle) {
    const next = new Set(selected)
    const adding = !next.has(conceptId)
    if (adding) next.add(conceptId)
    else next.delete(conceptId)
    return {
      selected: next,
      anchor: conceptId,
      added: adding ? [conceptId] : [],
      single: false,
    }
  }

  // Plain click → single selection, which drives the detail panel. Only mint a
  // new Set when there is something to clear: an empty one still counts as a new
  // identity, and would re-render every row on each click.
  return {
    selected: selected.size > 0 ? new Set() : null,
    anchor: conceptId,
    added: [],
    single: true,
  }
}
