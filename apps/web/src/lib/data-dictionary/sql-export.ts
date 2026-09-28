/**
 * OMOP CDM extraction SQL for a concept set, with its measurements converted to
 * one reference unit.
 *
 * A port of the INDICATE data dictionary's SQL export (`buildOMOPSQL` in
 * docs/concept-sets.js, and its Python twin core/sql_export.py): only standard
 * concepts, one query per domain on its CDM table, and for Measurement an affine
 * conversion `value * factor + offset` into the reference unit — flat when every
 * source unit has one factor, nested per concept when the factor depends on the
 * analyte (molecular weight). It must produce the same bytes: the golden files in
 * __fixtures__/sql-export/ were recorded from the JavaScript original.
 */
import type { RecommendedUnit, UnitConversion } from '@/types'

/** A resolved concept, as the export reads it. */
export interface SqlConcept {
  conceptId: number
  conceptName: string
  domainId?: string | null
  standardConcept?: string | null
}

export interface SqlHeader {
  name: string
  /** The set's id as its dictionary numbers it. */
  id: string | number
  version?: string | null
  permalink: string
  toolTag: string
  /** YYYY-MM-DD — injected, so the output is deterministic. */
  today: string
}

interface DomainTable {
  table: string
  conceptCol: string
  columns: readonly string[]
}

/** The CDM table each domain is read from (INDICATE core/data/domain_tables.json). */
export const DOMAIN_TABLES: Record<string, DomainTable> = {
  Measurement: {
    table: 'measurement',
    conceptCol: 'measurement_concept_id',
    columns: ['person_id', 'measurement_concept_id', 'measurement_date', 'measurement_datetime', 'value_as_number', 'value_as_concept_id', 'unit_concept_id', 'measurement_source_value', 'measurement_source_concept_id', 'unit_source_value'],
  },
  Condition: {
    table: 'condition_occurrence',
    conceptCol: 'condition_concept_id',
    columns: ['person_id', 'condition_concept_id', 'condition_start_date', 'condition_start_datetime', 'condition_end_date', 'condition_end_datetime', 'condition_type_concept_id', 'condition_source_value', 'condition_source_concept_id'],
  },
  Drug: {
    table: 'drug_exposure',
    conceptCol: 'drug_concept_id',
    columns: ['person_id', 'drug_concept_id', 'drug_exposure_start_date', 'drug_exposure_start_datetime', 'drug_exposure_end_date', 'drug_exposure_end_datetime', 'drug_type_concept_id', 'quantity', 'dose_unit_source_value', 'drug_source_value', 'drug_source_concept_id'],
  },
  Procedure: {
    table: 'procedure_occurrence',
    conceptCol: 'procedure_concept_id',
    columns: ['person_id', 'procedure_concept_id', 'procedure_date', 'procedure_datetime', 'procedure_type_concept_id', 'procedure_source_value', 'procedure_source_concept_id'],
  },
  Observation: {
    table: 'observation',
    conceptCol: 'observation_concept_id',
    columns: ['person_id', 'observation_concept_id', 'observation_date', 'observation_datetime', 'value_as_number', 'value_as_string', 'value_as_concept_id', 'unit_concept_id', 'observation_source_value', 'observation_source_concept_id'],
  },
  Device: {
    table: 'device_exposure',
    conceptCol: 'device_concept_id',
    columns: ['person_id', 'device_concept_id', 'device_exposure_start_date', 'device_exposure_start_datetime', 'device_exposure_end_date', 'device_exposure_end_datetime', 'device_type_concept_id', 'device_source_value', 'device_source_concept_id'],
  },
}

interface Conversion {
  factor: number
  offset: number
}

const byNumber = (a: number, b: number) => a - b

// --- Unit tables -------------------------------------------------------------

/** unit_concept_id → short label (`mg/dL`): the caller's (from the vocabulary)
 *  first, then the conversions', then the recommended units'. */
export function unitLabels(
  conversions: readonly UnitConversion[],
  recommended: readonly RecommendedUnit[],
  preset: ReadonlyMap<number, string> = new Map(),
): Map<number, string> {
  const labels = new Map(preset)
  for (const row of conversions) {
    const src = row.sourceUnitConceptId
    if (src && !labels.has(src)) {
      const label = row.sourceUnitCode || row.sourceUnitName
      if (label) labels.set(src, label)
    }
    const tgt = row.targetUnitConceptId
    if (tgt && !labels.has(tgt)) {
      const label = row.targetUnitCode || row.targetUnitName
      if (label) labels.set(tgt, label)
    }
  }
  for (const row of recommended) {
    const unit = row.recommendedUnitConceptId
    if (unit && !labels.has(unit)) {
      const label = row.recommendedUnitCode || row.recommendedUnitName
      if (label) labels.set(unit, label)
    }
  }
  return labels
}

