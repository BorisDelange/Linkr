const MAX_DEPTH = 8

export function buildConceptRelationsQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT
  cr.relationship_id,
  c.concept_id,
  c.concept_name,
  c.vocabulary_id,
  c.domain_id,
  c.concept_class_id,
  c.concept_code,
  c.standard_concept
FROM concept_relationship cr
JOIN ${conceptTable} c ON c.concept_id = cr.concept_id_2
WHERE cr.concept_id_1 = ${conceptId}
  AND cr.invalid_reason IS NULL
ORDER BY cr.relationship_id, c.concept_name
`
}

export function buildConceptAncestorsQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT DISTINCT
  c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id, c.concept_class_id, c.concept_code, c.standard_concept, c.invalid_reason,
  -MIN(ca.min_levels_of_separation) AS hierarchy_level
FROM concept_ancestor ca
JOIN ${conceptTable} c ON c.concept_id = ca.ancestor_concept_id
WHERE ca.descendant_concept_id = ${conceptId}
  AND ca.ancestor_concept_id != ${conceptId}
  AND ca.min_levels_of_separation <= ${MAX_DEPTH}
GROUP BY c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id, c.concept_class_id, c.concept_code, c.standard_concept, c.invalid_reason
ORDER BY MIN(ca.min_levels_of_separation)
`
}

export function buildConceptDescendantsQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT DISTINCT
  c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id, c.concept_class_id, c.concept_code, c.standard_concept, c.invalid_reason,
  MIN(ca.min_levels_of_separation) AS hierarchy_level
FROM concept_ancestor ca
JOIN ${conceptTable} c ON c.concept_id = ca.descendant_concept_id
WHERE ca.ancestor_concept_id = ${conceptId}
  AND ca.descendant_concept_id != ${conceptId}
  AND ca.min_levels_of_separation <= ${MAX_DEPTH}
GROUP BY c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id, c.concept_class_id, c.concept_code, c.standard_concept, c.invalid_reason
ORDER BY MIN(ca.min_levels_of_separation)
`
}

export function buildConceptEdgesQuery(allIds: number[]): string {
  const idList = allIds.join(',')
  return `
SELECT DISTINCT ancestor_concept_id AS from_id, descendant_concept_id AS to_id
FROM concept_ancestor
WHERE ancestor_concept_id IN (${idList})
  AND descendant_concept_id IN (${idList})
  AND ancestor_concept_id != descendant_concept_id
  AND min_levels_of_separation = 1
`
}

export function buildConceptAncestorCountQuery(conceptId: number): string {
  return `
SELECT COUNT(DISTINCT ancestor_concept_id) AS cnt
FROM concept_ancestor
WHERE descendant_concept_id = ${conceptId}
  AND ancestor_concept_id != ${conceptId}
  AND min_levels_of_separation <= ${MAX_DEPTH}
`
}

export function buildConceptDescendantCountQuery(conceptId: number): string {
  return `
SELECT COUNT(DISTINCT descendant_concept_id) AS cnt
FROM concept_ancestor
WHERE ancestor_concept_id = ${conceptId}
  AND descendant_concept_id != ${conceptId}
  AND min_levels_of_separation <= ${MAX_DEPTH}
`
}

export function buildConceptSelfQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id, concept_code, standard_concept, invalid_reason
FROM ${conceptTable}
WHERE concept_id = ${conceptId}
`
}

export function buildConceptSynonymsQuery(conceptId: number): string {
  return `
SELECT
  cs.concept_synonym_name,
  c.concept_name AS language_name
FROM concept_synonym cs
LEFT JOIN concept c ON c.concept_id = cs.language_concept_id
WHERE cs.concept_id = ${conceptId}
ORDER BY c.concept_name, cs.concept_synonym_name
`
}
