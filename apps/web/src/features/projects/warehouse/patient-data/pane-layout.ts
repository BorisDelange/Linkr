/**
 * Widths for the Patient data page's three panes: dashboard, patient sidebar,
 * collection panel — in that order, which is the order Allotment indexes them.
 *
 * A hidden panel is 0 wide, and the dashboard takes whatever is left, so it is the
 * pane that absorbs every change.
 */
export interface PaneLayoutInput {
  /** Width of the whole splitter. */
  total: number
  sidebarVisible: boolean
  collectionOpen: boolean
  sidebarWidth: number
  collectionWidth: number
}

export function paneSizes({
  total, sidebarVisible, collectionOpen, sidebarWidth, collectionWidth,
}: PaneLayoutInput): [number, number, number] {
  const sidebar = sidebarVisible ? sidebarWidth : 0
  const collection = collectionOpen ? collectionWidth : 0
  return [total - sidebar - collection, sidebar, collection]
}

/**
 * The layout after double-clicking one panel's border: that panel returns to
 * `defaultWidth`, the other keeps the width it has.
 *
 * Resetting one panel must not move the other — double-clicking the collection
 * panel's border should shrink the pair by returning the collection panel to its
 * default, leaving the patient sidebar exactly where it was.
 */
export function paneSizesAfterReset(
  input: PaneLayoutInput,
  target: 'sidebar' | 'collection',
  defaultWidth: number,
): [number, number, number] {
  return paneSizes({
    ...input,
    sidebarWidth: target === 'sidebar' ? defaultWidth : input.sidebarWidth,
    collectionWidth: target === 'collection' ? defaultWidth : input.collectionWidth,
  })
}
