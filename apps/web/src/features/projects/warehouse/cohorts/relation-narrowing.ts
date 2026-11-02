import type { Cohort, ConceptCriteriaConfig, CriteriaTreeNode, SchemaMapping } from '@/types'
import type { RelationNarrowing } from '@/lib/duckdb/cohort-query'
import { relationsHoldingConcepts } from '@/features/projects/warehouse/patient-data/timeline-relations'

/** The concept ids of each enabled concept criterion of the tree. */
export function criterionConceptIds(node: CriteriaTreeNode): number[][] {
  if (!node.enabled) return []
  if (node.kind === 'group') return node.children.flatMap(criterionConceptIds)
  if (node.type !== 'concept') return []
  const ids = ((node.config as ConceptCriteriaConfig).conceptIds ?? []).map(Number).filter(Number.isInteger)
  return ids.length > 0 ? [ids] : []
}

/**
 * Which of a criterion's concepts each relation holds, from the last concept
 * count, asked once for every concept of the cohort. Undefined when the count
 * cannot speak for any relation (no concept criterion, or a database it does
 * not cover).
 */
export async function cohortRelationNarrowing(
  sourceId: string,
  mapping: SchemaMapping,
  cohort: Pick<Cohort, 'criteriaTree'>,
): Promise<RelationNarrowing | undefined> {
  const ids = [...new Set(criterionConceptIds(cohort.criteriaTree).flat())]
  if (ids.length === 0) return undefined
  const holding = await relationsHoldingConcepts(sourceId, mapping, ids)
  if (holding.size === 0) return undefined
  return (asked) => new Map([...holding].map(([relation, held]) => [relation, asked.filter((id) => held.has(id))]))
}
