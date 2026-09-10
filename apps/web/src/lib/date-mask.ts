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
