#!/usr/bin/env -S npx tsx
/**
 * `@linkr/mcp` — author Linkr content outside Linkr.
 *
 * A stdio MCP server exposing the format package as tools, so any MCP client
 * (Claude Code, OpenCode, Cursor, Codex…) can write a project tree and have it
 * validated. It contains **no format knowledge**: every tool parses its
 * arguments, calls into `@linkr/format`, and reports what came back. A tool that
 * starts building a JSON shape by hand has broken the layering — see
 * docs/planning/mcp-authoring-plan.md §2.
 *
 * The server writes FILES, not to a running Linkr instance: that is what makes
 * authoring work offline, and it produces exactly the tree shape the
 * linkr-public-content repos already use, so the normal import path reads it
 * with no special-casing.
 *
 * stdout is the JSON-RPC channel — never write to it. Diagnostics go to stderr.
 */
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import {
  MemoryTree, detectTreeKind, formatIssues, manifestList, serializeDatabase, serializeEntity, serializeProject,
  validateEntity, validateProject,
  type DatabaseSpec, type ProjectSpec, type SerializableEntityKind,
} from '@linkr/format'
import { FsTree } from '@linkr/format/node/fs-tree'
import {
  DEFAULT_GITIGNORE,
  addDashboardTab,
  addScript,
  addWidget,
  copyFiles,
  describeEntitySchema,
  describeTree,
  readTreeFile,
  renameDashboardTab,
  renameDashboardWidget,
  moveDashboardWidget,
  updateWidget,
  removeDashboardTab,
  removeDashboardWidget,
  renameColumns,
  readEntitySpec,
  updateProject,
  upsertDqCheck,
  removeDqCheck,
  upsertMappings,
  removeMappings,
  writeEntityFile,
  writeEventTable,
  formatBytes,
  writeTree,
  writeZip,
} from './tools.js'

const server = new McpServer({ name: 'linkr', version: '0.1.0' })

/** Plain-text tool result. */
const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] })

/**
 * Failure the model is meant to read and correct, as opposed to a thrown error,
 * which the protocol reports as a server fault.
 */
const failure = (body: string) => ({ isError: true, content: [{ type: 'text' as const, text: body }] })

const LOCALIZED = {
  type: 'object',
  description: 'Localized text, e.g. {"en": "Overview", "fr": "Vue d\'ensemble"}.',
  properties: { en: { type: 'string' }, fr: { type: 'string' } },
  additionalProperties: { type: 'string' },
}

server.registerTool(
  'validate_entity',
  {
    description:
      'Validate any Linkr entity tree on disk — project, SQL collection, ETL pipeline, '
      + 'schema preset, DQ rule set, data catalog, concept-mapping project or database. '
      + 'The kind is detected from the tree. Reports missing files, broken references, '
      + 'unknown columns and legacy formats. Run this after any change.',
    inputSchema: fromJsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the entity directory.' } },
      required: ['path'],
    }),
  },
  async ({ path }) => {
    const tree = new FsTree(path)
    // Every kind shares one manifest name, so the kind comes from the manifest's
    // own `type` rather than from which file is present — the caller never has to
    // say which is which. Trees predating the rename are still detected by their
    // old per-kind filename.
    const kind = detectTreeKind(tree)
    if (kind == null) {
      return failure(
        `Not a Linkr entity tree: ${path} has no ${manifestList()} at its root.`,
      )
    }

    const issues = kind === 'project' ? validateProject(tree) : validateEntity(tree, kind)
    const errors = issues.filter((i) => i.severity === 'error').length
    const warnings = issues.length - errors
    if (issues.length === 0) return text(`Valid ${kind}: no issues found.`)
    return text(`${kind}: ${errors} error(s), ${warnings} warning(s).\n\n${formatIssues(issues)}`)
  },
)

