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

export { CONTENT_FILE, MANIFEST, ROOT_FILE, SCRIPT_LANGUAGE, SIDECAR, manifestList, scriptLanguage } from './layout.js'
export type { LayoutKind } from './layout.js'

export { buildTabKeyMap, buildWidgetKeyMap, dashboardKey, tabKey, widgetKey } from './keys.js'
export type { TabKeyInput, WidgetKeyInput } from './keys.js'

export type { LocalizedString } from './check.js'
export { readLocalized } from './check.js'

export { serializeProject } from './serialize/project.js'
export type {
  ColumnType, CopyFile, DashboardSpec, DatasetSpec, FilterInputType, FilterSpec,
  LocalizedInput, ProjectSpec, ScriptSpec, SerializedTree, TabSpec, WidgetSpec, WriteFile,
} from './serialize/project.js'

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
