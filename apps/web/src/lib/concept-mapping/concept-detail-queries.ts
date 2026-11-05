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

// The counts join the concept table like the graph queries do: concept_ancestor
// can name concepts of a vocabulary that is not imported (an ATC class lists its
// RxNorm descendants), and the graph never shows those — so neither does the count.
export function buildConceptAncestorCountQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT COUNT(DISTINCT ca.ancestor_concept_id) AS cnt
FROM concept_ancestor ca
JOIN ${conceptTable} c ON c.concept_id = ca.ancestor_concept_id
WHERE ca.descendant_concept_id = ${conceptId}
  AND ca.ancestor_concept_id != ${conceptId}
  AND ca.min_levels_of_separation <= ${MAX_DEPTH}
`
}

export function buildConceptDescendantCountQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT COUNT(DISTINCT ca.descendant_concept_id) AS cnt
FROM concept_ancestor ca
JOIN ${conceptTable} c ON c.concept_id = ca.descendant_concept_id
WHERE ca.ancestor_concept_id = ${conceptId}
  AND ca.descendant_concept_id != ${conceptId}
  AND ca.min_levels_of_separation <= ${MAX_DEPTH}
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

/**
 * A drug's ingredients with their strength (OMOP `drug_strength`): an amount
 * (500 mg per tablet) or a concentration (numerator per denominator; a missing
 * denominator value means per one unit). Units are their UCUM codes.
 */
export function buildDrugStrengthQuery(conceptId: number, conceptTable: string): string {
  return `
SELECT
  ds.ingredient_concept_id,
  i.concept_name AS ingredient_name,
  ds.amount_value,
  au.concept_code AS amount_unit,
  ds.numerator_value,
  nu.concept_code AS numerator_unit,
  ds.denominator_value,
  du.concept_code AS denominator_unit,
  ds.box_size
FROM drug_strength ds
LEFT JOIN ${conceptTable} i ON i.concept_id = ds.ingredient_concept_id
LEFT JOIN ${conceptTable} au ON au.concept_id = ds.amount_unit_concept_id
LEFT JOIN ${conceptTable} nu ON nu.concept_id = ds.numerator_unit_concept_id
LEFT JOIN ${conceptTable} du ON du.concept_id = ds.denominator_unit_concept_id
WHERE ds.drug_concept_id = ${conceptId}
  AND ds.invalid_reason IS NULL
ORDER BY i.concept_name
`
}
