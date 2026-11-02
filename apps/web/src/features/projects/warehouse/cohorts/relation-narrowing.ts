import type { Cohort, ConceptCriteriaConfig, CriteriaTreeNode, SchemaMapping } from '@/types'
import type { RelationNarrowing } from '@/lib/duckdb/cohort-query'
import { relationsWithoutConcepts } from '@/features/projects/warehouse/patient-data/timeline-relations'

/** The concept ids of each enabled concept criterion of the tree. */
export function criterionConceptIds(node: CriteriaTreeNode): number[][] {
  if (!node.enabled) return []
  if (node.kind === 'group') return node.children.flatMap(criterionConceptIds)
  if (node.type !== 'concept') return []
  const ids = ((node.config as ConceptCriteriaConfig).conceptIds ?? []).map(Number).filter(Number.isInteger)
  return ids.length > 0 ? [ids] : []
}

/**
 * The relations each concept criterion of the cohort can leave out, asked of the
 * last concept count once per criterion. A criterion's "every concept" form asks
 * about one id at a time: a relation holding none of the criterion's ids holds
 * none of any one of them. Undefined when nothing can be left out (no concept
 * criterion, or a database the count cannot speak for).
 */
export async function cohortRelationNarrowing(
  sourceId: string,
  mapping: SchemaMapping,
  cohort: Pick<Cohort, 'criteriaTree'>,
): Promise<RelationNarrowing | undefined> {
  const sets = criterionConceptIds(cohort.criteriaTree)
  if (sets.length === 0) return undefined
  const known = await Promise.all(sets.map(async (ids) => ({
    ids: new Set(ids),
    without: await relationsWithoutConcepts(sourceId, mapping, ids),
  })))
  if (known.every((k) => k.without.size === 0)) return undefined
  return (ids) => {
    const out = new Set<string>()
    for (const k of known) {
      if (ids.every((id) => k.ids.has(id))) for (const r of k.without) out.add(r)
    }
    return out
  }
}
