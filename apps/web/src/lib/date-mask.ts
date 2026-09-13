/**
 * A guided date input: the user types digits, the mask supplies the rest.
 *
 * The field takes ONE shape per language — `YYYY-MM-DD` in English (ISO, which is
 * also how `formatDate` prints it) and `DD/MM/YYYY` in French — so a typed date can
 * never be ambiguous the way a free-form one is: `01/04/2026` means two different
 * days to two readers, and no amount of parsing settles it. Fixing the shape and
 * showing it as a placeholder settles it before anything is typed.
 *
 * Separators are never typed. They appear as soon as the group before them is full
 * and disappear with it, so the caret only ever moves over digits.
 */

export interface DateMask {
  /** Segment widths in typing order. */
  readonly groups: readonly [number, number, number]
  /** The character between groups. */
  readonly sep: string
  /** Shown when the field is empty, and as the format hint. */
  readonly placeholder: string
  /** Where each part sits in `groups`. */
  readonly order: { y: 0 | 1 | 2; m: 0 | 1 | 2; d: 0 | 1 | 2 }
}

const ISO: DateMask = {
  groups: [4, 2, 2],
  sep: '-',
  placeholder: 'YYYY-MM-DD',
  order: { y: 0, m: 1, d: 2 },
}

const FR: DateMask = {
  groups: [2, 2, 4],
  sep: '/',
  placeholder: 'JJ/MM/AAAA',
  order: { d: 0, m: 1, y: 2 },
}

export function dateMaskFor(lang: string): DateMask {
  return lang.startsWith('fr') ? FR : ISO
}

/**
 * `HH:MM:SS`, the same guided mask applied to a time of day.
 *
 * The time half used to be a native `<input type="time">`, which carries a clock
 * button in its shadow DOM: it cannot be given `tabIndex={-1}` from script, so Tab
 * stopped on it instead of moving to the next field, and hiding it depends on a
 * vendor pseudo-element that not every engine exposes. A plain masked input has no
 * internal controls at all, and behaves exactly like the date beside it.
 *
 * One shape for every language: a 24-hour clock is written the same way
 * everywhere, so unlike a date it needs no per-locale ordering.
 */
export const TIME_MASK: DateMask = {
  groups: [2, 2, 2],
  sep: ':',
  placeholder: 'HH:MM:SS',
  // Unused for a time — `timeFromMasked` reads the groups positionally — but the
  // shape is shared, so the field has to be filled with something coherent.
  order: { y: 0, m: 1, d: 2 },
}

/**
 * `HH:MM:SS` for what has been typed so far, padding the parts left blank.
 *
 * A bare hour is a real answer: "21" means 21:00:00, which is what someone typing
 * an hour and tabbing away meant. Returns undefined only when nothing usable was
 * entered, or when a part is out of range — 25:00 is a typo, not a time.
 */
