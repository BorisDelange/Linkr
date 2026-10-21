/**
 * The IDE's tabs — scripts, terminals and outputs — share one order, so any tab
 * can sit beside any other within a panel, whatever kind it is and whichever
 * panel it came from. A panel shows its own tabs in that order; a tab the order
 * does not know yet (just opened) goes after the ones it does, in arrival order.
 */

/** `ids` (one panel's tabs, in arrival order) sorted by the shared `order`. */
export function orderTabs(ids: string[], order: string[]): string[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return ids
    .map((id, arrival) => ({ id, arrival, rank: rank.get(id) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.rank - b.rank || a.arrival - b.arrival)
    .map((x) => x.id)
}

/**
 * The shared order with `dragged` dropped beside `target`. `tabs` lists every
 * open tab in display order (one panel after the other); the result becomes the
 * new shared order, so tabs nobody moved keep their places.
 */
export function placeTab(tabs: string[], dragged: string, target: string, side: 'left' | 'right'): string[] {
  if (dragged === target) return tabs
  const rest = tabs.filter((id) => id !== dragged)
  const at = rest.indexOf(target)
  if (at === -1) return tabs
  rest.splice(side === 'right' ? at + 1 : at, 0, dragged)
  return rest
}
