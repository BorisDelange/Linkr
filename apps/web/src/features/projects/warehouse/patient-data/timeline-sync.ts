/**
 * Lightweight pub/sub so synced timelines share a visible date window. A
 * timeline that pans/zooms broadcasts its [min, max] range; other synced
 * timelines apply it without re-broadcasting (the `source` id guards against
 * feedback loops).
 *
 * Which timelines hear each other is decided by the channel they subscribe to —
 * see `syncChannel`.
 */

export interface TimelineRange {
  min: number
  max: number | null
}

type Listener = (range: TimelineRange | null, sourceId: string) => void

const channels = new Map<string, Set<Listener>>()
const lastRange = new Map<string, TimelineRange | null>()

/**
 * The channel a timeline syncs on.
 *
 * Per tab by default, so timelines in different tabs never drag each other
 * around. When the board turns on cross-tab sync, every tab of that board
 * shares one channel instead — switching tab then lands on the same window
 * rather than on whatever that tab was left at.
 *
 * Keyed by the board rather than globally: two boards open on two patients must
 * not share a window, since their records cover different dates entirely.
 */
export function syncChannel(
  tabId: string,
  boardId: string | undefined,
  syncAcrossTabs: boolean | undefined,
): string {
  return syncAcrossTabs && boardId ? `board:${boardId}` : `tab:${tabId}`
}

export function subscribeTimelineSync(channel: string, listener: Listener): () => void {
  let set = channels.get(channel)
  if (!set) {
    set = new Set()
    channels.set(channel, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    // The remembered range deliberately OUTLIVES the last listener. With
    // reload-on-tab-switch on, leaving a tab unmounts every timeline it holds;
    // dropping the range there would mean the tab being switched to finds
    // nothing to adopt, and cross-tab sync would do nothing in exactly the
    // configuration it exists for. Cleared by `forgetTimelineRange` instead.
    if (set && set.size === 0) channels.delete(channel)
  }
}

/**
 * Drop a channel's remembered window.
 *
 * Called when a board is left for good — the next patient's record covers
 * different dates entirely, so adopting the old window would open every
 * timeline on empty space.
 */
export function forgetTimelineRange(channel: string): void {
  lastRange.delete(channel)
}

export function broadcastTimelineRange(
  channel: string,
  sourceId: string,
  range: TimelineRange | null,
): void {
  lastRange.set(channel, range)
  const set = channels.get(channel)
  if (!set) return
  for (const listener of set) listener(range, sourceId)
}

/** Current shared window, so a timeline that turns on sync can adopt it. */
export function getTimelineRange(channel: string): TimelineRange | null {
  return lastRange.get(channel) ?? null
}
