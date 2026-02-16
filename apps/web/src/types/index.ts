// Core application types
export type { SchemaMapping, SchemaPresetId, ConceptDictionary, EventTable, CustomSchemaPreset } from './schema-mapping'

export interface User {
  id: number
  username: string
  email?: string
  role: string
  preferences: Record<string, unknown>
}

export type ProjectStatus = 'active' | 'completed' | 'archived' | 'draft'

export type PresetBadgeColor =
  | 'red' | 'blue' | 'green' | 'violet'
  | 'amber' | 'rose' | 'cyan' | 'slate'

/** Named preset color or a hex string like '#ff6b35' */
export type BadgeColor = PresetBadgeColor | (string & {})

export interface ProjectBadge {
  id: string
  label: string
  color: BadgeColor
}

export interface Project {
  uid: string
  name: LocalizedString
  description: LocalizedString
  shortDescription: LocalizedString
  config: Record<string, unknown>
  gitUrl?: string
  ownerId: number
  status?: ProjectStatus
  badges?: ProjectBadge[]
  todos?: TodoItem[]
  notes?: string
  readme?: string
  readmeHistory?: ReadmeSnapshot[]
  /** IDs of app-level databases linked to this project. */
  linkedDataSourceIds?: string[]
  createdAt: string
  updatedAt: string
}

// --- Data Source Types ---

export type DataSourceType = 'database' | 'fhir'
export type DatabaseEngine = 'duckdb' | 'postgresql' | 'sqlite' | 'mysql' | 'sqlserver' | 'oracle'
export type DataSourceStatus = 'connected' | 'disconnected' | 'error' | 'configuring'

export interface DatabaseConnectionConfig {
  engine: DatabaseEngine
  fileId?: string
  fileIds?: string[]
  fileNames?: string[]
  /** True when files are referenced via File System Access API handles (no binary copy). */
  useFileHandles?: boolean
  host?: string
  port?: number
  database?: string
  schema?: string
  username?: string
  password?: string
}

export interface FhirConnectionConfig {
  baseUrl: string
  authType?: 'none' | 'basic' | 'bearer' | 'oauth2'
  token?: string
}

export type ConnectionConfig =
  | DatabaseConnectionConfig
  | FhirConnectionConfig

export interface DataSourceStats {
  patientCount?: number
  visitCount?: number
  tableCount?: number
}

/** Age pyramid bucket for OMOP demographics. */
export interface AgePyramidBucket {
  ageGroup: string
  male: number
  female: number
}

/** Per-table row count. */
export interface TableRowCount {
  tableName: string
  rowCount: number
}

/** Monthly admission count for timeline chart. */
export interface AdmissionTimelineBucket {
  month: string
  count: number
}

/** Gender distribution counts. */
export interface GenderDistribution {
  male: number
  female: number
  other: number
}

/** Descriptive statistics for a database data source. */
export interface DescriptiveStats {
  ageMean?: number
  ageMedian?: number
  ageMin?: number
  ageMax?: number
  ageQ1?: number
  ageQ3?: number
  admissionDateMin?: string
  admissionDateMax?: string
  dischargeDateMin?: string
  dischargeDateMax?: string
  losMedian?: number
  losMean?: number
  visitsPerPatientMean?: number
  visitsPerPatientMedian?: number
  visitsPerPatientMin?: number
  visitsPerPatientMax?: number
}

/** Cached statistics for a database data source. */
export interface DatabaseStatsCache {
  dataSourceId: string
  computedAt: string
  summary: {
    patientCount: number
    visitCount: number
    tableCount: number
  }
  genderDistribution: GenderDistribution
  agePyramid: AgePyramidBucket[]
  admissionTimeline: AdmissionTimelineBucket[]
  descriptiveStats: DescriptiveStats
  tableCounts: TableRowCount[]
}

