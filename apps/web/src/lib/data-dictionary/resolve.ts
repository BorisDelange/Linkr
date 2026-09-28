/**
 * Resolving a concept set's expression against the workspace vocabulary library:
 * the included items, plus their descendants (`concept_ancestor`) when
 * `includeDescendants`, plus the concepts they map to (`concept_relationship`
 * Maps to / Mapped from) when `includeMapped`, minus the same for the excluded
 * items. As the INDICATE data dictionary resolves them (resolve.py): "mapped"
 * applies to the item itself, not to its descendants.
 */
import type { ConceptSet, ConceptSetItem, ResolvedConcept } from '@/types'
import { queryDataSourceAll } from '@/lib/duckdb/engine'

/** Ids from here up are local custom concepts: they have no vocabulary row, so
 *  they resolve to themselves (INDICATE's custom vocabulary). */
const CUSTOM_CONCEPT_ID_MIN = 2_100_000_000

function itemRows(items: readonly ConceptSetItem[]): string {
  return items
    .filter((i) => Number.isFinite(Number(i.concept?.conceptId)))
    .map((i) => `(${Number(i.concept.conceptId)}, ${i.isExcluded ? 'TRUE' : 'FALSE'}, ${i.includeDescendants ? 'TRUE' : 'FALSE'}, ${i.includeMapped ? 'TRUE' : 'FALSE'})`)
    .join(', ')
}

/**
 * The SQL listing a set's resolved concept ids. `tables` is what the library
 * holds: without `concept_ancestor` (or `concept_relationship`) the descendants
 * (or mapped concepts) cannot be expanded and are left out rather than failing.
 * Null when the expression has no item.
 */
export function resolutionSql(items: readonly ConceptSetItem[], tables: ReadonlySet<string>): string | null {
  const rows = itemRows(items)
  if (!rows) return null
  const expand = (excluded: boolean) => {
    const flag = excluded ? 'i.excluded' : 'NOT i.excluded'
    const parts = [`SELECT i.concept_id FROM items i WHERE ${flag}`]
    if (tables.has('concept_ancestor')) {
      parts.push(`SELECT ca.descendant_concept_id FROM concept_ancestor ca JOIN items i ON ca.ancestor_concept_id = i.concept_id WHERE ${flag} AND i.descendants`)
    }
    if (tables.has('concept_relationship')) {
      parts.push(`SELECT cr.concept_id_2 FROM concept_relationship cr JOIN items i ON cr.concept_id_1 = i.concept_id WHERE ${flag} AND i.mapped AND cr.relationship_id IN ('Maps to', 'Mapped from')`)
    }
    return parts.join(' UNION ')
  }
  return `WITH items(concept_id, excluded, descendants, mapped) AS (VALUES ${rows}), `
    + `included AS (${expand(false)}), excluded AS (${expand(true)}) `
    + 'SELECT DISTINCT concept_id FROM included WHERE concept_id NOT IN (SELECT concept_id FROM excluded) ORDER BY concept_id'
}

/** Resolve one set against a vocabulary database. */
export async function resolveConceptSet(set: ConceptSet, vocabularyDataSourceId: string, tables: ReadonlySet<string>): Promise<number[]> {
  const sql = resolutionSql(set.expression.items, tables)
  if (!sql) return []
  const rows = await queryDataSourceAll(vocabularyDataSourceId, sql)
  return rows.map((r) => Number(r.concept_id)).filter(Number.isFinite)
}

/** Details of resolved concepts. A custom concept (no vocabulary row) takes
 *  them from the set's own expression. */
export async function resolvedConceptDetails(set: ConceptSet, ids: readonly number[], vocabularyDataSourceId: string): Promise<ResolvedConcept[]> {
  const byId = new Map<number, ResolvedConcept>()
  const standard = ids.filter((id) => id < CUSTOM_CONCEPT_ID_MIN)
  for (let i = 0; i < standard.length; i += 1000) {
    const chunk = standard.slice(i, i + 1000)
    const rows = await queryDataSourceAll(vocabularyDataSourceId,
      'SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id, concept_code, standard_concept '
      + `FROM concept WHERE concept_id IN (${chunk.join(', ')})`)
    for (const r of rows) {
      byId.set(Number(r.concept_id), {
        conceptId: Number(r.concept_id),
        conceptName: String(r.concept_name ?? ''),
        vocabularyId: String(r.vocabulary_id ?? ''),
        domainId: String(r.domain_id ?? ''),
        conceptClassId: String(r.concept_class_id ?? ''),
        conceptCode: String(r.concept_code ?? ''),
        standardConcept: r.standard_concept != null && r.standard_concept !== '' ? String(r.standard_concept) : null,
      })
    }
  }
  for (const item of set.expression.items) {
    const c = item.concept
    const id = Number(c?.conceptId)
    if (!byId.has(id) && ids.includes(id)) {
      byId.set(id, {
        conceptId: id,
        conceptName: c.conceptName ?? '',
        vocabularyId: c.vocabularyId ?? '',
        domainId: c.domainId ?? '',
        conceptClassId: c.conceptClassId ?? '',
        conceptCode: c.conceptCode ?? '',
        standardConcept: c.standardConcept ?? null,
      })
    }
  }
  return ids.map((id) => byId.get(id)).filter((c): c is ResolvedConcept => !!c)
}