export function timeFromMasked(digits: string): string | undefined {
  if (digits.length === 0) return undefined
  const part = (i: number) => digits.slice(i * 2, i * 2 + 2)
  const h = Number(part(0))
  const m = part(1) === '' ? 0 : Number(part(1))
  const s = part(2) === '' ? 0 : Number(part(2))
  if (!Number.isInteger(h) || h > 23) return undefined
  if (!Number.isInteger(m) || m > 59) return undefined
  if (!Number.isInteger(s) || s > 59) return undefined
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}`
}

/** The mask's digits for an `HH:MM[:SS]` string, so a stored time can be edited. */
export function maskedFromTime(time: string | undefined): string {
  if (!time) return ''
  return time.split(':').map((p) => p.padStart(2, '0')).join('').slice(0, 6)
}

/** The digits of a string, capped at the 8 a date can hold. */
export function digitsOf(text: string): string {
  return text.replace(/\D/g, '').slice(0, 8)
}

/**
 * Read what the user typed, honouring separators they typed themselves.
 *
 * A typed separator ENDS the current group, so `1-2-2026` is the same date as
 * `01-02-2026`: the short group is zero-padded and the next one starts. Without
 * this a separator typed early was simply dropped, and the digits ran on into the
 * group before them — `1-2-2026` became `12-20-26`, a different date entered in
 * good faith.
 *
 * A separator typed exactly where the mask already put one changes nothing, which
 * is what makes typing the full `2026-01-04` work character by character.
 */
export function digitsFromTyped(text: string, mask: DateMask): string {
  // Split on anything that is not a digit, keeping empty runs out of the way.
  const parts = text.split(/[^\d]+/)
  if (parts.length <= 1) return digitsOf(text)

  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // An EMPTY chunk is a separator with nothing after it yet — the one just
    // pressed. It closes nothing and drops nothing.
    if (!part) continue
    // The group this chunk lands in, which is decided by how much is already laid
    // down rather than by the chunk's position: digits that overflow a group flow
    // into the next one, so nothing typed is ever discarded.
    let start = 0
    let g = 0
    while (g < mask.groups.length && start + mask.groups[g] <= out.length) {
      start += mask.groups[g]
      g++
    }
    const room = g < mask.groups.length ? start + mask.groups[g] - out.length : 0
    // A chunk followed by a separator is closed: it is zero-padded to fill its
    // group, so `2026-1-2` means the same as `2026-01-02`. The last chunk is still
    // being typed and is left exactly as it is.
    const closed = i < parts.length - 1 && parts.slice(i + 1).some(Boolean)
    out += closed && part.length < room ? part.padStart(room, '0') : part
  }
  return out.slice(0, 8)
}

/**
 * Lay digits out under the mask, inserting separators as groups fill.
 *
 * A full group KEEPS its trailing separator, so typing the separator yourself puts
 * it on screen rather than seeming to do nothing — and typing `/` where the mask
 * wants `-` shows the `-`, since the mask decides the character, not the keystroke.
 * The separator appears on the eighth digit of a group either way; backspace deletes
 * it together with the digit before it, which is what makes that safe.
 */
export function formatMasked(digits: string, mask: DateMask): string {
  let out = ''
  let at = 0
  for (let g = 0; g < mask.groups.length; g++) {
    const size = mask.groups[g]
    if (at >= digits.length) break
    if (out) out += mask.sep
    out += digits.slice(at, at + size)
    at += size
  }
  // Trailing separator once a group is complete and another one follows it.
  const groupsFilled = filledGroups(digits.length, mask)
  if (groupsFilled > 0 && groupsFilled < mask.groups.length && digits.length < 8) {
    out += mask.sep
  }
  return out
}

/** How many whole groups `count` digits fill, exactly. */
function filledGroups(count: number, mask: DateMask): number {
  let at = 0
  for (let g = 0; g < mask.groups.length; g++) {
    at += mask.groups[g]
    if (count === at) return g + 1
    if (count < at) return 0
  }
  return mask.groups.length
}

/** `YYYY-MM-DD` for a complete, real date; `undefined` while it is incomplete. */
export function isoFromMasked(digits: string, mask: DateMask): string | undefined {
  if (digits.length !== 8) return undefined
  const at = (i: 0 | 1 | 2) => {
    let start = 0
    for (let g = 0; g < i; g++) start += mask.groups[g]
    return digits.slice(start, start + mask.groups[i])
  }
  const y = Number(at(mask.order.y))
  const m = Number(at(mask.order.m))
  const d = Number(at(mask.order.d))
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return undefined
  // Round-trip through a real Date so an impossible day (31 February) is rejected
  // rather than silently rolling into the next month.
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return undefined
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** The mask's digits for an ISO day, so a stored value can be edited in place. */
export function maskedFromIso(iso: string | undefined, mask: DateMask): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return ''
  const parts: string[] = []
  parts[mask.order.y] = y
  parts[mask.order.m] = m
  parts[mask.order.d] = d
  return parts.join('')
}