server.registerTool(
  'write_project',
  {
    description:
      'Create a complete Linkr project tree from a spec: metadata, datasets (from CSV text), '
      + 'dashboards with tabs and widgets, and IDE scripts. Validates what it wrote and reports '
      + 'any issue. Use describe_entity_schema first if unsure about a field.',
    inputSchema: fromJsonSchema<{ path: string; spec: ProjectSpec; format?: 'folder' | 'zip' }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to write the tree into. Created if absent.' },
        spec: {
          type: 'object',
          description: 'The project spec. Call describe_entity_schema("project") for the fields.',
        },
        format: {
          type: 'string',
          enum: ['folder', 'zip'],
          description:
            'folder (default) — git-friendly, what the portal and content repos consume. '
            + 'zip — what the app\'s "Import a project" dialog takes; `path` is then the .zip file.',
        },
      },
      required: ['path', 'spec'],
    }),
  },
  async ({ path, spec, format }) => {
    try {
      const files = serializeProject(spec)
      if (format === 'zip') {
        // Validate the tree before bundling: once zipped there is nothing on
        // disk to point issues at, and a ZIP is usually handed straight to a user.
        const issues = validateProject(new MemoryTree(
          Object.fromEntries(files.map((f) => [f.path, f.content])),
        ))
        if (issues.some((i) => i.severity === 'error')) {
          return failure(`Not written — the spec produces an invalid project:\n${formatIssues(issues)}`)
        }
        const count = await writeZip(path, files)
        return text(`Wrote ${count} file(s) into ${path}. Valid.`)
      }

      const written = writeTree(path, [...files, { path: '.gitignore', content: DEFAULT_GITIGNORE }])
      const issues = validateProject(new FsTree(path))
      const errors = issues.filter((i) => i.severity === 'error').length
      const summary = `Wrote ${written.length} file(s) to ${path}.`
      if (issues.length === 0) return text(`${summary} Valid.`)
      // Report rather than throw: the tree is on disk and the issues say what to fix.
      return text(`${summary}\n\n${errors} error(s):\n${formatIssues(issues)}`)
    } catch (e) {
      return failure(`Could not write the project: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'write_entity',
  {
    description:
      'Create a standalone Linkr entity tree — a SQL collection, ETL pipeline, DQ rule set, '
      + 'data catalog, concept-mapping project or database schema preset. These live in their '
      + 'own repo/folder, not inside a project. Validates what it wrote. Call '
      + 'describe_entity_schema(kind) first.',
    inputSchema: fromJsonSchema<{
      path: string
      kind: SerializableEntityKind
      spec: Record<string, unknown>
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to write into. Created if absent.' },
        kind: {
          type: 'string',
          enum: [
            'sql-collection', 'etl-pipeline', 'dq-rule-set', 'data-catalog',
            'mapping-project', 'schema-preset',
          ],
          description: 'Which entity to write.',
        },
        spec: {
          type: 'object',
          description: 'The entity spec. Call describe_entity_schema(kind) for its fields.',
        },
      },
      required: ['path', 'kind', 'spec'],
    }),
  },
  async ({ path, kind, spec }) => {
    try {
      const files = serializeEntity(kind, spec as never)
      const written = writeTree(path, files)
      const issues = validateEntity(new FsTree(path), kind)
      const errors = issues.filter((i) => i.severity === 'error').length
      const summary = `Wrote ${written.length} file(s) to ${path} (${kind}).`
      if (issues.length === 0) return text(`${summary} Valid.`)
      return text(`${summary}\n\n${errors} error(s):\n${formatIssues(issues)}`)
    } catch (e) {
      return failure(`Could not write the ${kind}: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'write_database',
  {
    description:
      'Create a database tree: _database.json + data/<table>.parquet + LFS .gitattributes. '
      + 'The Parquet files are COPIED from paths you give. '
      + 'ONLY for synthetic or public open data (MIMIC-IV demo, generated data) — never '
      + 'from a connected database or a hospital extract. The app itself never exports data; '
      + 'this is allowed because it runs outside that context.',
    inputSchema: fromJsonSchema<{ path: string; spec: DatabaseSpec }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to write into. Created if absent.' },
        spec: {
          type: 'object',
          description: 'The database spec. Call describe_entity_schema("database") for its fields.',
        },
      },
      required: ['path', 'spec'],
    }),
  },
  async ({ path, spec }) => {
    try {
      const { files, copies } = serializeDatabase(spec)
      const written = writeTree(path, files)
      const copied = copyFiles(path, copies)
      const issues = validateEntity(new FsTree(path), 'database')
      const errors = issues.filter((i) => i.severity === 'error').length
      const summary = copied.paths.length > 0
        ? `Wrote ${written.length} file(s) and copied ${copied.paths.length} table(s) `
          + `(${formatBytes(copied.bytes)}) to ${path}.`
        : `Wrote ${written.length} file(s) to ${path} (in-memory database, no data).`
      if (issues.length === 0) return text(`${summary} Valid.`)
      return text(`${summary}\n\n${errors} error(s):\n${formatIssues(issues)}`)
    } catch (e) {
      return failure(`Could not write the database: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'describe_tree',
  {
    description:
      'List what a project tree contains — datasets with their column ids, dashboards with their '
      + 'tab and widget keys, scripts. Call this before editing an existing project so you use '
      + 'real ids rather than guessing.',
    inputSchema: fromJsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the project directory.' } },
      required: ['path'],
    }),
  },
  async ({ path }) => {
    try {
      return text(describeTree(path))
    } catch (e) {
      return failure(`Could not read the tree: ${(e as Error).message}`)
    }
  },
)

server.registerTool(
  'read_file',
  {
    description:
      'Read one file of a project tree verbatim — a script, a .sql, a DDL, a dashboard JSON. '
      + 'Use this instead of opening the file yourself: ids in a Linkr tree are derived, so a '
      + 'hand-edit makes an entity re-import as a different one.',
    inputSchema: fromJsonSchema<{ path: string; file: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        file: { type: 'string', description: 'Path of the file within the tree, e.g. scripts/01_extract.sql.' },
      },
      required: ['path', 'file'],
    }),
  },
  async ({ path, file }) => {
    try {
      return text(readTreeFile(path, file))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'describe_entity_schema',
  {
    description:
      'Fields of a Linkr entity spec, with their types and an example. Authoritative — it comes '
      + 'from the code, so prefer it over any remembered shape.',
    inputSchema: fromJsonSchema<{ kind: string }>({
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Entity kind.',
          enum: [
            'project', 'dataset', 'dashboard', 'widget', 'tab', 'script',
            'sql-collection', 'etl-pipeline', 'dq-rule-set', 'data-catalog',
            'mapping-project', 'schema-preset', 'database',
          ],
        },
      },
      required: ['kind'],
    }),
  },
  async ({ kind }) => {
    const doc = describeEntitySchema(kind)
    return doc ? text(doc) : failure(`Unknown entity kind "${kind}".`)
  },
)

server.registerTool(
  'add_dashboard_tab',
  {
    description: 'Add a tab to a dashboard in an existing project tree.',
    inputSchema: fromJsonSchema<{
      path: string
      dashboard: string
      name: Record<string, string>
      parent?: string
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name, without .json.' },
        name: LOCALIZED,
        parent: { type: 'string', description: 'Parent tab key, to nest one level.' },
      },
      required: ['path', 'dashboard', 'name'],
    }),
  },
  async ({ path, dashboard, name, parent }) => {
    try {
      return text(addDashboardTab(path, dashboard, name, parent))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'add_widget',
  {
    description:
      'Add a widget to a tab in an existing project tree. Column names in the config are resolved '
      + 'to column ids automatically.',
    inputSchema: fromJsonSchema<{
      path: string
      dashboard: string
      tabKey: string
      name: Record<string, string>
      pluginId: string
      dataset?: string
      config?: Record<string, unknown>
      layout: { x: number; y: number; w: number; h: number }
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name, without .json.' },
        tabKey: { type: 'string', description: 'Tab key, from describe_tree.' },
        name: LOCALIZED,
        pluginId: { type: 'string', description: 'e.g. linkr-analysis-plot-builder.' },
        dataset: { type: 'string', description: 'Dataset file id, e.g. stays.csv.' },
        config: { type: 'object', description: 'Plugin config. Column NAMES are accepted.' },
        layout: {
          type: 'object',
          description: 'Grid placement. The grid is 48 columns wide (gridV 2).',
          properties: {
            x: { type: 'integer' }, y: { type: 'integer' },
            w: { type: 'integer' }, h: { type: 'integer' },
          },
          required: ['x', 'y', 'w', 'h'],
        },
      },
      required: ['path', 'dashboard', 'tabKey', 'name', 'pluginId', 'layout'],
    }),
  },
  async (args) => {
    try {
      return text(addWidget(args))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'update_widget',
  {
    description:
      "Change a widget's config, dataset or plugin. Config values may be column NAMES; they are "
      + 'resolved to ids. The config is MERGED, so send only what changes. Does not move the '
      + "widget's key — use rename_widget or move_widget for that.",
    inputSchema: fromJsonSchema<{
      path: string
      dashboard: string
      key: string
      config?: Record<string, unknown>
      dataset?: string
      pluginId?: string
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name without .json, e.g. overview.' },
        key: { type: 'string', description: 'Widget key, from describe_tree.' },
        config: { type: 'object', description: 'Config fields to set. Merged into the existing config.' },
        dataset: { type: 'string', description: 'Dataset file id, e.g. stays.csv.' },
        pluginId: { type: 'string', description: 'Plugin id to render with.' },
      },
      required: ['path', 'dashboard', 'key'],
    }),
  },
  async (args) => {
    try {
      return text(updateWidget(args))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'rename_widget',
  {
    description:
      "Rename a widget. Its key contains its name, so this REKEYS it and updates every filter "
      + 'scoped to it. The result lists the keys that changed.',
    inputSchema: fromJsonSchema<{
      path: string; dashboard: string; key: string; name: Record<string, string>
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name without .json, e.g. overview.' },
        key: { type: 'string', description: 'Widget key, from describe_tree.' },
        name: { type: 'object', description: 'New name, e.g. {"en": "Beds", "fr": "Lits"}.' },
      },
      required: ['path', 'dashboard', 'key', 'name'],
    }),
  },
  async ({ path, dashboard, key, name }) => {
    try {
      return text(renameDashboardWidget(path, dashboard, key, name))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'move_widget',
  {
    description:
      'Move a widget on the grid and/or to another tab. Its key contains its position, so this '
      + 'REKEYS it and updates every filter scoped to it. Omit w/h to keep its size.',
    inputSchema: fromJsonSchema<{
      path: string; dashboard: string; key: string
      tabKey?: string; x?: number; y?: number; w?: number; h?: number
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name without .json, e.g. overview.' },
        key: { type: 'string', description: 'Widget key, from describe_tree.' },
        tabKey: { type: 'string', description: 'Move to this tab. Omit to stay where it is.' },
        x: { type: 'number', description: 'Grid column (0-47).' },
        y: { type: 'number', description: 'Grid row.' },
        w: { type: 'number', description: 'Width in columns. Omit to keep.' },
        h: { type: 'number', description: 'Height in rows. Omit to keep.' },
      },
      required: ['path', 'dashboard', 'key'],
    }),
  },
  async ({ path, dashboard, key, tabKey, x, y, w, h }) => {
    try {
      return text(moveDashboardWidget(path, dashboard, key, { tabKey, x, y, w, h }))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'rename_dashboard_tab',
  {
    description:
      "Rename a tab. Its key contains its name, and its widgets' and sub-tabs' keys contain the "
      + "tab's, so this REKEYS the whole subtree and updates every filter scoped to any of it. "
      + 'The result lists the keys that changed.',
    inputSchema: fromJsonSchema<{
      path: string; dashboard: string; key: string; name: Record<string, string>
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name without .json, e.g. overview.' },
        key: { type: 'string', description: 'Tab key, from describe_tree.' },
        name: { type: 'object', description: 'New name, e.g. {"en": "Cohort", "fr": "Cohorte"}.' },
      },
      required: ['path', 'dashboard', 'key', 'name'],
    }),
  },
  async ({ path, dashboard, key, name }) => {
    try {
      return text(renameDashboardTab(path, dashboard, key, name))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'remove_widget',
  {
    description:
      'Delete a widget, and drop it from any filter scoped to it. The result names the filters '
      + 'that lost a reference.',
    inputSchema: fromJsonSchema<{ path: string; dashboard: string; key: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name without .json, e.g. overview.' },
        key: { type: 'string', description: 'Widget key, from describe_tree.' },
      },
      required: ['path', 'dashboard', 'key'],
    }),
  },
  async ({ path, dashboard, key }) => {
    try {
      return text(removeDashboardWidget(path, dashboard, key))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'remove_dashboard_tab',
  {
    description:
      'Delete a tab — WITH its sub-tabs and all their widgets, which is usually more than it '
      + 'looks. The result names everything that went. Call describe_tree first if unsure.',
    inputSchema: fromJsonSchema<{ path: string; dashboard: string; key: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dashboard: { type: 'string', description: 'Dashboard file name without .json, e.g. overview.' },
        key: { type: 'string', description: 'Tab key, from describe_tree.' },
      },
      required: ['path', 'dashboard', 'key'],
    }),
  },
  async ({ path, dashboard, key }) => {
    try {
      return text(removeDashboardTab(path, dashboard, key))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'rename_dataset_columns',
  {
    description:
      "Rename one or more columns of a dataset. A column id is derived from its name, so this "
      + 'REKEYS them and repoints every widget config and filter that pointed at the old ids, '
      + 'across all dashboards. The result lists the ids that changed. The CSV header is left '
      + 'as it is — columns[].name is what the app displays.',
    inputSchema: fromJsonSchema<{
      path: string
      dataset: string
      renames: { from: string; to: string }[]
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        dataset: { type: 'string', description: 'Dataset file id, e.g. stays.csv (or just stays).' },
        renames: {
          type: 'array',
          description: 'Columns to rename.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Current column id, from describe_tree.' },
              to: { type: 'string', description: 'New display name; the new id is derived from it.' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['path', 'dataset', 'renames'],
    }),
  },
  async ({ path, dataset, renames }) => {
    try {
      return text(renameColumns(path, dataset, renames))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'read_entity',
  {
    description:
      'Read a standalone entity tree (SQL collection, ETL pipeline, DQ rule set, data catalog, '
      + 'mapping project) back as the spec that would rewrite it. Lossless — fields the spec '
      + 'does not model come back too. Edit the spec and pass it to write_entity, or use the '
      + 'granular tools below for one record out of many.',
    inputSchema: fromJsonSchema<{ path: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the entity directory.' },
      },
      required: ['path'],
    }),
  },
  async ({ path }) => {
    try {
      return text(readEntitySpec(path))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'write_entity_file',
  {
    description:
      "Add, replace or delete one script file of a SQL collection or ETL pipeline. Pass "
      + 'content: null to delete. Keeps the other files untouched, which re-emitting the whole '
      + 'spec does not guarantee.',
    inputSchema: fromJsonSchema<{
      path: string; file: string; content?: string | null; order?: number
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the entity directory.' },
        file: { type: 'string', description: 'Path within the entity, e.g. etl/01_person.sql.' },
        content: { type: ['string', 'null'], description: 'File contents. null deletes the file.' },
        order: { type: 'number', description: 'Run order within the entity. Omit to keep or append.' },
      },
      required: ['path', 'file'],
    }),
  },
  async ({ path, file, content, order }) => {
    try {
      // `undefined` is a caller who forgot the field; `null` is a deliberate
      // delete. Coercing the first to '' would blank a file instead of saying so.
      if (content === undefined) {
        return failure('Pass `content` (the file text), or content: null to delete the file.')
      }
      return text(writeEntityFile(path, file, content, order))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'upsert_dq_check',
  {
    description:
      'Add or update one quality check in a DQ rule set, keyed by name. Only the fields you '
      + 'send change; the other checks are untouched.',
    inputSchema: fromJsonSchema<{
      path: string; name: string; sql?: string; description?: string
      category?: string; severity?: string; threshold?: number
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the entity directory.' },
        name: { type: 'string', description: 'Check name — the key it is stored under.' },
        sql: { type: 'string', description: 'The query the check runs. Required for a new check.' },
        description: { type: 'string' },
        category: { type: 'string' },
        severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        threshold: { type: 'number', description: "Failure threshold; its meaning is the check's own." },
      },
      required: ['path', 'name'],
    }),
  },
  async ({ path, ...check }) => {
    try {
      return text(upsertDqCheck(path, check as Parameters<typeof upsertDqCheck>[1]))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'remove_dq_check',
  {
    description: 'Delete one quality check from a DQ rule set, by name.',
    inputSchema: fromJsonSchema<{ path: string; name: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the entity directory.' },
        name: { type: 'string', description: 'Check name.' },
      },
      required: ['path', 'name'],
    }),
  },
  async ({ path, name }) => {
    try {
      return text(removeDqCheck(path, name))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'upsert_mappings',
  {
    description:
      'Add or update concept-mapping rows, keyed by sourceConceptCode. Rows merge field by '
      + 'field, so setting a target does not erase the source metadata beside it. A mapping '
      + 'project holds thousands of rows — send only the ones that change.',
    inputSchema: fromJsonSchema<{ path: string; rows: Record<string, unknown>[] }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the entity directory.' },
        rows: {
          type: 'array',
          description: 'Mapping rows. Each needs a sourceConceptCode.',
          items: { type: 'object' },
        },
      },
      required: ['path', 'rows'],
    }),
  },
  async ({ path, rows }) => {
    try {
      return text(upsertMappings(path, rows))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'remove_mappings',
  {
    description: 'Delete concept-mapping rows by their sourceConceptCode.',
    inputSchema: fromJsonSchema<{ path: string; codes: string[] }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the entity directory.' },
        codes: { type: 'array', items: { type: 'string' }, description: 'Source concept codes to remove.' },
      },
      required: ['path', 'codes'],
    }),
  },
  async ({ path, codes }) => {
    try {
      return text(removeMappings(path, codes))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'update_project',
  {
    description:
      "Change a project's own metadata — name, description, status, version, licence, README. "
      + 'Leaves its datasets, dashboards and scripts untouched. Send only the fields that change.',
    inputSchema: fromJsonSchema<{
      path: string
      name?: Record<string, string>
      description?: Record<string, string>
      shortDescription?: Record<string, string>
      status?: string
      version?: string
      license?: { id: string; name?: string }
      readme?: Record<string, string>
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        name: { type: 'object', description: 'Localized name, e.g. {"en": "...", "fr": "..."}.' },
        description: { type: 'object', description: 'Localized description.' },
        shortDescription: { type: 'object', description: 'Localized one-liner for the card.' },
        status: { type: 'string', description: 'e.g. active, archived.' },
        version: { type: 'string', description: 'User-facing semver.' },
        license: { type: 'object', description: 'e.g. {"id": "Apache-2.0"}.' },
        readme: { type: 'object', description: 'Localized README bodies, e.g. {"en": "# Title..."}.' },
      },
      required: ['path'],
    }),
  },
  async (args) => {
    try {
      return text(updateProject(args))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'write_event_table',
  {
    description:
      "Add, replace or delete one event table of a schema preset (Measurement, Condition, …). "
      + 'Pass fields: null to delete. Fields merge, so naming one column keeps the others. '
      + "Granular on purpose: a preset's schema.ddl is ~50 kB, and rewriting the whole spec "
      + 'would push all of it through your context to change one column.',
    inputSchema: fromJsonSchema<{
      path: string; label: string; fields?: Record<string, unknown> | null
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the schema preset directory.' },
        label: { type: 'string', description: 'Event table label, e.g. Measurement.' },
        fields: {
          type: ['object', 'null'],
          description:
            'Columns to set — table, conceptIdColumn and dateColumn are required for a new one. '
            + 'null deletes the event table.',
        },
      },
      required: ['path', 'label'],
    }),
  },
  async ({ path, label, fields }) => {
    try {
      if (fields === undefined) {
        return failure('Pass `fields` (the columns), or fields: null to delete the event table.')
      }
      return text(writeEventTable(path, label, fields))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

server.registerTool(
  'add_script',
  {
    description: 'Add an IDE script (.py/.r/.sql/.md) to an existing project tree.',
    inputSchema: fromJsonSchema<{ path: string; file: string; content: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project directory.' },
        file: { type: 'string', description: 'Path under scripts/, e.g. 01_extract.sql.' },
        content: { type: 'string', description: 'File contents.' },
      },
      required: ['path', 'file', 'content'],
    }),
  },
  async ({ path, file, content }) => {
    try {
      return text(addScript(path, file, content))
    } catch (e) {
      return failure((e as Error).message)
    }
  },
)

await server.connect(new StdioServerTransport())
