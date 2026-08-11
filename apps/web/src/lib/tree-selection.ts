/**
 * Multi-selection for a file explorer: plain click, Cmd/Ctrl-click to toggle one,
 * Shift-click to extend a range.
 *
 * Pure functions over the VISIBLE order, because that is what a range means to
 * the user: Shift-clicking two rows selects what lies between them on screen, not
 * in the underlying tree (a collapsed folder's hidden children must not be swept
 * in). Callers pass the flattened list of rows they are actually rendering.
 *
 * Shared so every tree (IDE, ETL, SQL scripts, datasets) behaves the same way —
 * they were written separately and had already drifted on smaller things.
 */

/** Which modifier a click carried. `meta` is Cmd on Mac, Ctrl elsewhere. */
export interface ClickModifiers {
  meta?: boolean
  shift?: boolean
}

export interface Selection {
  /** Every selected id. */
  ids: string[]
  /**
   * Where a Shift-range extends FROM: the last row clicked without Shift.
   *
   * Kept separately from "the last selected id" so repeated Shift-clicks pivot
   * around the same origin — otherwise each one moves the anchor and the range
   * creeps instead of growing and shrinking about a fixed point.
   */
  anchorId: string | null
}

export const EMPTY_SELECTION: Selection = { ids: [], anchorId: null }

/**
 * The selection after clicking `id` among `visibleIds`.
 *
 * A plain click replaces the selection, so clicking a row in a multi-selection
 * collapses to it — the behaviour of every file manager.
 */
export function selectOnClick(
  current: Selection,
  id: string,
  visibleIds: string[],
  modifiers: ClickModifiers = {},
): Selection {
  if (modifiers.shift && current.anchorId) {
    const from = visibleIds.indexOf(current.anchorId)
    const to = visibleIds.indexOf(id)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      // The anchor does NOT move: Shift-clicking again re-measures from the same
      // origin, so the range can shrink as well as grow.
      return { ids: visibleIds.slice(lo, hi + 1), anchorId: current.anchorId }
    }
    // The anchor is no longer visible (its folder was collapsed): fall through to
    // treating this as a fresh click rather than selecting nothing.
  }

  if (modifiers.meta) {
    const has = current.ids.includes(id)
    const ids = has ? current.ids.filter((x) => x !== id) : [...current.ids, id]
    // Deselecting the anchor leaves no origin to extend from; the clicked row
    // becomes the new one when it was added.
    return { ids, anchorId: has ? (ids.length > 0 ? current.anchorId : null) : id }
  }

  return { ids: [id], anchorId: id }
}

/**
 * Drop ids that no longer exist (a file was deleted or renamed away).
 *
 * A stale id in the selection would make a bulk action report a count it cannot
 * deliver, or act on nothing at all.
 */
export function pruneSelection(current: Selection, existingIds: Iterable<string>): Selection {
  const alive = new Set(existingIds)
  const ids = current.ids.filter((id) => alive.has(id))
  if (ids.length === current.ids.length && (current.anchorId == null || alive.has(current.anchorId))) {
    return current
  }
  return { ids, anchorId: current.anchorId && alive.has(current.anchorId) ? current.anchorId : null }
}

/**
 * The ids a context-menu action applies to.
 *
 * Right-clicking INSIDE a multi-selection acts on the whole selection; right-
 * clicking outside it acts on that row alone — otherwise a menu opened on an
 * unselected file would silently operate on rows elsewhere in the tree.
 */
export function actionTargets(current: Selection, clickedId: string): string[] {
  return current.ids.includes(clickedId) && current.ids.length > 1
    ? current.ids
    : [clickedId]
}

/**
 * The ids a bulk action will actually touch, and whether it IS a bulk action.
 *
 * The two must be decided together. Each tree derived them separately — the row
 * tint from the raw `selection.ids.length > 1`, but `bulk` from the ids left
 * after dropping folders (the actions are file-only) — so a shift-range that
 * swept a folder in showed two rows highlighted while Delete removed only the
 * one clicked. The dataset tree counted folders in both, and could offer a menu
 * whose every other entry was hidden. One result, one truth.
 *
 * `isActionable` is the per-tree rule for what an action can apply to (a file
 * that exists, is not virtual, …); ids it rejects are simply not targets.
 */
export function actionableTargets(
  current: Selection,
  clickedId: string,
  isActionable: (id: string) => boolean,
): { ids: string[]; bulk: boolean } {
  const ids = actionTargets(current, clickedId).filter(isActionable)
  return { ids, bulk: ids.length > 1 }
}

/**
 * Should this row render as part of a multi-selection?
 *
 * Keyed off the same actionable count as `actionableTargets`, so a row never
 * looks selected for an action that would skip it.
 */
export function isRowInBulkSelection(
  current: Selection,
  rowId: string,
  isActionable: (id: string) => boolean,
): boolean {
  if (!current.ids.includes(rowId)) return false
  return current.ids.filter(isActionable).length > 1
}
