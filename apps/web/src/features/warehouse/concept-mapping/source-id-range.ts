/**
 * Allocation cursor arithmetic for source-concept-id ranges.
 *
 * A range hands out ids from `rangeStart` upwards, tracking how far it has got
 * in `nextId`. The cursor is stored alongside the bounds, so the two can fall
 * out of step - editing a range moves the bounds, and a cursor left behind
 * points outside them.
 */

/**
 * Keep the allocation cursor inside its range.
 *
 * A cursor below the start is the dangerous case: the assignment loop only
 * checks `nextId > rangeEnd`, so a low cursor passes every guard and quietly
 * hands out ids from outside the range - the assignment reports success while
 * each id lands in another band. Below the start it snaps to the start.
 *
 * Past the end it is left past the end: that is how an exhausted range is
 * represented, and clamping it back down would re-issue ids already taken.
 */
export function clampNextId(nextId: number, start: number, end: number): number {
  if (!Number.isFinite(nextId) || nextId < start) return start
  return Math.min(nextId, end + 1)
}
