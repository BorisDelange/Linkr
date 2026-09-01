// --- Cohort Builder Types ---

import type { Authored } from '@/types/author'
import type { DataSourceRef } from '@/types/concept-mapping'
import type { LocalizedString } from '@/types/index'

/** Extraction level for the cohort */
export type CohortLevel = 'patient' | 'visit' | 'visit_detail' | 'event'

/** Logical operator linking a node to the previous sibling */
export type CriteriaOperator = 'AND' | 'OR'

/** All possible criteria types */
export type CriteriaType =
  | 'age'
  | 'sex'
  | 'death'
  | 'period'
  | 'duration'
  | 'care_site'
  | 'concept'
  | 'text'

// --- Criteria Config Types ---

/** Age is expressed in years by default; days and months matter in neonatology. */
export type AgeUnit = 'days' | 'months' | 'years'

export interface AgeCriteriaConfig {
  /** 'current' = relative to CURRENT_DATE, 'admission' = at visit start */
  ageReference: 'current' | 'admission'
  /** Unit for min/max. Absent = years, the behaviour before this was offered. */
  ageUnit?: AgeUnit
  min?: number
  max?: number
}

export interface SexCriteriaConfig {
  values: string[]
}

export interface DeathCriteriaConfig {
  /** true = patient must be deceased, false = must be alive */
  isDead: boolean
  /** Period reference: 'visit' = during hospitalization, 'visit_detail' = during
   *  unit stay, 'any' = ever recorded, regardless of when. */
  deathReference?: 'visit' | 'visit_detail' | 'any'
}

export interface PeriodCriteriaConfig {
  startDate?: string
  endDate?: string
}

export type DurationUnit = 'hours' | 'days' | 'months'

export interface DurationCriteriaConfig {
  /** Which level to compute duration on: 'visit' = hospitalization, 'visit_detail' = unit stay */
  durationLevel: 'visit' | 'visit_detail'
  /** Unit for min/max values */
  durationUnit?: DurationUnit
  minDays?: number
  maxDays?: number
}

export interface CareSiteCriteriaConfig {
  /** Which level to filter on: 'visit' = hospitalization, 'visit_detail' = unit stay */
  careSiteLevel: 'visit' | 'visit_detail'
  /** Care site / unit values to match (names or IDs) */
  values: string[]
}

export interface ValueFilter {
  operator: '>' | '>=' | '=' | '<=' | '<' | '!=' | 'between'
  value: number
  value2?: number
}

export interface ConceptCriteriaConfig {
  /** Key in schemaMapping.eventTables */
  eventTableLabel: string
  /** Concept IDs to match */
  conceptIds: number[]
  /** Human-readable names keyed by concept_id */
  conceptNames: Record<number, string>
  /** Optional value filters (measurements) — multiple conditions ANDed together */
  valueFilters?: ValueFilter[]
  /** Minimum occurrence count */
  occurrenceCount?: {
    operator: '>=' | '>' | '=' | '<=' | '<'
    count: number
  }
}

/** How a set of terms is matched against a note field. */
export type TextMatchMode =
  /** Case-insensitive substring — the safe default. */
  | 'contains'
  /** Whole word only, so "art" stops matching "artère". */
  | 'word'
  /** Caller-supplied regular expression, passed to DuckDB's regexp_matches. */
  | 'regex'

/** One field of a note, searched with its own terms: a block can require a word
 *  in the title AND a different one in the body. */
export interface TextFieldSearch {
  /** Which note field this searches. */
  field: 'title' | 'text'
  /** Terms to look for; combined with `anyTerm` below. */
  terms: string[]
  mode?: TextMatchMode
  /** true = any term matches (OR), false = every term must (AND). Default OR. */
  anyTerm?: boolean
  /** Negate this search: the note must NOT match it. */
  exclude?: boolean
  /** How this search joins the PREVIOUS one. Ignored on the first. Default AND. */
  operator?: CriteriaOperator
}

export interface TextCriteriaConfig {
  /** Shown in the collapsed criterion bar, e.g. "anticoagulants". Falls back to
   *  the terms themselves when empty. */
  label?: string
  /** Per-field searches, joined by each one's `operator`. */
  searches?: TextFieldSearch[]
  /** Free-text note kept from the descriptive-only version of this criterion. */
  description: string
}

