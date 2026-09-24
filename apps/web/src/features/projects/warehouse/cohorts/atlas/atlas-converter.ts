/**
 * ATLAS/OHDSI ↔ Linkr cohort definition converter.
 *
 * Handles conversion between our internal criteria-tree format and the ATLAS
 * cohort-definition JSON format (ConceptSets, PrimaryCriteria, InclusionRules,
 * DemographicCriteriaList).
 *
 * Pure (no browser API): the MCP's import_atlas_cohort runs it too.
 *
 * Limitations — every one is reported in the import warnings, so the user (or
 * the agent) knows what the Linkr cohort does not carry over:
 *  – EndStrategy / CensoringCriteria / CollapseSettings / CensorWindow
 *  – temporal windows (StartWindow/EndWindow), RestrictVisit, observation windows
 *  – event limits (first / last event per person)
 *  – AT_LEAST / AT_MOST groups (imported as ALL), "exactly 0" occurrences
 *  – excluded or mapped concept-set items, descendant expansion
 *  – domain attributes other than the concept set and ValueAsNumber
 *  – Race / Ethnicity, eras, ObservationPeriod and other unsupported domains
 *  – visit_detail level has no ATLAS equivalent (export)
 */

import type {
  CriteriaGroupNode,
  CriteriaTreeNode,
  CriterionNode,
  Cohort,
  ConceptCriteriaConfig,
  AgeCriteriaConfig,
  SexCriteriaConfig,
  ValueFilter,
} from '@/types'

// ---------------------------------------------------------------------------
// ATLAS JSON types (subset we care about)
// ---------------------------------------------------------------------------

interface AtlasConceptItem {
  concept: {
    CONCEPT_ID: number
    CONCEPT_NAME: string
    STANDARD_CONCEPT?: string
    DOMAIN_ID?: string
    VOCABULARY_ID?: string
    CONCEPT_CLASS_ID?: string
    CONCEPT_CODE?: string
    INVALID_REASON?: string
  }
  isExcluded: boolean
  includeDescendants: boolean
  includeMapped: boolean
}

interface AtlasConceptSet {
  id: number
  name: string
  expression: { items: AtlasConceptItem[] }
}

interface AtlasNumericRange {
  Value: number
  Extent?: number
  Op: 'lt' | 'lte' | 'eq' | 'gt' | 'gte' | 'bt' | '!bt'
}

