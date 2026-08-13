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
 * A cursor outside the bounds is always stale rather than meaningful, because
 * the bounds can be edited under it and the cursor is not rewritten:
 *
 * - Below the start it is actively harmful. The assignment loop's only guard is
 *   `nextId > rangeEnd`, so a low cursor passes every check and quietly hands
 *   out ids from outside the range - assignment reports success while each id
 *   lands in another badge's band.
 * - Above the end it reads as "exhausted" and blocks assignment entirely, even
 *   for a range that has never allocated anything.
 *
 * Neither can be resolved from the cursor alone, so `highestAssigned` - the
 * largest id actually handed out from this range, or null if none - is the
 * authority. A range with nothing assigned restarts at its start; one with
 * entries resumes just past its highest, which is where the next free id is.
 * Only that genuinely reaching past `end` means exhausted.
 */
export function clampNextId(
  nextId: number,
  start: number,
  end: number,
  highestAssigned: number | null = null,
): number {
  // What the entries prove has been used wins over a cursor that may predate
  // the current bounds.
  if (highestAssigned != null && highestAssigned >= start && highestAssigned <= end) {
    const resumeAt = highestAssigned + 1
    // A cursor further along is still trusted: ids can be assigned from this
    // range and later deleted, leaving the high-water mark behind the cursor.
    if (Number.isFinite(nextId) && nextId > resumeAt && nextId <= end + 1) return nextId
    return resumeAt
  }
  // Nothing assigned from this range: any out-of-bounds cursor is stale, and
  // "exhausted" would be a contradiction.
  if (highestAssigned == null) {
    if (!Number.isFinite(nextId) || nextId < start || nextId > end) return start
    return nextId
  }
  if (!Number.isFinite(nextId) || nextId < start) return start
  return Math.min(nextId, end + 1)
}
