/** Pure helpers for concept sets (workspace dictionaries) and concept lists (project picks). */
import type { ConceptListItem, ConceptSet } from '@/types'

export interface ItemInput {
  concept_id: number | string
  name?: string
  vocabulary?: string
  code?: string
}

/** Model-written items as stored list items, with every bad id reported at once. */
export function toListItems(input: ItemInput[]): { items: ConceptListItem[]; errors: string[] } {
  const items: ConceptListItem[] = []
  const errors: string[] = []
  const seen = new Set<number>()
  input.forEach((it, i) => {
    const id = Number(it.concept_id)
    if (!Number.isInteger(id)) {
      errors.push(`items[${i}]: concept_id must be an integer, got ${JSON.stringify(it.concept_id)}.`)
      return
    }
    if (seen.has(id)) return
    seen.add(id)
    items.push({
      conceptId: id,
      ...(it.name ? { conceptName: it.name } : {}),
      ...(it.vocabulary ? { vocabularyId: it.vocabulary } : {}),
      ...(it.code ? { conceptCode: it.code } : {}),
    })
  })
  return { items, errors }
}

/** A list's items after adding some and removing others by id. */
export function editItems(current: ConceptListItem[], add: ConceptListItem[], removeIds: number[]): ConceptListItem[] {
  const removed = new Set(removeIds)
  const kept = current.filter((i) => !removed.has(i.conceptId))
  const have = new Set(kept.map((i) => i.conceptId))
  return [...kept, ...add.filter((i) => !have.has(i.conceptId))]
}

export function describeItems(items: ConceptListItem[], limit = 100): string {
  if (items.length === 0) return '  (empty)'
  const lines = items.slice(0, limit).map((i) =>
    `  ${i.conceptId}${i.conceptName ? ` ${i.conceptName}` : ''}${i.vocabularyId ? ` [${i.vocabularyId}${i.conceptCode ? ` ${i.conceptCode}` : ''}]` : ''}`)
  if (items.length > limit) lines.push(`  … ${items.length - limit} more`)
  return lines.join('\n')
}

/** A concept set's expression and resolution, as text. */
export function describeConceptSet(set: ConceptSet, limit = 100): string {
  const items = set.expression?.items ?? []
  const lines = [
    `Concept set "${set.name}" (concept_set_id ${set.id})${set.category ? ` — ${set.category}${set.subcategory ? ` / ${set.subcategory}` : ''}` : ''}`,
  ]
  if (set.description) lines.push(set.description)
  lines.push('', `Expression (${items.length} item(s)):`)
  for (const it of items.slice(0, limit)) {
    const flags = [it.isExcluded && 'EXCLUDED', it.includeDescendants && '+descendants', it.includeMapped && '+mapped'].filter(Boolean)
    lines.push(`  ${it.concept.conceptId} ${it.concept.conceptName} [${it.concept.vocabularyId} ${it.concept.conceptCode}]${flags.length ? ` ${flags.join(' ')}` : ''}`)
  }
  if (items.length > limit) lines.push(`  … ${items.length - limit} more`)
  if (set.resolvedConceptIds) {
    const ids = set.resolvedConceptIds
    lines.push('', `Resolved: ${ids.length} concept id(s) (descendants and mapped expanded) — use these in a concept criterion:`,
      `  ${ids.slice(0, 200).join(', ')}${ids.length > 200 ? `, … ${ids.length - 200} more` : ''}`)
  } else {
    lines.push('', 'Not resolved yet (descendants not expanded): only the expression ids above are known.')
  }
  return lines.join('\n')
}
