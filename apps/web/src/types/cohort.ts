// --- Cohort Builder Types ---

/** Extraction level for the cohort */
export type CohortLevel = 'patient' | 'visit' | 'visit_detail'

/** Logical operator combining children of a group */
export type CriteriaGroupOperator = 'AND' | 'OR'

/** All possible criteria types */
export type CriteriaType =
  | 'age'
  | 'sex'
  | 'death'
  | 'period'
  | 'duration'
  | 'visit_type'
  | 'concept'

// --- Criteria Config Types ---

export interface AgeCriteriaConfig {
  /** 'current' = relative to CURRENT_DATE, 'admission' = at visit start */
  ageReference: 'current' | 'admission'
  min?: number
  max?: number
}

export interface SexCriteriaConfig {
  values: string[]
}

export interface DeathCriteriaConfig {
  /** true = patient must be deceased, false = must be alive */
  isDead: boolean
}

export interface PeriodCriteriaConfig {
  startDate?: string
  endDate?: string
}

export interface DurationCriteriaConfig {
  minDays?: number
  maxDays?: number
}

export interface VisitTypeCriteriaConfig {
  values: string[]
}

export interface ConceptCriteriaConfig {
  /** Key in schemaMapping.eventTables */
  eventTableLabel: string
  /** Concept IDs to match */
  conceptIds: number[]
  /** Human-readable names keyed by concept_id */
  conceptNames: Record<number, string>
  /** Optional value filter (measurements) */
  valueFilter?: {
    operator: '>' | '>=' | '=' | '<=' | '<' | '!=' | 'between'
    value: number
    value2?: number
  }
  /** Minimum occurrence count */
  occurrenceCount?: {
    operator: '>=' | '>' | '=' | '<=' | '<'
    count: number
  }
  /** Time window relative to visit start */
  timeWindow?: {
    daysBefore?: number
    daysAfter?: number
  }
}

export type CriteriaConfig =
  | AgeCriteriaConfig
  | SexCriteriaConfig
  | DeathCriteriaConfig
  | PeriodCriteriaConfig
  | DurationCriteriaConfig
  | VisitTypeCriteriaConfig
  | ConceptCriteriaConfig

// --- Criteria Tree Nodes ---

/** A single criterion (leaf node) */
export interface CriterionNode {
  kind: 'criterion'
  id: string
  type: CriteriaType
  config: CriteriaConfig
  /** Negate this criterion (NOT) */
  exclude: boolean
  /** If false, criterion is skipped during SQL generation */
  enabled: boolean
}

/** A group of criteria/sub-groups combined by AND or OR */
export interface CriteriaGroupNode {
  kind: 'group'
  id: string
  label?: string
  operator: CriteriaGroupOperator
  children: CriteriaTreeNode[]
  /** Negate the entire group (NOT) */
  exclude: boolean
  /** If false, group is skipped during SQL generation */
  enabled: boolean
}

/** Union type for tree nodes */
export type CriteriaTreeNode = CriterionNode | CriteriaGroupNode

// --- Cohort ---

export interface Cohort {
  id: string
  projectUid: string
  name: string
  description: string
  level: CohortLevel
  /** Root criteria tree (always a group node) */
  criteriaTree: CriteriaGroupNode
  /** User-edited SQL override (null = auto-generated) */
  customSql?: string | null
  /** Cached result count from last execution */
  resultCount?: number
  /** Attrition data from last execution */
  attrition?: AttritionStep[]
  /** Schema version for migration (current = 2) */
  schemaVersion: number
  createdAt: string
  updatedAt: string
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

// --- Legacy types (for migration) ---

/** @deprecated v1 flat criteria — used only for migration */
export interface LegacyCohortCriteria {
  id: string
  type: 'age' | 'sex' | 'period' | 'duration' | 'concept'
  config: Record<string, unknown>
  exclude: boolean
}
