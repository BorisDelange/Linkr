/**
 * Allocation cursor arithmetic for source-concept-id ranges, plus the parsing
 * and formatting the range inputs need.
 *
 * A range hands out ids from `rangeStart` upwards, tracking how far it has got
 * in `nextId`. The cursor is stored alongside the bounds, so the two can fall
 * out of step - editing a range moves the bounds, and a cursor left behind
 * points outside them.
 */

/**
 * OMOP reserves the ids from 2 billion up for locally-defined concepts, and the
 * band ends at the 32-bit signed maximum.
 *
 * The lower bound is inclusive: 2 000 000 000 itself is ours to hand out. The
 * SQL the ETL generates filters local concepts with `>= SOURCE_CONCEPT_ID_BASE`
 * accordingly — a strict `>` there would drop this one id on the floor.
 */
export const OMOP_CUSTOM_MIN = 2_000_000_000
export const OMOP_CUSTOM_MAX = 2_147_483_647

/**
 * Read a range bound the user typed.
 *
 * Digit-group separators are stripped, so a value pasted back from the display
 * ("2 002 000 001", and the non-breaking and narrow spaces `toLocaleString`
 * actually emits) round-trips. Anything else - a letter, a stray sign - is
 * rejected rather than silently parsed to a prefix, which is what `parseInt`
 * would do with "2e9" or "12abc".
 */
export function parseRangeBound(input: string): number | null {
  const stripped = input.replace(/[\s\u00a0\u202f\u2009,._']/g, '')
  if (!/^\d+$/.test(stripped)) return null
  const n = Number(stripped)
  return Number.isSafeInteger(n) ? n : null
}

/** Group digits in threes for display, so billions read apart from millions. */
export function formatRangeBound(value: number | string): string {
  const digits = String(value).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * How many ids a range holds, bounds inclusive. `null` when the bounds are not
 * yet a usable range - the caller shows nothing rather than a negative count.
 */
export function rangeCapacity(start: number | null, end: number | null): number | null {
  if (start == null || end == null) return null
  if (end < start) return null
  return end - start + 1
}

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