function measurementIds(concepts: readonly SqlConcept[]): Set<number> {
  return new Set(concepts.filter((c) => c.domainId === 'Measurement').map((c) => c.conceptId))
}

/** The reference units offered for a set: its measurements' recommended units
 *  and every conversion target. */
export function availableReferenceUnits(
  concepts: readonly SqlConcept[],
  conversions: readonly UnitConversion[],
  recommended: readonly RecommendedUnit[],
): number[] {
  const ids = measurementIds(concepts)
  const units = new Set<number>()
  for (const row of recommended) if (ids.has(row.conceptId)) units.add(row.recommendedUnitConceptId)
  for (const row of conversions) if (ids.has(row.conceptId)) units.add(row.targetUnitConceptId)
  return [...units].sort(byNumber)
}

/** The candidate recommended for the most measurements of the set; ties go to
 *  the lowest unit id. */
export function defaultReferenceUnit(
  concepts: readonly SqlConcept[],
  recommended: readonly RecommendedUnit[],
  candidates: readonly number[],
): number | null {
  if (candidates.length === 0) return null
  const ids = measurementIds(concepts)
  const allowed = new Set(candidates)
  const counts = new Map<number, number>()
  for (const row of recommended) {
    if (ids.has(row.conceptId) && allowed.has(row.recommendedUnitConceptId)) {
      counts.set(row.recommendedUnitConceptId, (counts.get(row.recommendedUnitConceptId) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return candidates[0]
  let best: number | null = null
  for (const unit of [...counts.keys()].sort(byNumber)) {
    if (best === null || counts.get(unit)! > counts.get(best)!) best = unit
  }
  return best
}

function conversionsInto(concepts: readonly SqlConcept[], conversions: readonly UnitConversion[], reference: number) {
  const perConcept = new Map<number, Map<number, Conversion>>(concepts.map((c) => [c.conceptId, new Map()]))
  for (const row of conversions) {
    const map = perConcept.get(row.conceptId)
    if (!map || row.targetUnitConceptId !== reference) continue
    map.set(row.sourceUnitConceptId, { factor: row.conversionFactor, offset: row.offset || 0 })
  }
  return perConcept
}

// --- SQL ---------------------------------------------------------------------

function unitLabel(unit: number, labels: ReadonlyMap<number, string>): string {
  const label = labels.get(unit)
  return label ? `${label} (${unit})` : String(unit)
}

function conversionExpr(conv: Conversion): string {
  let expr = conv.factor === 1 ? 'value_as_number' : `value_as_number * ${conv.factor}`
  if (conv.offset > 0) expr += ` + ${conv.offset}`
  else if (conv.offset < 0) expr += ` - ${Math.abs(conv.offset)}`
  return expr
}

interface Group {
  ids: number[]
  names: string[]
  sourceIds: number[]
  map: Map<number, Conversion>
}

function conversionGroups(concepts: readonly SqlConcept[], perConcept: Map<number, Map<number, Conversion>>): Group[] {
  const bySignature = new Map<string, Group>()
  const groups: Group[] = []
  for (const concept of concepts) {
    const conversions = perConcept.get(concept.conceptId) ?? new Map<number, Conversion>()
    const sourceIds = [...conversions.keys()].sort(byNumber)
    if (sourceIds.length === 0) continue
    const signature = sourceIds.map((u) => `${u}:${conversions.get(u)!.factor}:${conversions.get(u)!.offset}`).join('|')
    let group = bySignature.get(signature)
    if (!group) {
      group = { ids: [], names: [], sourceIds, map: conversions }
      bySignature.set(signature, group)
      groups.push(group)
    }
    group.ids.push(concept.conceptId)
    group.names.push(concept.conceptName)
  }
  return groups
}

function flatCase(bySource: Map<number, Map<string, Conversion>>, reference: number, labels: ReadonlyMap<number, string>): string {
  const parts = [
    `        -- Reference unit: ${unitLabel(reference, labels)}`,
    `        WHEN unit_concept_id = ${reference} THEN value_as_number`,
  ]
  for (const source of [...bySource.keys()].sort(byNumber)) {
    const conv = bySource.get(source)!.values().next().value!
    parts.push(`        WHEN unit_concept_id = ${source} THEN ${conversionExpr(conv)} -- convert ${unitLabel(source, labels)} -> ${unitLabel(reference, labels)}`)
  }
  return `    CASE\n${parts.join('\n')}\n        ELSE value_as_number -- unknown unit, no conversion available: value kept as-is (still in its original unit)\n    END AS value_as_number`
}

function nestedCase(groups: readonly Group[], reference: number, labels: ReadonlyMap<number, string>): string {
  const parts = [
    `        -- Reference unit: ${unitLabel(reference, labels)}`,
    '        -- Conversions are concept-specific: switching per measurement_concept_id',
  ]
  for (const group of groups) {
    if (group.ids.length === 1) {
      parts.push(`        WHEN measurement_concept_id = ${group.ids[0]} THEN -- ${group.names[0]}`)
    } else {
      parts.push('        WHEN measurement_concept_id IN (')
      group.ids.forEach((id, i) => parts.push(`            ${id}${i < group.ids.length - 1 ? ',' : ''} -- ${group.names[i]}`))
      parts.push('        ) THEN')
    }
    parts.push('            CASE')
    parts.push(`                WHEN unit_concept_id = ${reference} THEN value_as_number`)
    for (const source of group.sourceIds) {
      parts.push(`                WHEN unit_concept_id = ${source} THEN ${conversionExpr(group.map.get(source)!)} -- convert ${unitLabel(source, labels)} -> ${unitLabel(reference, labels)}`)
    }
    parts.push('                ELSE value_as_number -- unknown unit, no conversion: value kept as-is')
    parts.push('            END')
  }
  parts.push('        ELSE value_as_number -- no conversion for this concept: value kept as-is')
  return `    CASE\n${parts.join('\n')}\n    END AS value_as_number`
}

function conceptCondition(ids: readonly number[]): string {
  return ids.length === 1 ? `measurement_concept_id = ${ids[0]}` : `measurement_concept_id IN (${ids.join(', ')})`
}

function unitRewrite(groups: readonly Group[], converted: readonly number[], reference: number, labels: ReadonlyMap<number, string>, ambiguous: boolean): string {
  const parts: string[] = []
  if (!ambiguous) {
    parts.push(`        WHEN unit_concept_id IN (${[reference, ...converted].join(', ')}) THEN ${reference} -- normalized to reference unit ${unitLabel(reference, labels)}`)
  } else {
    parts.push('        -- Conversions are concept-specific: relabel only the (concept, unit) pairs actually converted')
    for (const group of groups) {
      parts.push(`        WHEN ${conceptCondition(group.ids)} AND unit_concept_id IN (${[reference, ...group.sourceIds].join(', ')}) THEN ${reference}`)
    }
  }
  return `    CASE\n${parts.join('\n')}\n        ELSE unit_concept_id -- no conversion for this (concept, unit): kept as-is, value stays in its original unit\n    END AS unit_concept_id`
}

function unitFilter(groups: readonly Group[], converted: readonly number[], reference: number, hasRewrite: boolean, ambiguous: boolean, drop: boolean, labels: ReadonlyMap<number, string>): string[] {
  const prefix = drop ? '' : '-- '
  if (!hasRewrite) {
    const expected = unitLabel(reference, labels)
    return [
      drop
        ? `-- Keeping only rows already in ${expected}, the expected unit`
        : `-- Optional: uncomment to keep only rows already in ${expected}, the expected unit`,
      `${prefix}AND unit_concept_id = ${reference}`,
    ]
  }
  const lines = [drop
    ? '-- Dropping rows whose unit cannot be converted to the reference unit'
    : '-- Optional: uncomment to drop rows whose unit cannot be converted to the reference unit']
  if (!ambiguous) {
    lines.push(`${prefix}AND unit_concept_id IN (${[reference, ...converted].join(', ')})`)
  } else {
    lines.push(`${prefix}AND (unit_concept_id = ${reference}`)
    for (const group of groups) {
      lines.push(`${prefix}     OR (${conceptCondition(group.ids)} AND unit_concept_id IN (${group.sourceIds.join(', ')}))`)
    }
    lines.push(`${prefix})`)
  }
  return lines
}

function domainQuery(
  domain: string,
  concepts: readonly SqlConcept[],
  conversions: readonly UnitConversion[],
  labels: ReadonlyMap<number, string>,
  reference: number | null,
  drop: boolean,
): string[] {
  const lines = [
    '-- ------------------------------------------------------------',
    `-- Domain: ${domain} (${concepts.length} concepts)`,
    '-- ------------------------------------------------------------',
  ]
  const mapping = DOMAIN_TABLES[domain]
  if (!mapping) {
    lines.push(`-- No OMOP CDM table mapping for domain "${domain}".`)
    lines.push('-- Concepts:')
    for (const c of concepts) lines.push(`--   ${c.conceptId} -- ${c.conceptName}`)
    lines.push('')
    return lines
  }

  let valueExpr: string | null = null
  let unitExpr: string | null = null
  let converted: number[] = []
  let ambiguous = false
  let groups: Group[] = []

  if (domain === 'Measurement' && reference) {
    const perConcept = conversionsInto(concepts, conversions, reference)
    // Two conversions only count as the same when both factor and offset agree.
    const bySource = new Map<number, Map<string, Conversion>>()
    for (const concept of concepts) {
      for (const [source, conv] of perConcept.get(concept.conceptId) ?? []) {
        if (!bySource.has(source)) bySource.set(source, new Map())
        bySource.get(source)!.set(`${conv.factor}|${conv.offset}`, conv)
      }
    }
    converted = [...bySource.keys()].sort(byNumber)
    ambiguous = [...bySource.values()].some((convs) => convs.size > 1)
    groups = conversionGroups(concepts, perConcept)
    valueExpr = ambiguous ? nestedCase(groups, reference, labels) : flatCase(bySource, reference, labels)
    if (converted.length > 0) unitExpr = unitRewrite(groups, converted, reference, labels, ambiguous)
  } else if (domain === 'Measurement') {
    lines.push('-- Note: no reference unit selected — raw value_as_number returned without conversion.')
  }

  lines.push('')
  lines.push('SELECT')
  lines.push(mapping.columns.map((col) => (
    valueExpr && col === 'value_as_number' ? valueExpr
      : unitExpr && col === 'unit_concept_id' ? unitExpr
        : `    ${col}`
  )).join(',\n'))
  lines.push(`FROM ${mapping.table}`)
  lines.push(`WHERE ${mapping.conceptCol} IN (`)
  concepts.forEach((c, i) => lines.push(`${i === 0 ? '    ' : '   ,'}${c.conceptId} -- ${c.conceptName}`))
  lines.push(')')
  if (domain === 'Measurement' && reference) {
    lines.push(...unitFilter(groups, converted, reference, unitExpr !== null, ambiguous, drop, labels))
  }
  lines.push(';')
  return lines
}

export interface ConceptSetSqlOptions {
  referenceUnitId?: number | null
  dropOtherUnits?: boolean
  /** Unit labels from the vocabulary (UCUM concept codes), preferred over the
   *  dictionary's. */
  unitLabels?: ReadonlyMap<number, string>
}

export function buildConceptSetSql(
  header: SqlHeader,
  concepts: readonly SqlConcept[],
  conversions: readonly UnitConversion[],
  recommended: readonly RecommendedUnit[],
  options: ConceptSetSqlOptions = {},
): string {
  const standard = concepts.filter((c) => c.standardConcept === 'S')
  if (standard.length === 0) {
    return `-- Concept Set: ${header.name} (ID: ${header.id})\n-- ${header.permalink}\n`
      + '-- No standard resolved concepts available.\n'
      + '-- Load an OHDSI vocabulary database or ensure concept sets are resolved.\n'
  }
  const byDomain = new Map<string, SqlConcept[]>()
  for (const c of standard) {
    const domain = c.domainId || 'Unknown'
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), c])
  }
  const labels = unitLabels(conversions, recommended, options.unitLabels)
  const lines = [
    '-- ============================================================',
    `-- Concept Set: ${header.name} (ID: ${header.id}${header.version ? `, version ${header.version}` : ''})`,
    `-- ${header.permalink}`,
    `-- Generated by ${header.toolTag}`,
    `-- Date: ${header.today}`,
    '-- ============================================================',
    '',
  ]
  // Code-point order, as Python's sorted() and the original's Object.keys().sort().
  for (const domain of [...byDomain.keys()].sort()) {
    lines.push(...domainQuery(domain, byDomain.get(domain)!, conversions, labels, options.referenceUnitId ?? null, !!options.dropOtherUnits))
  }
  return lines.join('\n')
}
