/**
 * `@linkr/format` — what a valid Linkr entity is.
 *
 * Schemas, id derivation and validation, with **no I/O and no dependencies**, so
 * the same rules serve the app (browser, including the WASM build), the MCP
 * authoring server (Node) and CI. See docs/planning/mcp-authoring-plan.md.
 */
export type { Issue, IssueCode, Severity } from './issue.js'
export { formatIssues, hasErrors, IssueBag, listHint } from './issue.js'

export type { EntityTree, ParsedFile } from './tree.js'
export { MemoryTree, filesIn, readJson } from './tree.js'

export { buildColumnIds, columnId, isLegacyColumnId, slugify } from './ids.js'

export {
  CONTENT_FILE, ENTITY_MANIFEST, ENTITY_TYPES, MANIFEST, ROOT_FILE, SCRIPT_LANGUAGE, SCRIPTS_DIR, SIDECAR,
  isEntityType, manifestCandidates, manifestList, scriptLanguage,
} from './layout.js'
export type { LayoutKind } from './layout.js'

export { buildTabKeyMap, buildWidgetKeyMap, dashboardKey, tabKey, widgetKey } from './keys.js'
export type { TabKeyInput, WidgetKeyInput } from './keys.js'

export type { LocalizedString } from './check.js'
export { readLocalized } from './check.js'

export { serializeProject, KEY_ORDER } from './serialize/project.js'
export type {
  ColumnType, CopyFile, DashboardSpec, DatasetSpec, FilterInputType, FilterScope, FilterSpec,
  LocalizedInput, Passthrough, ProjectSpec, ScriptSpec, SerializedTree, TabSpec, WidgetSpec,
  WriteFile,
} from './serialize/project.js'

export { findCsv } from './validate/datasets.js'

export { readDashboard } from './read/dashboard.js'
export type { DashboardFile } from './read/dashboard.js'

export { isReadableKind, readEntity, readProjectManifest, READABLE_KINDS } from './read/entities.js'
export type { ReadableEntityKind, ReadEntityResult } from './read/entities.js'

export {
  moveWidget, removeTab, removeWidget, renameDatasetColumns, renameTab, renameWidget,
  tabCollateral,
} from './rekey.js'
export type {
  Collateral, ColumnRename, DashboardDocument, DatasetRecord, DatasetRekey, Rekeyed,
} from './rekey.js'

export { serializeDatabase } from './serialize/database.js'
export type { DatabaseSpec, DatabaseTableSpec, SchemaProvenance } from './serialize/database.js'

export { serializeEntity } from './serialize/entities.js'
export type {
  ConceptMappingSpec, DataCatalogSpec, DqCheckSpec, DqRuleSetSpec, EntitySpecMap,
  EtlPipelineSpec, EventTableSpec, MappingProjectSpec, SchemaPresetSpec, ScriptFileSpec,
  SerializableEntityKind, SqlCollectionSpec,
} from './serialize/entities.js'

export { EVENT_TABLE_FIELD_ORDER, canonicalSchemaMapping, orderKeys } from './schema-mapping.js'

export { validateProject } from './validate/project.js'
export { detectEntityKind, detectTreeKind, validateEntity } from './validate/entities.js'
export type { EntityKind } from './validate/entities.js'
export { validateDatasets } from './validate/datasets.js'
export type { DatasetColumn, DatasetIndex, DatasetInfo } from './validate/datasets.js'