interface AtlasGenderConcept {
  CONCEPT_ID: number
  CONCEPT_NAME?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AtlasDomainCriterion = Record<string, any>

interface AtlasCorrelatedCriteria {
  Criteria: AtlasDomainCriterion
  StartWindow?: {
    Start?: { Days?: number; Coeff: number }
    End?: { Days?: number; Coeff: number }
    UseEventEnd?: boolean
  }
  EndWindow?: {
    Start?: { Days?: number; Coeff: number }
    End?: { Days?: number; Coeff: number }
    UseEventEnd?: boolean
  }
  Occurrence?: { Type: number; Count: number; IsDistinct?: boolean }
  RestrictVisit?: boolean
  IgnoreObservationPeriod?: boolean
}

interface AtlasDemographicCriteria {
  Age?: AtlasNumericRange
  Gender?: AtlasGenderConcept[]
  Race?: AtlasGenderConcept[]
  Ethnicity?: AtlasGenderConcept[]
  OccurrenceStartDate?: unknown
  OccurrenceEndDate?: unknown
}

interface AtlasCriteriaGroup {
  Type: 'ALL' | 'ANY' | 'AT_LEAST' | 'AT_MOST'
  Count?: number
  CriteriaList: AtlasCorrelatedCriteria[]
  DemographicCriteriaList: AtlasDemographicCriteria[]
  Groups: AtlasCriteriaGroup[]
}

interface AtlasInclusionRule {
  name: string
  description?: string
  expression: AtlasCriteriaGroup
}

export interface AtlasCohortDefinition {
  cdmVersionRange?: string
  ConceptSets: AtlasConceptSet[]
  PrimaryCriteria: {
    CriteriaList: AtlasDomainCriterion[]
    ObservationWindow?: { PriorDays: number; PostDays: number }
    PrimaryCriteriaLimit?: { Type: string }
  }
  AdditionalCriteria?: AtlasCriteriaGroup
  QualifiedLimit?: { Type: string }
  ExpressionLimit?: { Type: string }
  InclusionRules: AtlasInclusionRule[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  EndStrategy?: any
  CensoringCriteria?: unknown[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CollapseSettings?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CensorWindow?: any
}

// ---------------------------------------------------------------------------
// ATLAS domain key → eventTableLabel mapping
// ---------------------------------------------------------------------------

const ATLAS_DOMAIN_MAP: Record<string, string> = {
  ConditionOccurrence: 'condition_occurrence',
  DrugExposure: 'drug_exposure',
  Measurement: 'measurement',
  Observation: 'observation',
  ProcedureOccurrence: 'procedure_occurrence',
  VisitOccurrence: 'visit_occurrence',
  DeviceExposure: 'device_exposure',
  Death: 'death',
}

const LINKR_TO_ATLAS_DOMAIN: Record<string, string> = {
  condition_occurrence: 'ConditionOccurrence',
  drug_exposure: 'DrugExposure',
  measurement: 'Measurement',
  observation: 'Observation',
  procedure_occurrence: 'ProcedureOccurrence',
  visit_occurrence: 'VisitOccurrence',
  device_exposure: 'DeviceExposure',
}

// Gender concept IDs
const GENDER_MALE = 8507
const GENDER_FEMALE = 8532

// ---------------------------------------------------------------------------
// Import: ATLAS → Linkr
// ---------------------------------------------------------------------------

export interface ImportResult {
  criteriaTree: CriteriaGroupNode
  /** What the Linkr cohort does not carry over, one sentence each, deduplicated. */
  warnings: string[]
}

/** Whether a parsed JSON looks like an ATLAS cohort definition at all. */
export function isAtlasCohortDefinition(json: unknown): json is AtlasCohortDefinition {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false
  const o = json as Record<string, unknown>
  return !!o.ConceptSets || !!o.PrimaryCriteria
}

export function importAtlasCohort(json: AtlasCohortDefinition): ImportResult {
  const warnings: string[] = []
  const conceptSetMap = new Map<number, AtlasConceptSet>()
  for (const cs of json.ConceptSets ?? []) {
    conceptSetMap.set(cs.id, cs)
  }
  warnConceptSetItems(json.ConceptSets ?? [], warnings)

  const rootChildren: CriteriaTreeNode[] = []

  // --- PrimaryCriteria → concept criteria ---
  const primary = json.PrimaryCriteria?.CriteriaList ?? []
  for (const entry of primary) {
    const node = importDomainCriterion(entry, conceptSetMap, warnings)
    if (node) rootChildren.push(node)
  }
  if (primary.length > 1) {
    warnings.push(
      `ATLAS treats the ${primary.length} primary (entry event) criteria as alternatives — any one qualifies — `
      + 'but they were imported as separate criteria that must ALL match.',
    )
  }
  const window = json.PrimaryCriteria?.ObservationWindow
  if (window && (window.PriorDays || window.PostDays)) {
    warnings.push(
      `The entry event's observation window (${window.PriorDays ?? 0} days before, ${window.PostDays ?? 0} days after) was dropped.`,
    )
  }
  const limits: [string, { Type: string } | undefined][] = [
    ['PrimaryCriteriaLimit', json.PrimaryCriteria?.PrimaryCriteriaLimit],
    ['QualifiedLimit', json.QualifiedLimit],
    ['ExpressionLimit', json.ExpressionLimit],
  ]
  for (const [name, limit] of limits) {
    if (limit?.Type && limit.Type !== 'All') {
      warnings.push(`${name} "${limit.Type}" (which event to keep per person) was dropped: every matching record counts.`)
    }
  }

  // --- AdditionalCriteria ---
  if (json.AdditionalCriteria) {
    const group = importCriteriaGroup(json.AdditionalCriteria, conceptSetMap, warnings)
    if (group.children.length > 0) {
      group.label = 'Additional Criteria'
      rootChildren.push(group)
    }
  }

  // --- InclusionRules ---
  for (const rule of json.InclusionRules ?? []) {
    // AT_MOST + Count 0 → exclude
    const excludes = rule.expression.Type === 'AT_MOST' && rule.expression.Count === 0
    const group = importCriteriaGroup(rule.expression, conceptSetMap, warnings, excludes)
    group.label = rule.name || 'Inclusion Rule'
    if (excludes) group.exclude = true

    if (group.children.length > 0) {
      rootChildren.push(group)
    }
  }

  // --- Dropped features ---
  if (json.EndStrategy) warnings.push('EndStrategy is not supported and was skipped.')
  if (json.CensoringCriteria?.length) warnings.push('CensoringCriteria are not supported and were skipped.')
  if (json.CollapseSettings) warnings.push('CollapseSettings is not supported and was skipped.')
  if (json.CensorWindow?.StartDate || json.CensorWindow?.EndDate) {
    warnings.push('CensorWindow (study start/end dates) is not supported and was skipped.')
  }

  const criteriaTree: CriteriaGroupNode = {
    kind: 'group',
    id: crypto.randomUUID(),
    operator: 'AND',
    children: rootChildren,
    exclude: false,
    enabled: true,
  }

  return { criteriaTree, warnings: [...new Set(warnings)] }
}

/** Concept-set content the import cannot honour: it keeps each set's listed,
 *  non-excluded concepts, nothing more. */
function warnConceptSetItems(sets: AtlasConceptSet[], warnings: string[]): void {
  for (const cs of sets) {
    const items = cs.expression?.items ?? []
    const excluded = items.filter((i) => i.isExcluded).length
    const mapped = items.filter((i) => i.includeMapped && !i.isExcluded).length
    if (excluded) {
      warnings.push(`Concept set "${cs.name}": ${excluded} excluded concept(s) were dropped — they are not subtracted from the set.`)
    }
    if (mapped) {
      warnings.push(`Concept set "${cs.name}": includeMapped is not supported — ${mapped} concept(s) keep only their own id, not the source concepts mapped to them.`)
    }
  }
}

function importCriteriaGroup(
  group: AtlasCriteriaGroup,
  conceptSets: Map<number, AtlasConceptSet>,
  warnings: string[],
  /** An inclusion rule's AT_MOST 0 root, which the caller turns into an exclusion. */
  exclusionRoot = false,
): CriteriaGroupNode {
  // ATLAS: ALL = all children linked by AND, ANY = all children linked by OR
  const childOperator = group.Type === 'ANY' ? 'OR' : 'AND'
  const children: CriteriaTreeNode[] = []

  // Correlated criteria
  for (const cc of group.CriteriaList ?? []) {
    const node = importCorrelatedCriterion(cc, conceptSets, warnings)
    if (node) children.push(node)
  }

  // Demographics
  for (const demo of group.DemographicCriteriaList ?? []) {
    const nodes = importDemographicCriteria(demo, warnings)
    children.push(...nodes)
  }

  if ((group.Type === 'AT_LEAST' || group.Type === 'AT_MOST') && !exclusionRoot) {
    warnings.push(`A group "${group.Type === 'AT_LEAST' ? 'at least' : 'at most'} ${group.Count ?? 0} of" was imported as "all of".`)
  }
  const directChildren = children.length + (group.Groups?.length ?? 0)
  if (exclusionRoot && directChildren > 1) {
    warnings.push('An "at most 0 of" rule (none may match) with several criteria was imported as excluding patients who match ALL of them, not ANY of them.')
  }

  // Nested groups
  for (const sub of group.Groups ?? []) {
    const subGroup = importCriteriaGroup(sub, conceptSets, warnings)
    if (subGroup.children.length > 0) {
      children.push(subGroup)
    }
  }

  // Set operator on all children (how they link to previous sibling)
  for (const child of children) {
    (child as CriteriaTreeNode).operator = childOperator
  }

  return {
    kind: 'group',
    id: crypto.randomUUID(),
    operator: 'AND', // how this group links to its previous sibling
    children,
    exclude: false,
    enabled: true,
  }
}

function importDomainCriterion(
  entry: AtlasDomainCriterion,
  conceptSets: Map<number, AtlasConceptSet>,
  warnings: string[],
): CriterionNode | null {
  const domainKey = Object.keys(entry).find((k) => ATLAS_DOMAIN_MAP[k])
  if (!domainKey) {
    const keys = Object.keys(entry).join(', ')
    warnings.push(`Unsupported primary criterion type: ${keys} (dropped).`)
    return null
  }

  const domainObj = entry[domainKey]
  return buildConceptCriterion(domainKey, domainObj, conceptSets, warnings)
}

function importCorrelatedCriterion(
  cc: AtlasCorrelatedCriteria,
  conceptSets: Map<number, AtlasConceptSet>,
  warnings: string[],
): CriterionNode | null {
  const entry = cc.Criteria
  const domainKey = Object.keys(entry).find((k) => ATLAS_DOMAIN_MAP[k])
  if (!domainKey) {
    const keys = Object.keys(entry).join(', ')
    warnings.push(`Unsupported correlated criterion type: ${keys} (dropped).`)
    return null
  }

  const domainObj = entry[domainKey]
  const node = buildConceptCriterion(domainKey, domainObj, conceptSets, warnings)
  if (!node) return null

  const config = node.config as ConceptCriteriaConfig

  // Time windows relative to the index event have no equivalent in our model.
  const windowed = [cc.StartWindow, cc.EndWindow].some(
    (w) => w && (w.Start?.Days != null || w.End?.Days != null || w.UseEventEnd),
  )
  if (windowed) {
    warnings.push('Time window constraint (relative to the entry event) was ignored: the criterion applies at any time.')
  }
  if (cc.RestrictVisit) warnings.push('"Restrict to the same visit" was ignored.')
  if (cc.Occurrence?.IsDistinct) warnings.push('"Distinct" occurrence counting was ignored: every record counts.')

  if (cc.Occurrence && cc.Occurrence.Count === 0 && cc.Occurrence.Type !== 2) {
    warnings.push(
      `"${cc.Occurrence.Type === 0 ? 'exactly' : 'at most'} 0 occurrences" of ${domainKey} (i.e. none) was ignored: the criterion `
      + 'now requires at least one record. Set it to exclude to express "none".',
    )
  }

  // Extract occurrence count
  if (cc.Occurrence && cc.Occurrence.Count > 0) {
    const opMap: Record<number, '>=' | '>' | '=' | '<=' | '<'> = {
      0: '=',
      1: '<=',
      2: '>=',
    }
    config.occurrenceCount = {
      operator: opMap[cc.Occurrence.Type] ?? '>=',
      count: cc.Occurrence.Count,
    }
  }

  return node
}

function buildConceptCriterion(
  domainKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  domainObj: any,
  conceptSets: Map<number, AtlasConceptSet>,
  warnings: string[],
): CriterionNode | null {
  const eventTableLabel = ATLAS_DOMAIN_MAP[domainKey]
  if (!eventTableLabel) return null

  const ignored = Object.keys(domainObj ?? {}).filter(
    (k) => !HANDLED_ATTRIBUTES.has(k) && !isEmptyAttribute(domainObj[k]),
  )

  // Handle Death domain specially
  if (domainKey === 'Death') {
    const deathIgnored = Object.keys(domainObj ?? {}).filter((k) => !isEmptyAttribute(domainObj[k]))
    if (deathIgnored.length) {
      warnings.push(`Death criterion: ${deathIgnored.join(', ')} ignored — imported as "patient is dead".`)
    }
    return {
      kind: 'criterion',
      id: crypto.randomUUID(),
      type: 'death',
      config: { isDead: true },
      operator: 'AND',
      exclude: false,
      enabled: true,
    }
  }

  const codesetId = domainObj.CodesetId
  const cs = codesetId != null ? conceptSets.get(codesetId) : undefined

  const conceptIds: number[] = []
  const conceptNames: Record<number, string> = {}

  if (codesetId == null) {
    warnings.push(`A ${domainKey} criterion has no concept set: it was imported with no concept.`)
  } else if (!cs) {
    warnings.push(`A ${domainKey} criterion names concept set ${codesetId}, which the definition does not contain: it was imported with no concept.`)
  }
  if (ignored.length) {
    warnings.push(`${domainKey} criterion: ${ignored.join(', ')} ignored (not supported).`)
  }

  if (cs) {
    for (const item of cs.expression.items) {
      if (!item.isExcluded) {
        conceptIds.push(item.concept.CONCEPT_ID)
        if (item.concept.CONCEPT_NAME) {
          conceptNames[item.concept.CONCEPT_ID] = item.concept.CONCEPT_NAME
        }
        if (item.includeDescendants) {
          warnings.push(
            `Concept "${item.concept.CONCEPT_NAME}" (${item.concept.CONCEPT_ID}) uses includeDescendants — hierarchy expansion is not performed on import.`,
          )
        }
      }
    }
  }

  // Extract value filter (Measurement)
  let valueFilters: ValueFilter[] | undefined
  if (domainObj.ValueAsNumber) {
    const vr = domainObj.ValueAsNumber as AtlasNumericRange
    const opMap: Record<string, ValueFilter['operator']> = {
      gt: '>',
      gte: '>=',
      eq: '=',
      lt: '<',
      lte: '<=',
      bt: 'between',
    }
    if (!opMap[vr.Op]) warnings.push(`A value filter "${vr.Op}" is not supported: it was imported as "> ${vr.Value}".`)
    valueFilters = [{
      operator: opMap[vr.Op] ?? '>',
      value: vr.Value,
      value2: vr.Op === 'bt' ? vr.Extent : undefined,
    }]
  }

  // Age / Gender set on the domain criterion itself (at the event date) are not
  // carried over: the concept node alone is returned.
  const inline = [domainObj.Age ? 'Age' : null, domainObj.Gender?.length ? 'Gender' : null].filter(Boolean)
  if (inline.length) {
    warnings.push(`${inline.join(' and ')} set on a ${domainKey} criterion ${inline.length > 1 ? 'were' : 'was'} dropped: add ${inline.length > 1 ? 'them' : 'it'} as separate criteria.`)
  }

  const conceptNode: CriterionNode = {
    kind: 'criterion',
    id: crypto.randomUUID(),
    type: 'concept',
    config: {
      eventTableLabel,
      conceptIds,
      conceptNames,
      valueFilters,
    } as ConceptCriteriaConfig,
    operator: 'AND',
    exclude: false,
    enabled: true,
  }

  return conceptNode
}

/** Domain-criterion attributes the import reads (Age / Gender are reported apart). */
const HANDLED_ATTRIBUTES = new Set(['CodesetId', 'ValueAsNumber', 'Age', 'Gender'])

function isEmptyAttribute(value: unknown): boolean {
  return value == null || value === false || (Array.isArray(value) && value.length === 0)
}

function importDemographicCriteria(demo: AtlasDemographicCriteria, warnings: string[]): CriterionNode[] {
  const nodes: CriterionNode[] = []
  const ignored = Object.keys(demo).filter(
    (k) => k !== 'Age' && k !== 'Gender' && !isEmptyAttribute(demo[k as keyof AtlasDemographicCriteria]),
  )
  if (ignored.length) warnings.push(`Demographic criteria: ${ignored.join(', ')} ignored (not supported).`)

  if (demo.Age) {
    const node = importAgeRange(demo.Age)
    if (node) nodes.push(node)
    else warnings.push(`An age condition "${demo.Age.Op}" is not supported and was dropped.`)
  }

  if (demo.Gender?.length) {
    const node = importGenderList(demo.Gender)
    if (node) nodes.push(node)
  }

  return nodes
}

function importAgeRange(range: AtlasNumericRange): CriterionNode | null {
  let min: number | undefined
  let max: number | undefined

  switch (range.Op) {
    case 'gt':
    case 'gte':
      min = range.Value
      break
    case 'lt':
    case 'lte':
      max = range.Value
      break
    case 'eq':
      min = range.Value
      max = range.Value
      break
    case 'bt':
      min = range.Value
      max = range.Extent
      break
  }

  if (min == null && max == null) return null

  return {
    kind: 'criterion',
    id: crypto.randomUUID(),
    type: 'age',
    config: { ageReference: 'admission', min, max } as AgeCriteriaConfig,
    operator: 'AND',
    exclude: false,
    enabled: true,
  }
}

function importGenderList(genders: AtlasGenderConcept[]): CriterionNode | null {
  const values: string[] = genders.map((g) => String(g.CONCEPT_ID))
  if (values.length === 0) return null

  return {
    kind: 'criterion',
    id: crypto.randomUUID(),
    type: 'sex',
    config: { values } as SexCriteriaConfig,
    operator: 'AND',
    exclude: false,
    enabled: true,
  }
}

// ---------------------------------------------------------------------------
// Export: Linkr → ATLAS
// ---------------------------------------------------------------------------

export interface ExportResult {
  json: AtlasCohortDefinition
  warnings: string[]
}

export function exportToAtlas(cohort: Cohort): ExportResult {
  const warnings: string[] = []
  const conceptSets: AtlasConceptSet[] = []
  const nextCodesetId = 0

  // Map to track concept sets we've already created
  const conceptSetIdMap = new Map<string, number>()

  const primaryCriteria: AtlasDomainCriterion[] = []
  const inclusionRules: AtlasInclusionRule[] = []

  // Warning for unsupported features
  if (cohort.level === 'visit_detail') {
    warnings.push('visit_detail level has no ATLAS equivalent. Exported as patient-level.')
  }
  if (cohort.customSql) {
    warnings.push('Custom SQL override cannot be represented in ATLAS format and was skipped.')
  }

  // Walk the criteria tree
  exportGroup(
    cohort.criteriaTree,
    conceptSets,
    conceptSetIdMap,
    primaryCriteria,
    inclusionRules,
    warnings,
    { nextId: nextCodesetId },
    true,
  )

  const json: AtlasCohortDefinition = {
    cdmVersionRange: '>=5.0.0',
    ConceptSets: conceptSets,
    PrimaryCriteria: {
      CriteriaList: primaryCriteria,
      ObservationWindow: { PriorDays: 0, PostDays: 0 },
      PrimaryCriteriaLimit: { Type: 'All' },
    },
    QualifiedLimit: { Type: 'First' },
    ExpressionLimit: { Type: 'All' },
    InclusionRules: inclusionRules,
    CensoringCriteria: [],
    CollapseSettings: { CollapseType: 'ERA', EraPad: 0 },
    CensorWindow: {},
  }

  return { json, warnings }
}

function exportGroup(
  group: CriteriaGroupNode,
  conceptSets: AtlasConceptSet[],
  conceptSetIdMap: Map<string, number>,
  primaryCriteria: AtlasDomainCriterion[],
  inclusionRules: AtlasInclusionRule[],
  warnings: string[],
  counter: { nextId: number },
  isRoot: boolean,
) {
  if (!group.enabled) return

  for (const child of group.children) {
    if (!child.enabled) continue

    if (child.kind === 'criterion') {
      if (isRoot) {
        // Root-level criteria: demographics → InclusionRules, concepts → PrimaryCriteria or InclusionRules
        const exported = exportCriterion(child, conceptSets, conceptSetIdMap, warnings, counter)
        if (!exported) continue

        if (exported.type === 'demographic') {
          // Wrap demographic criteria in an inclusion rule
          inclusionRules.push({
            name: exported.label,
            expression: {
              Type: 'ALL',
              CriteriaList: [],
              DemographicCriteriaList: [exported.demographic!],
              Groups: [],
            },
          })
        } else if (exported.type === 'domain') {
          if (child.exclude) {
            // Exclusion: use AT_MOST 0
            inclusionRules.push({
              name: exported.label,
              expression: {
                Type: 'AT_MOST',
                Count: 0,
                CriteriaList: [exported.correlated!],
                DemographicCriteriaList: [],
                Groups: [],
              },
            })
          } else if (primaryCriteria.length === 0) {
            // First concept criterion → PrimaryCriteria
            primaryCriteria.push(exported.domain!)
          } else {
            // Additional concept criteria → InclusionRules
            inclusionRules.push({
              name: exported.label,
              expression: {
                Type: 'AT_LEAST',
                Count: 1,
                CriteriaList: [exported.correlated!],
                DemographicCriteriaList: [],
                Groups: [],
              },
            })
          }
        }
      } else {
        // Non-root: everything goes to the parent inclusion rule
        // This case is handled by the parent group export
      }
    } else if (child.kind === 'group') {
      // Nested group → inclusion rule
      const rule = exportGroupAsInclusionRule(child, conceptSets, conceptSetIdMap, warnings, counter)
      if (rule) inclusionRules.push(rule)
    }
  }
}

function exportGroupAsInclusionRule(
  group: CriteriaGroupNode,
  conceptSets: AtlasConceptSet[],
  conceptSetIdMap: Map<string, number>,
  warnings: string[],
  counter: { nextId: number },
): AtlasInclusionRule | null {
  if (!group.enabled) return null

  const criteriaList: AtlasCorrelatedCriteria[] = []
  const demographicList: AtlasDemographicCriteria[] = []
  const subGroups: AtlasCriteriaGroup[] = []

  for (const child of group.children) {
    if (!child.enabled) continue

    if (child.kind === 'criterion') {
      const exported = exportCriterion(child, conceptSets, conceptSetIdMap, warnings, counter)
      if (!exported) continue

      if (exported.type === 'demographic') {
        demographicList.push(exported.demographic!)
      } else if (exported.type === 'domain') {
        criteriaList.push(exported.correlated!)
      }
    } else if (child.kind === 'group') {
      const sub = exportGroupAsCriteriaGroup(child, conceptSets, conceptSetIdMap, warnings, counter)
      if (sub) subGroups.push(sub)
    }
  }

  if (criteriaList.length === 0 && demographicList.length === 0 && subGroups.length === 0) {
    return null
  }

  const type = deriveAtlasGroupType(group)

  return {
    name: group.label || 'Criteria group',
    expression: {
      Type: group.exclude ? 'AT_MOST' : type,
      Count: group.exclude ? 0 : undefined,
      CriteriaList: criteriaList,
      DemographicCriteriaList: demographicList,
      Groups: subGroups,
    },
  }
}

function exportGroupAsCriteriaGroup(
  group: CriteriaGroupNode,
  conceptSets: AtlasConceptSet[],
  conceptSetIdMap: Map<string, number>,
  warnings: string[],
  counter: { nextId: number },
): AtlasCriteriaGroup | null {
  if (!group.enabled) return null

  const criteriaList: AtlasCorrelatedCriteria[] = []
  const demographicList: AtlasDemographicCriteria[] = []
  const subGroups: AtlasCriteriaGroup[] = []

  for (const child of group.children) {
    if (!child.enabled) continue

    if (child.kind === 'criterion') {
      const exported = exportCriterion(child, conceptSets, conceptSetIdMap, warnings, counter)
      if (!exported) continue

      if (exported.type === 'demographic') {
        demographicList.push(exported.demographic!)
      } else if (exported.type === 'domain') {
        criteriaList.push(exported.correlated!)
      }
    } else if (child.kind === 'group') {
      const sub = exportGroupAsCriteriaGroup(child, conceptSets, conceptSetIdMap, warnings, counter)
      if (sub) subGroups.push(sub)
    }
  }

  if (criteriaList.length === 0 && demographicList.length === 0 && subGroups.length === 0) {
    return null
  }

  const type = deriveAtlasGroupType(group)

  return {
    Type: group.exclude ? 'AT_MOST' : type,
    Count: group.exclude ? 0 : undefined,
    CriteriaList: criteriaList,
    DemographicCriteriaList: demographicList,
    Groups: subGroups,
  }
}

/**
 * Derive the ATLAS group type (ALL/ANY) from children's operators.
 * If all children use the same operator → use that.
 * If mixed → default to ALL (ATLAS doesn't support mixed operators in a group).
 */
function deriveAtlasGroupType(group: CriteriaGroupNode): 'ALL' | 'ANY' {
  const enabledChildren = group.children.filter((c) => c.enabled)
  if (enabledChildren.length <= 1) return 'ALL'
  // Check operators of children from index 1+ (first child's operator is irrelevant)
  const ops = enabledChildren.slice(1).map((c) => c.operator)
  const allOr = ops.every((op) => op === 'OR')
  return allOr ? 'ANY' : 'ALL'
}

interface ExportedCriterion {
  type: 'demographic' | 'domain'
  label: string
  domain?: AtlasDomainCriterion
  correlated?: AtlasCorrelatedCriteria
  demographic?: AtlasDemographicCriteria
}

function exportCriterion(
  node: CriterionNode,
  conceptSets: AtlasConceptSet[],
  conceptSetIdMap: Map<string, number>,
  warnings: string[],
  counter: { nextId: number },
): ExportedCriterion | null {
  switch (node.type) {
    case 'age': {
      const config = node.config as AgeCriteriaConfig
      const demo: AtlasDemographicCriteria = {}
      if (config.min != null && config.max != null) {
        demo.Age = { Value: config.min, Extent: config.max, Op: 'bt' }
      } else if (config.min != null) {
        demo.Age = { Value: config.min, Op: 'gte' }
      } else if (config.max != null) {
        demo.Age = { Value: config.max, Op: 'lte' }
      } else {
        return null
      }
      return { type: 'demographic', label: 'Age filter', demographic: demo }
    }

    case 'sex': {
      const config = node.config as SexCriteriaConfig
      if (config.values.length === 0) return null
      const gender = config.values.map((v) => {
        const id = Number(v)
        const name = id === GENDER_MALE ? 'MALE' : id === GENDER_FEMALE ? 'FEMALE' : 'UNKNOWN'
        return { CONCEPT_ID: id, CONCEPT_NAME: name }
      })
      return {
        type: 'demographic',
        label: 'Sex filter',
        demographic: { Gender: gender },
      }
    }

    case 'death': {
      const domain: AtlasDomainCriterion = { Death: {} }
      const correlated: AtlasCorrelatedCriteria = {
        Criteria: domain,
        StartWindow: {
          Start: { Coeff: -1 },
          End: { Coeff: 1 },
          UseEventEnd: false,
        },
        Occurrence: { Type: 2, Count: 1 },
      }
      return { type: 'domain', label: 'Death', domain, correlated }
    }

    case 'concept': {
      const config = node.config as ConceptCriteriaConfig
      if (config.conceptIds.length === 0 && !config.eventTableLabel) return null

      const atlasDomain = LINKR_TO_ATLAS_DOMAIN[config.eventTableLabel]
      if (!atlasDomain) {
        warnings.push(`Event table "${config.eventTableLabel}" has no ATLAS domain equivalent.`)
        return null
      }

      // Create or reuse concept set
      const csKey = config.conceptIds.sort().join(',')
      let codesetId = conceptSetIdMap.get(csKey)
      if (codesetId == null) {
        codesetId = counter.nextId++
        conceptSetIdMap.set(csKey, codesetId)

        const items: AtlasConceptItem[] = config.conceptIds.map((id) => ({
          concept: {
            CONCEPT_ID: id,
            CONCEPT_NAME: config.conceptNames[id] ?? String(id),
            STANDARD_CONCEPT: 'S',
            DOMAIN_ID: atlasDomain === 'ConditionOccurrence' ? 'Condition' : atlasDomain === 'DrugExposure' ? 'Drug' : 'Measurement',
            VOCABULARY_ID: '',
            CONCEPT_CLASS_ID: '',
            CONCEPT_CODE: '',
            INVALID_REASON: 'V',
          },
          isExcluded: false,
          includeDescendants: false,
          includeMapped: false,
        }))

        conceptSets.push({
          id: codesetId,
          name: config.conceptNames[config.conceptIds[0]] ?? `Concept set ${codesetId}`,
          expression: { items },
        })
      }

      // Build domain criterion
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const domainObj: any = { CodesetId: codesetId }

      // Value filter (export first filter only — ATLAS supports one)
      const firstFilter = config.valueFilters?.[0]
      if (firstFilter && atlasDomain === 'Measurement') {
        const opMap: Record<string, string> = {
          '>': 'gt', '>=': 'gte', '=': 'eq', '<': 'lt', '<=': 'lte', '!=': 'gt', 'between': 'bt',
        }
        domainObj.ValueAsNumber = {
          Value: firstFilter.value,
          Op: opMap[firstFilter.operator] ?? 'gt',
          ...(firstFilter.operator === 'between' ? { Extent: firstFilter.value2 } : {}),
        }
        if (config.valueFilters && config.valueFilters.length > 1) {
          warnings.push('Only the first value filter was exported (ATLAS supports a single value filter).')
        }
      }

      const domain: AtlasDomainCriterion = { [atlasDomain]: domainObj }

      // Build correlated criterion
      const correlated: AtlasCorrelatedCriteria = {
        Criteria: domain,
        StartWindow: {
          Start: { Coeff: -1 },
          End: { Coeff: 1 },
          UseEventEnd: false,
        },
        Occurrence: {
          Type: 2,
          Count: config.occurrenceCount?.count ?? 1,
        },
      }

      return { type: 'domain', label: config.conceptNames[config.conceptIds[0]] ?? 'Concept criterion', domain, correlated }
    }

    case 'period':
    case 'duration':
    case 'care_site':
      warnings.push(`Criterion type "${node.type}" has no direct ATLAS equivalent and was skipped.`)
      return null

    default:
      return null
  }
}
