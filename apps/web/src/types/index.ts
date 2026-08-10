// Core application types
export type { SchemaMapping, SchemaPresetId, ConceptDictionary, EventTable, CustomSchemaPreset, ErdGroup } from './schema-mapping'
export type { ConceptSet, ConceptSetItem, ConceptSetTranslation, ConceptSetImportBatch, ResolvedConcept, MappingProject, MappingProjectSourceType, MappingProjectStatus, MappingProjectStats, FileColumnMapping, FileSourceData, ConceptMapping, MappingComment, MappingReview, MappingStatus, EffectiveMappingStatus, MappingEquivalence, MappingType, SourceConceptIdRange, SourceConceptIdEntry, SuggestionScore, ScoresIndex, SuggestionCategory } from './concept-mapping'
export { SUGGESTION_CATEGORIES } from './concept-mapping'
export type { DataCatalog, CatalogStatus, DimensionType, DimensionConfig, AgeGroupConfig, AdmissionDateConfig, CareSiteConfig, AnonymizationConfig, AnonymizationMode, ServiceMapping, ServiceMappingRule, CatalogConceptRow, CatalogDimensionRow, CatalogGrandTotal, CatalogResultCache, PeriodConfig, CatalogPeriodRow } from './catalog'
export { getDefaultDimensions } from './catalog'
export type { AuthorDetails, Authored, Lineaged } from './author'
import type { Authored, Lineaged } from './author'

export interface User {
  id: number
  username: string
  email?: string
  role: string
  firstName?: string
  lastName?: string
  /** Multilingual (an institution/role has an official name per language);
   *  legacy plain strings are read transparently via localized(). */
  affiliation?: LocalizedString | string
  profession?: LocalizedString | string
  orcid?: string
  isActive?: boolean
  /** True when the account can authenticate (a local password is set, or it's an
   *  external SSO/LDAP account). A password-less local account can't be enabled. */
  hasPassword?: boolean
  authProvider?: string
  lastLogin?: string
  preferences?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

/** Payload to create a user (admin). `password` is an admin-set temporary secret. */
export interface UserCreateInput {
  username: string
  password: string
  role?: string
  email?: string
  firstName?: string
  lastName?: string
  affiliation?: LocalizedString | string
  profession?: LocalizedString | string
  orcid?: string
  isActive?: boolean
}

/** A single "resource:action" capability string, e.g. "projects:write". */
export type Permission = string

/** A role: a named, ordered bundle of permissions. System roles ship by default
 *  and cannot be deleted (their label/permissions stay editable). */
export interface Role {
  id: string
  name: string
  label: LocalizedString
  /** "workspace" gates workspace-scoped entities; "global" gates the account. */
  scope: 'workspace' | 'global'
  isSystem: boolean
  permissions: Permission[]
  createdAt: string
  updatedAt: string
}

/** How an entity entered the local store. */
export type EntityOrigin = 'seed' | 'user'

/**
 * Marks an entity that may have been created by the seed loader. Absent `origin` means
 * the entity predates this field (treat as user-created): we never assume seed without
 * the explicit marker, so re-seed/removal flows can't touch user content by accident.
 */
export interface Seedable {
  origin?: EntityOrigin
}

export type ProjectStatus = 'active' | 'completed' | 'archived' | 'draft'

export type PresetBadgeColor =
  | 'red' | 'blue' | 'green' | 'violet'
  | 'amber' | 'rose' | 'cyan' | 'slate'

/** Named preset color or a hex string like '#ff6b35' */
export type BadgeColor = PresetBadgeColor | (string & {})

export interface ProjectBadge {
  id: string
  /** Multilingual; legacy plain-string values are read transparently via localized(). */
  label: LocalizedString | string
  color: BadgeColor
}

// --- Organization & Catalog Types (shared by plugins and projects) ---

/** Organization or author metadata. */
export interface OrganizationInfo {
  /** Original organization id, preserved on an inline provenance snapshot (an
   *  entity's `organization` field) so the source org stays identifiable. The
   *  first-class Organization entity narrows this to a required id. */
  id?: string
  /** Multilingual; legacy string values are read transparently via localized(). */
  name: LocalizedString | string
  /** Type of organization (e.g. hospital, university, research_institute, company, consortium). */
  type?: string
  location?: LocalizedString | string
  country?: LocalizedString | string
  website?: string
  email?: string
  /** Free-text type label when type is 'other'. Multilingual. */
  customType?: LocalizedString | string
  /** Internal organization identifier (ROR ID, institutional code, etc.). */
  referenceId?: string
  /** User-defined key-value pairs (e.g. department, FINESS code, NPI). */
  customFields?: Record<string, string>
}

/** First-class organization entity stored in its own IDB table. */
export interface Organization extends OrganizationInfo {
  id: string
  createdAt: string
  updatedAt: string
}

/** Whether an item appears in the community catalog when published via git. */
export type CatalogVisibility = 'listed' | 'unlisted'

/** Identifies the original creator of a plugin or project. */
export interface PluginOrigin {
  pluginId: string
  organizationId?: string
  repository?: string
}

/** Reference to the parent version this was forked from. */
export interface ParentRef {
  contentHash: string
  organizationId?: string
  version?: string
}

/** Human-written release notes for a specific version. */
export interface ChangelogEntry {
  version: string
  contentHash?: string
  date: string
  notes: LocalizedString
}

// --- Workspace ---

/** A workspace is an organizational container for projects, like a GitHub Organization. */
export interface Workspace extends Seedable, Authored, Lineaged {
  id: string
  name: LocalizedString
  description: LocalizedString
  organizationId?: string
  /** @deprecated Kept for backward compat after v17 migration. Use organizationId instead. */
  organization?: OrganizationInfo
  badges?: ProjectBadge[]
  readme?: LocalizedString
  gitRemoteConfig?: GitRemoteConfig
  /** Default package lists for new projects' environments, per language:
   *  { python: ["pandas", …], r: ["dplyr", …] }. Undefined = built-in defaults. */
  defaultEnvPackages?: { python?: string[]; r?: string[] }
  /** Default install options inherited by new projects' environments:
   *  { python: {indexUrl, trustedHost}, r: {repos, method} }. */
  defaultEnvOptions?: {
    python?: { indexUrl?: string; trustedHost?: string }
    r?: { repos?: string; method?: string }
  }
  createdAt: string
  updatedAt: string
}

// --- Project ---

export interface Project extends Seedable, Authored, Lineaged {
  uid: string
  /** Human-readable, URL-safe identifier (e.g. "mimic-iv-sepsis"). Set once at creation, never changes. Used as folder name in exports/git. */
  projectId?: string
  /** Workspace this project belongs to. Undefined = unassigned (legacy). */
  workspaceId?: string
  name: LocalizedString
  description: LocalizedString
  shortDescription: LocalizedString
  config: Record<string, unknown>
  /** @deprecated Use gitRemoteConfig.url. Migrated automatically by the storage layer. */
  gitUrl?: string
  /** Git repository this project is linked to. When set, workspace export emits metadata + this pointer only. */
  gitRemoteConfig?: GitRemoteConfig
  ownerId: number
  status?: ProjectStatus
  badges?: ProjectBadge[]
  todos?: TodoItem[]
  notes?: LocalizedString
  readme?: LocalizedString

