import type { Cohort, ConceptCriteriaConfig, CriteriaTreeNode, SchemaMapping } from '@/types'
import { fetchConceptInfo } from '@/features/projects/warehouse/concepts/concept-info'
import { criterionConceptIds } from './relation-narrowing'

type Label = { vocabulary?: string; name?: string }

function withLabels(node: CriteriaTreeNode, labels: Map<number, Label>): CriteriaTreeNode {
  if (node.kind === 'group') return { ...node, children: node.children.map((c) => withLabels(c, labels)) }
  if (node.type !== 'concept') return node
  const config = node.config as ConceptCriteriaConfig
  const names = { ...config.conceptNames }
  const vocabularies = { ...config.conceptVocabularies }
  for (const id of config.conceptIds ?? []) {
    const label = labels.get(Number(id))
    if (label?.name) names[id] = label.name
    if (label?.vocabulary) vocabularies[id] = label.vocabulary
  }
  return { ...node, config: { ...config, conceptNames: names, conceptVocabularies: vocabularies } }
}

/** Each concept's vocabulary and name, as the database's concepts give them;
 *  a concept that cannot be read is absent. */
export async function fetchConceptLabels(sourceId: string, mapping: SchemaMapping, ids: readonly number[]): Promise<Map<number, Label>> {
  const rows = await Promise.all(ids.map((id) => fetchConceptInfo(sourceId, mapping, id)))
  const labels = new Map<number, Label>()
  ids.forEach((id, i) => {
    const row = rows[i]
    if (!row) return
    labels.set(id, {
      vocabulary: row.vocabulary_id == null ? undefined : String(row.vocabulary_id),
      name: row.concept_name == null ? undefined : String(row.concept_name),
    })
  })
  return labels
}

/** `vocabulary - name` of a concept, what generated SQL writes after its id. */
export function conceptLabelOf(labels: ReadonlyMap<number, Label>): (id: number) => string | undefined {
  return (id) => {
    const label = labels.get(id)
    const parts = [label?.vocabulary, label?.name].filter(Boolean)
    return parts.length ? parts.join(' - ') : undefined
  }
}

/**
 * The cohort with each concept of its criteria named as the database's concepts
 * name it, vocabulary included: what the SQL tab writes after each id. A concept
 * that cannot be read keeps the name the criterion saved.
 */
export async function labelCohortConcepts(sourceId: string, mapping: SchemaMapping, cohort: Cohort): Promise<Cohort> {
  const ids = [...new Set(criterionConceptIds(cohort.criteriaTree).flat())]
  if (ids.length === 0) return cohort
  const labels = await fetchConceptLabels(sourceId, mapping, ids)
  return { ...cohort, criteriaTree: withLabels(cohort.criteriaTree, labels) as Cohort['criteriaTree'] }
}