export interface DataSource {
  id: string
  name: string
  description: string
  sourceType: DataSourceType
  connectionConfig: ConnectionConfig
  schemaMapping?: import('./schema-mapping').SchemaMapping
  status: DataSourceStatus
  stats?: DataSourceStats
  /** Human-readable error message when status is 'error'. */
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

/** A file stored in IndexedDB for a data source (full binary copy). */
export interface StoredFile {
  id: string
  dataSourceId: string
  fileName: string
  fileSize: number
  data: ArrayBuffer
  createdAt: string
}

/** A lightweight file reference using File System Access API (no binary copy). */
export interface StoredFileHandle {
  id: string
  dataSourceId: string
  fileName: string
  fileSize: number
  handle: FileSystemFileHandle
  createdAt: string
}

export interface TodoItem {
  id: string
  text: string
  done: boolean
}

export interface ReadmeSnapshot {
  id: string
  content: string
  savedAt: string
}

export interface ReadmeAttachment {
  id: string
  projectUid: string
  fileName: string
  mimeType: string
  fileSize: number
  data: ArrayBuffer
  createdAt: string
}

export interface Widget {
  id: string
  tabId: string
  pluginId: number
  name: string
  layout: GridLayout
  config: Record<string, unknown>
}

export interface GridLayout {
  x: number
  y: number
  w: number
  h: number
}

export interface Tab {
  id: string
  projectUid: string
  name: string
  displayOrder: number
}

/** Multilingual string: { en: "...", fr: "..." } */
export type LocalizedString = Record<string, string>

export type Language = 'en' | 'fr'

export type AppMode = 'full' | 'dashboard' | 'viewer' | 'static'

// --- Cohort Types ---

export type CohortLevel = 'patient' | 'visit'

export type CriteriaType = 'age' | 'sex' | 'period' | 'duration' | 'concept'

export interface AgeCriteriaConfig {
  min?: number
  max?: number
}

export interface SexCriteriaConfig {
  values: string[]
}

export interface PeriodCriteriaConfig {
  startDate?: string
  endDate?: string
}

export interface DurationCriteriaConfig {
  minDays?: number
  maxDays?: number
}

export interface ConceptCriteriaConfig {
  domain: string
  conceptSetId: string
  valueFilter?: { operator: string; value: number; unitConceptId?: number }
  occurrenceCount?: { operator: string; count: number }
  timeWindow?: { daysBefore?: number; daysAfter?: number }
}

export type CriteriaConfig =
  | AgeCriteriaConfig
  | SexCriteriaConfig
  | PeriodCriteriaConfig
  | DurationCriteriaConfig
  | ConceptCriteriaConfig

export interface CohortCriteria {
  id: string
  type: CriteriaType
  config: CriteriaConfig
  exclude: boolean
}

export interface Cohort {
  id: string
  projectUid: string
  name: string
  description: string
  level: CohortLevel
  criteria: CohortCriteria[]
  resultCount?: number
  createdAt: string
  updatedAt: string
}

// --- IDE Connection Types ---

export type IdeConnectionSource = 'warehouse' | 'custom'

export interface IdeConnection {
  id: string
  projectUid: string
  name: string
  source: IdeConnectionSource
  /** When source='warehouse', references the DataSource id. */
  dataSourceId?: string
  connectionConfig: DatabaseConnectionConfig
  status: DataSourceStatus
  errorMessage?: string
  createdAt: string
}

// --- IDE File Types ---

/** A code file or folder stored in IndexedDB for the IDE. */
export interface IdeFile {
  id: string
  projectUid: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content?: string
  language?: string
  createdAt: string
}

// --- Versioning Types ---

export interface GitCommit {
  oid: string
  message: string
  author: { name: string; email: string; timestamp: number }
  parents: string[]
}

export interface GitRemoteConfig {
  url: string
  branch: string
  authToken?: string
}

// --- Pipeline Types ---

export type PipelineNodeType = 'database' | 'cohort' | 'scripts' | 'dataset' | 'dashboard' | 'group'

export type PipelineNodeStatus = 'idle' | 'running' | 'success' | 'error' | 'stale'

export interface PipelineScript {
  id: string
  /** Relative file path within the project (e.g. "scripts/clean_data.sql") */
  filePath: string
  displayOrder: number
}

export interface PipelineNodeData {
  [key: string]: unknown
  label: string
  type: PipelineNodeType
  /** database node — links to a DataSource id */
  dataSourceId?: string
  /** cohort node — links to a Cohort id */
  cohortId?: string
  /** scripts node — ordered list of file references */
  scripts?: PipelineScript[]
  /** dataset node — output dataset name */
  datasetName?: string
  /** dashboard node — links to a dashboard id */
  dashboardId?: string
  status: PipelineNodeStatus
  rowCount?: number
  columnCount?: number
  error?: string
}

export interface PipelineNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: PipelineNodeData
  /** Parent group node id (child nodes move with their parent) */
  parentId?: string
  /** Explicit width (for group nodes) */
  width?: number
  /** Explicit height (for group nodes) */
  height?: number
}

export interface PipelineEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface Pipeline {
  id: string
  projectUid: string
  name: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  createdAt: string
  updatedAt: string
}

// --- Dataset Types ---

export interface DatasetColumn {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'unknown'
  order: number
}

export interface DatasetParseOptions {
  delimiter?: string
  encoding?: string
  skipRows?: number
  hasHeader?: boolean
}

export interface DatasetFile {
  id: string
  projectUid: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  columns?: DatasetColumn[]
  rowCount?: number
  parseOptions?: DatasetParseOptions
  createdAt: string
  updatedAt: string
}

export interface DatasetData {
  datasetFileId: string
  rows: Record<string, unknown>[]
}

export type DatasetAnalysisType = string

export type AnalysisLanguage = 'python' | 'r' | 'js-widget'

export interface DatasetAnalysis {
  id: string
  datasetFileId: string
  name: string
  type: DatasetAnalysisType
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ColumnStats {
  columnName: string
  columnType: string
  count: number
  nullCount: number
  uniqueCount?: number
  min?: number | string
  max?: number | string
  mean?: number
  median?: number
  std?: number
  distribution?: { bucket: string; count: number }[]
}