  /** IDs of app-level databases linked to this project. */
  linkedDataSourceIds?: string[]
  /** Organization or author metadata. */
  organization?: OrganizationInfo
  /** Whether this project appears in the community catalog. Defaults to 'unlisted'. */
  catalogVisibility?: CatalogVisibility
  /** Absolute server path the IDE working dir binds to (server mode). Undefined = default projects/<uid>/scripts. Machine-local: never exported. */
  idePath?: string
  /** Absolute server path the code dir (packaged as scripts/ on export) binds to. Undefined = default projects/<uid>/scripts. Machine-local: never exported. */
  scriptsPath?: string
  /** Absolute server path the datasets dir binds to (server mode). Undefined = default projects/<uid>/datasets. Machine-local: never exported. */
  datasetsPath?: string
  /** User-facing semver, bumped by hand in the edit dialog (default '0.1.0'). Portable. */
  version?: string
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
  /** True when database is an in-memory DuckDB schema created from DDL (no files). */
  inMemory?: boolean
  /** Server mode: a writable DuckDB file the server owns (created from a
   *  schema's DDL), as opposed to an uploaded, read-only source file. */
  managed?: boolean
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
  unitLosMean?: number
  unitLosMedian?: number
}

/** Cached statistics for a database data source. */
export interface DatabaseStatsCache {
  dataSourceId: string
  computedAt: string
  summary: {
    patientCount: number
    visitCount: number
    visitDetailCount: number
    tableCount: number
  }
  genderDistribution: GenderDistribution
  agePyramid: AgePyramidBucket[]
  admissionTimeline: AdmissionTimelineBucket[]
  descriptiveStats: DescriptiveStats
  tableCounts: TableRowCount[]
}

export interface DataSource extends Seedable, Authored {
  id: string
  workspaceId?: string
  /** Short, URL-safe identifier used as the DuckDB schema name. Auto-generated from `name`, editable. */
  alias: string
  name: string
  description: string
  sourceType: DataSourceType
  connectionConfig: ConnectionConfig
  schemaMapping?: import('./schema-mapping').SchemaMapping
  status: DataSourceStatus
  stats?: DataSourceStats
  /** Human-readable error message when status is 'error'. */
  errorMessage?: string
  /** True when this data source is a vocabulary reference (ATHENA). Hidden from database pages. */
  isVocabularyReference?: boolean
  createdAt: string
  updatedAt: string
}

/** A file stored in IndexedDB for a data source (full binary copy). */
export interface StoredFile {
  id: string
  dataSourceId: string
  fileName: string
  fileSize: number
  /** Raw bytes. Empty for dedup-reference rows that point to another StoredFile via `dedupRef`. */
  data: ArrayBuffer
  createdAt: string
  /** SHA-256 hex of the file content. Set by the importer; used to dedupe identical bytes
   *  across multiple data sources (typical case: the same OHDSI vocabulary imported into
   *  several mapping projects). When `dedupRef` is set, this hash matches the canonical row's. */
  contentHash?: string
  /** When set, this row stores no bytes and points at another StoredFile.id whose `data`
   *  field is the canonical copy. Readers must follow the ref to fetch the actual bytes. */
  dedupRef?: string
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
  text: LocalizedString
  done: boolean
}

export interface ReadmeAttachment {
  id: string
  /** Exactly one of projectUid / workspaceId is set — a README belongs to a
   *  project or a workspace. */
  projectUid?: string
  workspaceId?: string
  fileName: string
  mimeType: string
  fileSize: number
  data: ArrayBuffer
  createdAt: string
}


// --- Wiki Types ---

export interface WikiPage extends Authored {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. Used as folder name in exports/git. */
  entityId?: string
  workspaceId: string
  parentId: string | null
  title: LocalizedString
  slug: string
  icon?: string
  content: LocalizedString
  template?: string
  owner?: string
  verified?: boolean
  verifiedAt?: string
  reviewDueAt?: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface WikiAttachment {
  id: string
  pageId: string
  workspaceId: string
  fileName: string
  mimeType: string
  fileSize: number
  data: ArrayBuffer
  createdAt: string
}

// --- Dashboard Types ---

/** @deprecated Use DashboardFilter instead */
export interface DashboardFilterColumn {
  columnId: string
  type: 'categorical' | 'numeric' | 'date'
  label?: string
}

export type DashboardFilterScope =
  | { type: 'all' }
  | { type: 'tabs'; tabIds: string[] }
  | { type: 'widgets'; widgetIds: string[] }

export interface DashboardFilter {
  id: string
  datasetFileId: string
  columnId: string
  columnName: string
  /** Optional multilingual display name shown instead of the column name (sidebar, badges,
   *  tooltips). Empty/absent falls back to `columnName`. Legacy data may hold a plain string. */
  label?: LocalizedString | string
  type: 'categorical' | 'numeric' | 'date'
  inputType: 'checkbox' | 'multi-select' | 'single-select' | 'range' | 'double-range'
  /** @deprecated Cross-dataset matching is now automatic, governed by `scope`. Retained for stored data. */
  propagate?: boolean
  scope?: DashboardFilterScope
  /** For date filters: configurable "last N <unit>" quick presets shown as badges. */
  datePresets?: DatePreset[]
}

export interface Dashboard extends Seedable, Authored {
  id: string
  projectUid: string
  name: LocalizedString
  description?: LocalizedString
  filterConfig: DashboardFilter[]
  showWidgetTitles?: boolean
  defaultDatasetFileId?: string | null
  /** Pixel gap between widgets on the grid. Defaults to DASHBOARD_GRID.margin (12). */
  widgetSpacing?: number
  /** Re-run widgets every time their tab is shown. Off by default: visited tabs stay mounted
   *  so switching back is instant and avoids re-executing R/Python. */
  reloadWidgetsOnTabSwitch?: boolean
  /** Scale row height so the whole tab fits the visible area (no vertical scroll), instead of
   *  a fixed pixel row height. On by default; lets widgets fill the screen (incl. fullscreen). */
  fitToHeight?: boolean
  /** Grid-resolution version. Absent/1 = legacy 24-col grid; 2 = current 48-col grid. Widget
   *  layouts are doubled once on load when migrating 1→2 so they keep their visual size. */
  gridV?: number
  /** User-facing semver (default '0.1.0'). Portable across export/import. */
  version?: string
  createdAt: string
  updatedAt: string
}

export interface DashboardTab {
  id: string
  dashboardId: string
  name: LocalizedString
  /** Optional multilingual description, shown as a hover tooltip on the tab. */
  description?: LocalizedString
  displayOrder: number
  /** When set, this tab is a sub-tab of the referenced root tab (one level of nesting only).
   *  A root tab with children acts as a pure container: its widgets live in the sub-tabs. */
  parentTabId?: string | null
}

export type DashboardWidgetSource =
  | {
      type: 'plugin'
      pluginId: string
      language?: 'python' | 'r'
      config: Record<string, unknown>
      /** Plugin version captured when the widget was created/last edited. Lets the
       *  dashboard flag widgets built on an older plugin version (drift detection).
       *  Absent on widgets created before this was introduced = neutral (no warning). */
      pluginVersion?: string
    }
  | { type: 'inline'; language: 'python' | 'r' | 'sql'; code: string; config: Record<string, unknown> }

export interface DashboardWidget {
  id: string
  tabId: string
  name: LocalizedString
  /** Optional multilingual description, shown via an info bubble on the widget. */
  description?: LocalizedString
  datasetFileId?: string | null
  layout: { x: number; y: number; w: number; h: number }
  source: DashboardWidgetSource
}

/** Relative-date window unit for "last N <unit>" presets. */
export type DatePresetUnit = 'day' | 'week' | 'month' | 'year'

/** A "last N <unit>" preset attached to a date filter (sliding window from today). */
export interface DatePreset {
  id: string
  count: number
  unit: DatePresetUnit
}

export type FilterValue =
  | { type: 'categorical'; selected: string[] }
  | { type: 'numeric'; min: number | null; max: number | null }
  // Two disjoint numeric ranges (OR): keeps rows in [min1,max1] or [min2,max2].
  | { type: 'numeric-double'; min1: number | null; max1: number | null; min2: number | null; max2: number | null }
  | { type: 'date'; from: string | null; to: string | null }
  // Relative sliding window: resolved to from/to at render time against today.
  | { type: 'date-relative'; count: number; unit: DatePresetUnit }

/** Multilingual string: { en: "...", fr: "..." } */
export type LocalizedString = Record<string, string>

export type Language = 'en' | 'fr'

// --- Cohort Types (re-exported from cohort.ts) ---

export type {
  CohortLevel,
  CriteriaOperator,
  CriteriaType,
  AgeCriteriaConfig,
  SexCriteriaConfig,
  DeathCriteriaConfig,
  PeriodCriteriaConfig,
  DurationCriteriaConfig,
  CareSiteCriteriaConfig,
  ValueFilter,
  ConceptCriteriaConfig,
  TextCriteriaConfig,
  DurationUnit,
  CriteriaConfig,
  CriterionNode,
  CriteriaGroupNode,
  CriteriaTreeNode,
  Cohort,
  CohortMaterialization,
  AttritionStep,
  CohortExecutionResult,
} from './cohort'

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
  /** Transient (import only): HEAD oid of the clone, used to anchor sync state
   *  right after import. Never persisted — stripped before the entity is stored. */
  syncedOid?: string
}

export type FileChangeType = 'added' | 'modified' | 'deleted'

export interface CommitFileChange {
  filepath: string
  changeType: FileChangeType
  parentBlobOid: string | null
  commitBlobOid: string | null
}

export interface RestoreResult {
  success: boolean
  restoredFiles: string[]
  commitOid?: string
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
  name: LocalizedString
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
  /** Human-friendly display name shown in headers, plugin pickers, charts.
   *  The technical `name` stays the join/query key; this is presentation only. */
  label?: string
  /** Short free-text description of the column, surfaced on hover / in the meta dialog. */
  description?: string
  /** Code → label map for categorical values (e.g. { chu_chr: 'CHU/CHR' }). Display
   *  layer only — cells keep the raw code, so filters/joins/exports are unaffected.
   *  Populated by hand or auto-filled on import (e.g. Goupile @propositions). */
  valueLabels?: Record<string, string>
}

export interface DatasetParseOptions {
  delimiter?: string
  encoding?: string
  skipRows?: number
  hasHeader?: boolean
  /** Excel sheet name (only for .xlsx/.xls files). */
  sheet?: string
  /** Per-column type override (right-click "Treat as…"), keyed by columnId. Wins
   *  over inference at parse time, so stats/filters use the chosen type. */
  columnTypes?: Record<string, DatasetColumn['type']>
  /** Per-column filter UI mode, keyed by columnId. 'list' = multi-select of
   *  distinct values; 'text' = substring search. Absent → auto (list for a
   *  low-cardinality string column, text otherwise). */
  columnFilterMode?: Record<string, 'list' | 'text'>
}

export interface DatasetFile extends Seedable, Authored {
  id: string
  projectUid: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  /** Server mode (disk-source): relative path under datasets/. Equals `id`. */
  path?: string
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

export interface DatasetRawFile {
  datasetFileId: string
  blob: Blob
  fileName: string
}

export type DatasetAnalysisType = string

export type AnalysisLanguage = 'python' | 'r'

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

// --- ETL Pipeline Types ---

export type EtlPipelineStatus = 'draft' | 'ready' | 'running' | 'success' | 'error'

export interface EtlPipeline extends Seedable, Authored, Lineaged {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId?: string
  workspaceId: string
  name: LocalizedString
  description: LocalizedString
  /** Badges for grouping/tagging (e.g. hospital center name). */
  badges?: ProjectBadge[]
  sourceDataSourceId: string
  targetDataSourceId?: string
  mappingProjectId?: string
  status: EtlPipelineStatus
  lastRunAt?: string
  lastRunDurationMs?: number
  /** Git repository this pipeline is linked to. When set, workspace export emits metadata + this pointer only. */
  gitRemoteConfig?: GitRemoteConfig
  /** Frozen provenance snapshot of the origin organization (inlined on standalone export). Not a live link. */
  organization?: OrganizationInfo
  /** User-facing semver (default '0.1.0'). Portable across export/import. */
  version?: string
  /** Per-file versioning marks — see EtlPipelineConfig. */
  config?: EtlPipelineConfig
  createdAt: string
  updatedAt: string
}

/**
 * What a pipeline overrides about which of its files git tracks.
 *
 * Data files are gitignored by default (a pipeline's mapping export holds a
 * possibly private dictionary) and code files are versioned by default; both
 * lists hold the exceptions, keyed by the file's path inside the pipeline.
 */
export interface EtlPipelineConfig {
  /** Data files to include despite the default ignore. */
  versionedDataFiles?: string[]
  /** Code files to leave out despite being versioned by default. */
  excludedFiles?: string[]
}

export interface EtlFile {
  id: string
  pipelineId: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content?: string
  /** 'markdown' is documentation only — the run filters select executable languages. */
  language?: 'sql' | 'python' | 'r' | 'markdown'
  order: number
  dataSourceId?: string  // override: run against this DB instead of pipeline default
  disabled?: boolean     // skip this file during pipeline execution
  createdAt: string
}

export interface EtlRunLog {
  id: string
  pipelineId: string
  fileId: string
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'stopped'
  startedAt?: string
  completedAt?: string
  durationMs?: number
  rowsAffected?: number
  error?: string
  output?: string
  /** Statements finished so far, while the script is running. A vocabulary
   *  script is ~20 statements and some take minutes, so "running" alone does not
   *  say whether it is progressing. */
  statementsDone?: number
  statementsTotal?: number
  /** Opening of the statement in flight, so the counter can say which one. */
  currentStatement?: string
}

/** One pipeline run, persisted: what ran against the target and how it ended. */
export interface EtlRunHistoryEntry {
  id: string
  pipelineId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'success' | 'error'
  /** Per-script logs, stored with the run rather than as separate rows: they are
   *  written wholesale on each progress tick and never queried individually. */
  scripts: EtlRunLog[]
  /** Who launched it — a shared target makes that a real question. Server mode
   *  only; the local store has no user identity to attribute. */
  createdById?: number
}

export interface EtlColumnProfile {
  tableName: string
  columnName: string
  columnType: string
  rowCount: number
  nullCount: number
  distinctCount: number
  topValues: { value: string; count: number }[]
  minValue?: string
  maxValue?: string
}

export interface EtlTableProfile {
  tableName: string
  rowCount: number
  columnCount: number
  columns: EtlColumnProfile[]
  completeness: number
}

export interface EtlSourceProfile {
  dataSourceId: string
  computedAt: string
  tables: EtlTableProfile[]
  totalTables: number
  totalColumns: number
}

// --- SQL Script Types ---

export interface SqlScriptCollection extends Authored, Lineaged {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId?: string
  workspaceId: string
  name: LocalizedString
  description: LocalizedString
  /** Badges for grouping/tagging (e.g. hospital center name). */
  badges?: ProjectBadge[]
  defaultDataSourceId?: string
  /** Git repository this collection is linked to. When set, workspace export emits metadata + this pointer only. */
  gitRemoteConfig?: GitRemoteConfig
  /** Frozen provenance snapshot of the origin organization (inlined on standalone export). Not a live link. */
  organization?: OrganizationInfo
  /** User-facing semver (default '0.1.0'). Portable across export/import. */
  version?: string
  createdAt: string
  updatedAt: string
}

export interface SqlScriptFile {
  id: string
  collectionId: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content?: string
  order: number
  dataSourceId?: string  // per-file DB override
  createdAt: string
}

// --- Data Quality Types ---

export type DqRuleSetStatus = 'draft' | 'ready' | 'running' | 'success' | 'error'

export interface DqRuleSet extends Seedable, Authored, Lineaged {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId?: string
  workspaceId: string
  name: LocalizedString
  description: LocalizedString
  /** Badges for grouping/tagging (e.g. hospital center name). */
  badges?: ProjectBadge[]
  /** Database to run checks against */
  dataSourceId: string
  status: DqRuleSetStatus
  lastRunAt?: string
  lastRunDurationMs?: number
  /** Score 0-100, percentage of passing checks */
  lastScore?: number
  /**
   * Ids of checks disabled for this rule set — custom check ids and built-in check
   * ids (their deterministic `builtin_*`/`schema_*` ids). Disabled checks stay listed
   * (greyed) but are excluded from the scan and the score.
   */
  disabledCheckIds?: string[]
  /**
   * Git repository this rule set is linked to. When set, workspace export emits only a
   * metadata marker (`data-quality/<folder>/_ruleset.json`, holding `{ ruleSet, checks }`)
   * plus a git-links.json pointer; the full rule set lives in the linked repo
   * (`rule-set.json` + `checks.json`) and is restored on clone.
   */
  gitRemoteConfig?: GitRemoteConfig
  /** Frozen provenance snapshot of the origin organization (inlined on standalone export). Not a live link. */
  organization?: OrganizationInfo
  /** User-facing semver (default '0.1.0'). Portable across export/import. */
  version?: string
  createdAt: string
  updatedAt: string
}

export interface DqCustomCheck {
  id: string
  ruleSetId: string
  name: string
  description: string
  category: 'completeness' | 'validity' | 'uniqueness' | 'consistency' | 'plausibility'
  severity: 'error' | 'warning' | 'notice'
  threshold: number
  sql: string
  order: number
  createdAt: string
  updatedAt: string
}

/** One persisted data-quality scan run. `report` holds the full DqReport so a past
 *  run can be reopened in the results table (light: counts + SQL, no row data). */
export interface DqRunHistoryEntry {
  id: string
  ruleSetId?: string
  workspaceId?: string
  dataSourceId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'success' | 'error'
  score?: number
  totalChecks: number
  passed: number
  failed: number
  errors: number
  notApplicable: number
  durationMs?: number
  /** Full scan report, kept to reopen a past run. `unknown`-typed here to avoid a
   *  type cycle with the DuckDB layer; cast to DqReport at the use site. */
  report?: unknown
}

// --- User Plugin Types ---

export interface UserPlugin extends Authored {
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId?: string
  workspaceId?: string
  files: Record<string, string>
  /** Frozen provenance snapshot of the origin organization, carried across
   *  export/import (same pattern as a project's `organization`). Inherited from
   *  the parent workspace at export time when absent. */
  organization?: OrganizationInfo
  /** Git remote for exporting/versioning the plugin (same pattern as other entities). */
  gitRemoteConfig?: GitRemoteConfig
  createdAt: string
  updatedAt: string
}
