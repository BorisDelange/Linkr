/**
 * Lightweight pub/sub so synced timelines in the same tab share a visible
 * date window. A timeline that pans/zooms broadcasts its [min, max] range;
 * other synced timelines apply it without re-broadcasting (the `source` id
 * guards against feedback loops).
 *
 * Scoped per tab so timelines in different tabs never sync with each other.
 */

export interface TimelineRange {
  min: number
  max: number | null
}

type Listener = (range: TimelineRange | null, sourceId: string) => void

const channels = new Map<string, Set<Listener>>()
const lastRange = new Map<string, TimelineRange | null>()

export function subscribeTimelineSync(tabId: string, listener: Listener): () => void {
  let set = channels.get(tabId)
  if (!set) {
    set = new Set()
    channels.set(tabId, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) {
      channels.delete(tabId)
      lastRange.delete(tabId)
    }
  }
}

export function broadcastTimelineRange(
  tabId: string,
  sourceId: string,
  range: TimelineRange | null,
): void {
  lastRange.set(tabId, range)
  const set = channels.get(tabId)
  if (!set) return
  for (const listener of set) listener(range, sourceId)
}

/** Current shared window for a tab, so a timeline that turns on sync can adopt it. */
export function getTimelineRange(tabId: string): TimelineRange | null {
  return lastRange.get(tabId) ?? null
}