export type CriteriaConfig =
  | AgeCriteriaConfig
  | SexCriteriaConfig
  | DeathCriteriaConfig
  | PeriodCriteriaConfig
  | DurationCriteriaConfig
  | CareSiteCriteriaConfig
  | ConceptCriteriaConfig
  | TextCriteriaConfig

// --- Criteria Tree Nodes ---

/** A single criterion (leaf node) */
export interface CriterionNode {
  kind: 'criterion'
  id: string
  type: CriteriaType
  config: CriteriaConfig
  /** Operator linking this node to the previous sibling (ignored for first child) */
  operator: CriteriaOperator
  /** Negate this criterion (NOT) */
  exclude: boolean
  /** If false, criterion is skipped during SQL generation */
  enabled: boolean
}

/**
 * A group of criteria/sub-groups (parentheses).
 * The group itself does not define an operator for its children — each child
 * carries its own `operator` field defining how it links to the previous sibling.
 */
export interface CriteriaGroupNode {
  kind: 'group'
  id: string
  label?: string
  /** Operator linking this group to the previous sibling (ignored for first child / root) */
  operator: CriteriaOperator
  children: CriteriaTreeNode[]
  /** Negate the entire group (NOT) */
  exclude: boolean
  /** If false, group is skipped during SQL generation */
  enabled: boolean
}

/** Union type for tree nodes */
export type CriteriaTreeNode = CriterionNode | CriteriaGroupNode

// --- Cohort ---

export interface Cohort extends Authored {
  id: string
  projectUid: string
  name: LocalizedString
  description: LocalizedString
  /** Which linked database this cohort runs against. Optional: a cohort written
   *  before the field existed, or imported from elsewhere, falls back to the
   *  first usable one (see `resolveProjectSource`). */
  dataSourceId?: string
  /** Portable pointer to that database, stamped when it is picked (not derived
   *  at export time, so a server-side export carries it too). */
  dataSourceRef?: DataSourceRef
  level: CohortLevel
  /** Root criteria tree (always a group node acting as container) */
  criteriaTree: CriteriaGroupNode
  /** User-edited SQL override (null = auto-generated) */
  customSql?: string | null
  /** Cached result count from last execution */
  resultCount?: number
  /** Attrition data from last execution */
  attrition?: AttritionStep[]
  /**
   * Frozen snapshot of the cohort membership. Unlike resultCount/attrition
   * (a live preview), this materialization is the persisted set the app reads
   * (e.g. Patient data) so results stay stable even if the source data changes.
   * In fullstack mode it lives in the app DB and is shared across users.
   */
  materialization?: CohortMaterialization
  /** Schema version for migration; the current value is CURRENT_SCHEMA_VERSION
   *  in cohort-store.ts, which is what migrations stamp. */
  schemaVersion: number
  /** User-facing semver (default '0.1.0'), distinct from schemaVersion (migration counter). */
  version?: string
  createdAt: string
  updatedAt: string
}

// --- Materialization (frozen membership snapshot) ---

export interface CohortMaterialization {
  /** Level the snapshot was built at (matches the cohort level at freeze time). */
  level: CohortLevel
  /** IDs at the cohort level (patient / visit / visit_detail ids). */
  ids: string[]
  /** Distinct patient ids covered by the snapshot — always populated so
   *  patient-facing pages can filter regardless of the snapshot level. */
  patientIds: string[]
  /** Membership size (distinct level ids). */
  count: number
  /** When the snapshot was frozen (ISO timestamp). */
  materializedAt: string
}

// --- Attrition ---

export interface AttritionStep {
  /** Node ID from the criteria tree */
  nodeId: string
  label: string
  /** Count remaining after applying this step */
  count: number
  /** Count excluded by this step */
  excluded: number
}

// --- Execution Results (transient, not persisted) ---

export interface CohortExecutionResult {
  totalCount: number
  attrition: AttritionStep[]
  rows: Record<string, unknown>[]
  sql: string
  executedAt: string
  durationMs: number
}
