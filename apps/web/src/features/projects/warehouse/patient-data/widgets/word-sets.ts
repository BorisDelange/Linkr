/**
 * Word sets: named groups of words the Notes widget highlights in a document.
 *
 * A set is applied or not applied as a whole — the words inside it are not
 * individually toggleable — so a clinician turns on "sepsis" and gets every
 * term that matters for it, rather than ticking eight words one by one.
 *
 * Nothing here touches the DOM or the store; it is the arithmetic the widget,
 * its popover and its editor all share.
 */

/** A named group of words, highlighted together in one colour. */
export interface WordSet {
  /**
   * Stable across renames and reordering, so the set stays applied while it is
   * being edited. Sets saved before ids existed are keyed by label instead.
   */
  id: string
  label: string
  words: string[]
}

/** A set as it was stored before sets carried ids. */
interface LegacyWordSet {
  label: string
  words: string[]
}

/**
 * Read the sets out of a widget's config.
 *
 * Sets predate their own ids, so a stored set may have none. Rather than
 * migrate the config on read — which would write to the store from a render —
 * the label stands in as the id: it was already the only thing identifying a
 * set, and it is unique in practice. A later edit saves a real id.
 */
export function readWordSets(stored: unknown): WordSet[] {
  if (!Array.isArray(stored)) return []
  const out: WordSet[] = []
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue
    const set = raw as Partial<WordSet> & LegacyWordSet
    if (typeof set.label !== 'string') continue
    const words = Array.isArray(set.words) ? set.words.filter((w) => typeof w === 'string' && w.trim()) : []
    out.push({
      id: typeof set.id === 'string' && set.id ? set.id : `label:${set.label}`,
      label: set.label,
      words,
    })
  }
  return out
}

/**
 * Add a word to a set, or report why it cannot be added.
 *
 * Case-insensitive: highlighting is case-insensitive too, so "Sepsis" and
 * "sepsis" would be the same chip twice and the same match once.
 */
export function addWord(words: string[], word: string): string[] {
  const trimmed = word.trim()
  if (!trimmed) return words
  if (hasWord(words, trimmed)) return words
  return [...words, trimmed]
}

export function hasWord(words: string[], word: string): boolean {
  const lower = word.trim().toLowerCase()
  return words.some((w) => w.toLowerCase() === lower)
}

export function removeWord(words: string[], word: string): string[] {
  const lower = word.toLowerCase()
  return words.filter((w) => w.toLowerCase() !== lower)
}

/** Rename a word in place, keeping its position so the chips do not jump. */
export function renameWord(words: string[], from: string, to: string): string[] {
  const trimmed = to.trim()
  if (!trimmed) return words
  const lowerFrom = from.toLowerCase()
  // Renaming onto a word already in the set would duplicate it; drop the
  // original instead, which is what the user asked for either way.
  if (hasWord(removeWord(words, from), trimmed)) return removeWord(words, from)
  return words.map((w) => (w.toLowerCase() === lowerFrom ? trimmed : w))
}

/**
 * The applied sets, given the ids the widget has switched on.
 *
 * Ids that no longer match a set are dropped rather than kept: a set deleted
 * from the editor must stop highlighting, and a stale id would otherwise sit in
 * the config for ever.
 */
export function appliedSets(sets: WordSet[], appliedIds: readonly string[]): WordSet[] {
  const wanted = new Set(appliedIds)
  return sets.filter((s) => wanted.has(s.id))
}

/** One word to highlight, and the set whose colour it takes. */
export interface HighlightWord {
  word: string
  setIndex: number
}

/**
 * Every word to highlight, from the applied sets.
 *
 * `setIndex` is the set's position in the FULL list, not among the applied
 * ones, so a set keeps its colour whether or not its neighbours are applied.
 *
 * A word in two applied sets takes the first one's colour: it can only be
 * painted once, and the alternative — dropping it — would leave a word the user
 * explicitly asked for unhighlighted.
 */
export function highlightWords(sets: WordSet[], appliedIds: readonly string[]): HighlightWord[] {
  const wanted = new Set(appliedIds)
  const out: HighlightWord[] = []
  const seen = new Set<string>()
  sets.forEach((set, setIndex) => {
    if (!wanted.has(set.id)) return
    for (const word of set.words) {
      const lower = word.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push({ word, setIndex })
    }
  })
  return out
}

/** Toggle a whole set on or off, which is the only granularity offered. */
export function toggleSet(appliedIds: readonly string[], id: string): string[] {
  return appliedIds.includes(id) ? appliedIds.filter((x) => x !== id) : [...appliedIds, id]
}

/**
 * Whether a label is free to use.
 *
 * Sets are told apart by their label in the popover, so two called "sepsis"
 * would be indistinguishable there even though their ids differ.
 */
export function labelTaken(sets: WordSet[], label: string, exceptId?: string): boolean {
  const lower = label.trim().toLowerCase()
  if (!lower) return false
  return sets.some((s) => s.id !== exceptId && s.label.trim().toLowerCase() === lower)
}
