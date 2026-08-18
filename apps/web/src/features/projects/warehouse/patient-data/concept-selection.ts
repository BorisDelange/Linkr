/**
 * Ordered concept selection for the patient-widget picker.
 *
 * Order is a contract, not a presentation detail: the chart colours each concept
 * by its POSITION in the selection (`defaultConceptColorName(index)`), so a
 * re-ordering silently recolours every series. Both helpers below therefore keep
 * already-picked ids at their existing index and only ever append.
 */

/**
 * Fold a Set-shaped selection (what the table emits) back onto the ordered
 * array, preserving the position of ids that survive and appending new ones.
 *
 * Returns the SAME array reference when nothing changed, so React state updates
 * and memo dependencies don't churn on every click.
 */
export function mergeSelection(previous: number[], next: Set<number>): number[] {
  const kept = previous.filter((id) => next.has(id))
  const previousSet = new Set(previous)
  const added = [...next].filter((id) => !previousSet.has(id))
  if (added.length === 0 && kept.length === previous.length) return previous
  return [...kept, ...added]
}

/**
 * Add a concept list's ids to the current selection: additive and de-duplicated,
 * appended in list order. Importing never drops or reorders an existing pick.
 */
export function appendListConcepts(previous: number[], listConceptIds: number[]): number[] {
  const seen = new Set(previous)
  const additions: number[] = []
  for (const id of listConceptIds) {
    if (seen.has(id)) continue
    seen.add(id)
    additions.push(id)
  }
  return additions.length === 0 ? previous : [...previous, ...additions]
}
