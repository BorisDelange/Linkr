import type { KeyboardEvent } from 'react'

/**
 * Enter in a dropdown's search box: what it does is shared by every searchable
 * dropdown, so the single-choice and multi-choice lists answer it the same way.
 *
 * Nothing happens while the search is empty: Enter then has no matches to act
 * on, only the whole list, and taking its first row or every row would be a
 * surprise rather than a shortcut.
 */
export function isSearchEnter(e: KeyboardEvent): boolean {
  // During an IME composition Enter confirms the composed characters.
  return e.key === 'Enter' && !e.nativeEvent.isComposing
}

/** Single choice: the first match, or `undefined` when there is nothing to pick. */
export function firstMatchOnEnter<T>(query: string, matches: readonly T[]): T | undefined {
  if (!query.trim()) return undefined
  return matches[0]
}

/**
 * Multi choice: the current selection plus every match, in that order. `null`
 * when the search is empty; the selection itself (same array) when every match
 * is already in it.
 */
export function selectMatchesOnEnter(
  query: string,
  selected: readonly string[],
  matches: readonly string[],
): readonly string[] | null {
  if (!query.trim()) return null
  const merged = new Set(selected)
  for (const v of matches) merged.add(v)
  return merged.size === selected.length ? selected : [...merged]
}
